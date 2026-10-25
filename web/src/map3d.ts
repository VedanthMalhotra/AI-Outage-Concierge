/* =============================================================================
 * 3D map (deck.gl standalone) — replaces the old flat Leaflet map.
 *
 * On load the map shows a pitched, extruded HexagonLayer built from the
 * aggregated damage counts (data.heat.cells): taller + redder hexagons mean
 * more storm-damage reports in that ~1 km cell. This is the "3D heatmap" hero
 * view. When a premise id is entered the camera flies/zooms down to that home
 * (FlyToInterpolator), the hexbins fade back, and the home's pin + power path
 * are revealed.
 *
 * Everything the old Leaflet code drew is reproduced here with deck.gl layers:
 *   - satellite basemap     -> TileLayer + BitmapLayer (Esri World Imagery)
 *   - circuit outline       -> GeoJsonLayer
 *   - damage heat           -> HexagonLayer (extruded) / fades out when zoomed
 *   - the home's own pin     -> ScatterplotLayer + TextLayer
 *   - the power path graphic -> PathLayer + ScatterplotLayer + TextLayer
 *
 * main.ts talks to this module through a small, stable surface so the storm
 * timeline, risk, restoration, chat, etc. are untouched.
 * ========================================================================== */

import { Deck, FlyToInterpolator, type Color, type PickingInfo } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { HeatmapLayer, HexagonLayer } from "@deck.gl/aggregation-layers";
import type { Band, DamageHeat, PowerPath, PowerPathLink } from "./types";

/* ---- camera framing --------------------------------------------------- */
const OVERVIEW_PITCH = 50; // tilt that shows off the extruded hexagons
const PREMISE_ZOOM = 16.5; // close-up zoom when a premise is selected

/* ---- palette (matches the risk badge bands in main.ts) ---------------- */
const BAND_COLOR: Record<Band, Color> = {
  Low: [34, 197, 94],
  Moderate: [250, 204, 21],
  High: [249, 115, 22],
  "Very High": [239, 68, 68],
};
const PATH_NEUTRAL: Color = [156, 163, 175];

/** Build an RGBA Color from an RGB Color + alpha (typed so TS stays happy). */
function rgba(c: Color, a: number): Color {
  return [c[0], c[1], c[2], a] as unknown as Color;
}

/* HexagonLayer colour ramp (pale yellow -> deep red), same feel as before. */
const HEX_COLORS: Color[] = [
  [254, 249, 195],
  [253, 224, 71],
  [250, 204, 21],
  [249, 115, 22],
  [239, 68, 68],
  [185, 28, 28],
];

type PinState = "normal" | "out" | "restored";
const PIN_COLOR: Record<PinState, Color> = {
  normal: [37, 99, 235],
  out: [234, 179, 8],
  restored: [34, 197, 94],
};

interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
  transitionDuration?: number;
  transitionInterpolator?: FlyToInterpolator;
}

/* module state */
let deck: Deck | null = null;
let heat: DamageHeat | null = null;
let circuit: GeoJSON.GeoJsonObject | null = null;
let powerPath: PowerPath | null = null;
let home: { lat: number; lon: number; label: string; service: string } | null = null;

let heatVisible = true; // storm timeline toggles this
let flatHeat = false; // true once a premise is picked: flat 2D heatmap (pitch 0)
let pinState: PinState = "normal";
let circuitPhaseColor: Color = [255, 90, 82];

let viewState: ViewState = {
  longitude: 0,
  latitude: 0,
  zoom: 13,
  pitch: OVERVIEW_PITCH,
  bearing: 0,
};

/* =============================================================================
 * Basemap: Esri World Imagery (keyless) as a deck.gl raster TileLayer, with
 * transport + place-name reference overlays, mirroring the old Leaflet stack.
 * ========================================================================== */
function basemapLayers() {
  const make = (id: string, url: string, opacity = 1) =>
    new TileLayer({
      id,
      data: url,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      opacity,
      renderSubLayers: (props) => {
        const { boundingBox } = props.tile;
        return new BitmapLayer(props, {
          data: undefined,
          image: props.data,
          bounds: [
            boundingBox[0][0],
            boundingBox[0][1],
            boundingBox[1][0],
            boundingBox[1][1],
          ],
        });
      },
    });

  return [
    make(
      "basemap-imagery",
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
    ),
    make(
      "basemap-transport",
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      0.9
    ),
    make(
      "basemap-labels",
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      0.9
    ),
  ];
}

/* =============================================================================
 * Damage heat as extruded hexagons.
 *
 * One weighted point per cell (not one-per-report): the cell's `count` drives
 * both colour and height directly. Height uses a sqrt mapping so a handful of
 * very busy cells don't tower over everything, and a noise floor is subtracted
 * so low-count cells sit nearly flat instead of covering the map in thin spikes.
 * The layer flattens to a 2D heatmap once a premise is picked.
 * ========================================================================== */
interface HeatPoint {
  position: [number, number];
  weight: number; // raw report count
}

/* fewest reports a cell needs before it gets a 3D bar at all */
const MIN_REPORTS_FOR_BAR = 3;

/* One weighted point per cell — used by the extruded hexagons. */
function hexData(): HeatPoint[] {
  if (!heat) return [];
  // 3D view: drop sparse cells entirely so no bar is drawn for them.
  return heat.cells
    .filter((c) => c.count >= MIN_REPORTS_FOR_BAR)
    .map((c) => ({ position: [c.lon, c.lat] as [number, number], weight: c.count }));
}

/* sqrt-shaped height so big cells don't spike away. Cells below the bar
 * threshold are already filtered out of the 3D view, so they never appear. */
function heatHeight(count: number): number {
  const base = MIN_REPORTS_FOR_BAR - 1; // start height just under the threshold
  return Math.sqrt(Math.max(0, count - base));
}

/* ---- the extruded 3D hexagons (overview mode) ---- */
function hexLayer() {
  return new HexagonLayer<HeatPoint>({
    id: "damage-hex",
    data: hexData(),
    getPosition: (d) => d.position,
    getColorWeight: (d) => d.weight,
    colorAggregation: "SUM",
    getElevationWeight: (d) => heatHeight(d.weight),
    elevationAggregation: "SUM",
    radius: 460,
    elevationScale: 10,
    extruded: true,
    pickable: true,
    colorRange: HEX_COLORS as unknown as Color[],
    upperPercentile: 98, // clip the busiest few so one outlier can't own the ramp
    coverage: 0.9,
    opacity: 0.85,
    material: {
      ambient: 0.64,
      diffuse: 0.6,
      shininess: 32,
      specularColor: [60, 64, 70],
    },
    transitions: { elevationScale: 600 },
  });
}

/* ---- the smooth 2D density gradient (premise mode) ----
 * Reproduces the original Leaflet heatmap exactly: intensity is sqrt-normalised
 * against the busiest cell (so a few hot cells don't wash everything out), and
 * each cell is exploded into several jittered sub-points over its ~1 km footprint
 * so neighbouring kernels blend into one continuous field rather than discrete
 * blobs. The gradient stops below match the old L.heatLayer gradient. */
function gradientData(): HeatPoint[] {
  if (!heat) return [];
  const maxCount = Math.max(...heat.cells.map((c) => c.count), 1);
  const CELL = heat.cell_size_deg || 0.01; // ~1 km cell
  const pts: HeatPoint[] = [];
  for (const c of heat.cells) {
    const norm = Math.sqrt(c.count / maxCount); // 0..1
    // Many sub-points scattered across (and slightly beyond) the cell so
    // neighbouring cells overlap into one continuous field instead of isolated
    // circles. Scatter radius is ~0.9x the cell so adjacent cells bleed together.
    const n = Math.max(8, Math.round(10 + norm * 30)); // 8..40 sub-points
    for (let i = 0; i < n; i++) {
      const jLat = (Math.random() - 0.5) * CELL * 1.8;
      const jLon = (Math.random() - 0.5) * CELL * 1.8;
      pts.push({ position: [c.lon + jLon, c.lat + jLat], weight: norm });
    }
  }
  return pts;
}

<<<<<<< Updated upstream
/* All-red gradient: light red at the faint edges -> deep red at the core. No
 * orange or yellow. deck.gl spaces these six evenly across 0..1. */
const GRADIENT_COLORS: Color[] = [
  [254, 224, 224], // very light red (faint edges)
  [252, 165, 165],
  [248, 113, 113],
  [239, 68, 68],
  [185, 28, 28],
  [127, 15, 15], // deep red core
=======
/* Matches the old L.heatLayer gradient stops (pale yellow -> deep red). deck.gl
 * spaces colorRange entries evenly, so these six map onto 0, 0.2, 0.4, 0.6,
 * 0.8, 1.0 — close to the original 0 / .25 / .45 / .65 / .85 / 1 stops. */
const GRADIENT_COLORS: Color[] = [
  [254, 178, 76], // warm orange (faint edges read red/orange, not white)
  [253, 141, 60],
  [252, 78, 42],
  [227, 26, 28],
  [189, 0, 38],
  [128, 0, 24], // deep red core
>>>>>>> Stashed changes
];

function gradientLayer() {
  return new HeatmapLayer<HeatPoint>({
    id: "damage-gradient",
    data: gradientData(),
    getPosition: (d) => d.position,
    getWeight: (d) => d.weight,
    // large kernels so points merge into one continuous field, not circles
    radiusPixels: 110,
    intensity: 1.4,
    threshold: 0.06, // trim the palest fringe so edges stay red, not washed out
    aggregation: "SUM",
    colorRange: GRADIENT_COLORS as unknown as Color[],
    opacity: 0.8,
  });
}

function heatLayer() {
  if (!heat || !heatVisible) return null;
  // overview -> extruded 3D hexagons; premise selected -> smooth 2D gradient.
  return flatHeat ? gradientLayer() : hexLayer();
}

/* =============================================================================
 * Circuit outline.
 * ========================================================================== */
function circuitLayer() {
  if (!circuit) return null;
  return new GeoJsonLayer({
    id: "circuit",
    data: circuit as unknown as GeoJSON.Feature,
    stroked: true,
    filled: true,
    getLineColor: rgba(circuitPhaseColor, 220),
    getFillColor: rgba(circuitPhaseColor, 28),
    getLineWidth: 3,
    lineWidthUnits: "pixels",
    updateTriggers: {
      getLineColor: circuitPhaseColor,
      getFillColor: circuitPhaseColor,
    },
  });
}

/* =============================================================================
 * The home pin (the only customer point ever shown).
 * ========================================================================== */
function pinLayers() {
  if (!home) return [];
  const color = PIN_COLOR[pinState];
  const pos: [number, number] = [home.lon, home.lat];
  return [
    new ScatterplotLayer({
      id: "home-pin-halo",
      data: [{ position: pos }],
      getPosition: (d: { position: [number, number] }) => d.position,
      getRadius: 10,
      radiusUnits: "pixels",
      getFillColor: rgba(color, 70),
      stroked: false,
    }),
    new ScatterplotLayer({
      id: "home-pin",
      data: [{ position: pos }],
      getPosition: (d: { position: [number, number] }) => d.position,
      getRadius: 6,
      radiusUnits: "pixels",
      getFillColor: color,
      stroked: true,
      getLineColor: [255, 255, 255],
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      pickable: true,
    }),
    new TextLayer({
      id: "home-pin-label",
      data: [{ position: pos, text: "Your home" }],
      getPosition: (d: { position: [number, number] }) => d.position,
      getText: (d: { text: string }) => d.text,
      getSize: 13,
      getColor: [255, 255, 255],
      getPixelOffset: [0, -18],
      fontWeight: 700,
      background: true,
      getBackgroundColor: [11, 19, 36, 210],
      backgroundPadding: [5, 3],
    }),
  ];
}

/* =============================================================================
 * Power path — the ordered equipment chain feeding the selected home.
 * ========================================================================== */
function bandFromProb(p: number | null | undefined): Band | null {
  if (p == null || Number.isNaN(p)) return null;
  if (p < 0.15) return "Low";
  if (p < 0.4) return "Moderate";
  if (p < 0.7) return "High";
  return "Very High";
}
function linkColor(link: PowerPathLink): Color {
  const band = link.band || bandFromProb(link.p_damage);
  return band ? BAND_COLOR[band] : PATH_NEUTRAL;
}
function linkGlyph(deviceType: string): string {
  const t = deviceType.toLowerCase();
  if (t.includes("transformer")) return "T";
  if (t.includes("fuse")) return "F";
  if (t.includes("recloser")) return "R";
  if (t.includes("sectionalizer")) return "S";
  if (t.includes("breaker")) return "B";
  if (t.includes("substation")) return "H";
  if (t.includes("switch")) return "W";
  return "•";
}

function powerPathLayers() {
  const pp = powerPath;
  if (!pp || !home) return [];
  if (pp.premise_id !== (currentPremiseId ?? pp.premise_id)) return [];

  const coordLinks = pp.links.filter(
    (l): l is PowerPathLink & { lat: number; lon: number } =>
      l.lat != null && l.lon != null
  );
  if (coordLinks.length === 0) return [];

  const linePts: [number, number][] = [
    [home.lon, home.lat],
    ...coordLinks.map((l) => [l.lon, l.lat] as [number, number]),
  ];

  const weakest = pp.weakest_link_step;
  const nodes = coordLinks.map((l) => ({
    position: [l.lon, l.lat] as [number, number],
    color: linkColor(l),
    glyph: linkGlyph(l.device_type),
    weak: weakest != null && l.step === weakest,
    link: l,
  }));

  return [
    // dark casing under the spine so it reads on satellite imagery
    new PathLayer({
      id: "pp-casing",
      data: [{ path: linePts }],
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: [11, 19, 36, 150],
      getWidth: 7,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
    }),
    new PathLayer({
      id: "pp-spine",
      data: [{ path: linePts }],
      getPath: (d: { path: [number, number][] }) => d.path,
      getColor: [229, 231, 235, 240],
      getWidth: 3,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
    }),
    // weakest-link ring
    new ScatterplotLayer({
      id: "pp-weak-ring",
      data: nodes.filter((n) => n.weak),
      getPosition: (d) => d.position,
      getRadius: 14,
      radiusUnits: "pixels",
      stroked: true,
      filled: false,
      getLineColor: [17, 24, 39],
      getLineWidth: 2,
      lineWidthUnits: "pixels",
    }),
    new ScatterplotLayer({
      id: "pp-nodes",
      data: nodes,
      getPosition: (d) => d.position,
      getRadius: 9,
      radiusUnits: "pixels",
      getFillColor: (d) => d.color,
      stroked: true,
      getLineColor: [17, 24, 39],
      getLineWidth: 1.5,
      lineWidthUnits: "pixels",
      pickable: true,
    }),
    new TextLayer({
      id: "pp-glyphs",
      data: nodes,
      getPosition: (d) => d.position,
      getText: (d) => d.glyph,
      getSize: 11,
      getColor: [17, 24, 39],
      fontWeight: 700,
    }),
  ];
}

/* =============================================================================
 * Compose + render.
 * ========================================================================== */
function allLayers() {
  return [
    ...basemapLayers(),
    circuitLayer(),
    heatLayer(),
    ...pinLayers(),
    ...powerPathLayers(),
  ].filter(Boolean);
}

function refresh() {
  if (!deck) return;
  deck.setProps({ layers: allLayers() });
}

/* the premise currently framed, used to guard against stale power-path data */
let currentPremiseId: string | null = null;

function tooltip({ object, layer }: PickingInfo): { html: string } | null {
  if (!object || !layer) return null;
  if (layer.id === "damage-hex") {
    // HexagonLayer exposes the aggregated colour value on the picked object.
    // With colorAggregation:"SUM" + getColorWeight:weight this is the summed
    // report count. Fall back to summing the raw points if it's missing.
    const o = object as {
      colorValue?: number;
      elevationValue?: number;
      points?: unknown[];
    };
    let reports = o.colorValue ?? o.elevationValue ?? 0;
    if (!reports && o.points) {
      reports = o.points.reduce<number>((sum, p) => {
        const rec = p as { weight?: number; source?: { weight?: number } };
        return sum + (rec.weight ?? rec.source?.weight ?? 0);
      }, 0);
    }
    return {
      html: `<strong>Storm damage</strong><br>${Math.round(reports)} reports in this area`,
    };
  }
  if (layer.id === "pp-nodes") {
    const l = (object as { link: PowerPathLink; weak: boolean }).link;
    const weak = (object as { weak: boolean }).weak;
    const pct =
      l.p_damage != null ? `${Math.round(l.p_damage * 100)}% chance of damage` : "risk n/a";
    return {
      html:
        `<strong>Step ${l.step}: ${l.device_type}</strong><br>${pct}` +
        (weak ? `<br><em>Weakest link on your path</em>` : "") +
        (l.reason ? `<br><span style="opacity:.8">${l.reason}</span>` : ""),
    };
  }
  if (layer.id === "home-pin" && home) {
    return {
      html: `<strong>${home.label}</strong><br>Service: ${home.service}`,
    };
  }
  return null;
}

/* =============================================================================
 * PUBLIC API (consumed by main.ts)
 * ========================================================================== */

export interface InitMapArgs {
  container: string; // css id of the map div
  lat: number;
  lon: number;
  heat: DamageHeat;
  circuit: GeoJSON.GeoJsonObject | null;
  home: { lat: number; lon: number; label: string; service: string };
  powerPath: PowerPath | null;
  premiseId: string;
}

export function initMap(args: InitMapArgs): void {
  heat = args.heat;
  circuit = args.circuit;
  home = args.home;
  powerPath = args.powerPath;
  currentPremiseId = args.premiseId;

  viewState = {
    longitude: args.lon,
    latitude: args.lat,
    zoom: 12.5,
    pitch: OVERVIEW_PITCH,
    bearing: 0,
  };

  deck = new Deck({
    parent: document.getElementById(args.container) as HTMLDivElement,
    initialViewState: viewState,
    controller: { dragRotate: true, touchRotate: true },
    layers: allLayers(),
    getTooltip: tooltip,
    onViewStateChange: ({ viewState: vs }) => {
      viewState = vs as ViewState;
    },
  });
}

/** Fly the camera down to a premise and reveal its pin + power path. */
export function flyToPremise(
  lat: number,
  lon: number,
  premiseId: string,
  homeInfo?: { label: string; service: string }
): void {
  if (!deck) return;
  currentPremiseId = premiseId;
  if (home) {
    home.lat = lat;
    home.lon = lon;
    if (homeInfo) {
      home.label = homeInfo.label;
      home.service = homeInfo.service;
    }
  }
  // Drop to a flat, top-down 2D heatmap zoomed in on the home + its path.
  heatVisible = true;
  flatHeat = true;
  viewState = {
    ...viewState,
    longitude: lon,
    latitude: lat,
    zoom: PREMISE_ZOOM,
    pitch: 0,
    bearing: 0,
    transitionDuration: 1800,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
  };
  deck.setProps({ initialViewState: viewState, layers: allLayers() });
}

/** Pull the camera back out to the pitched overview hex field. */
export function flyToOverview(): void {
  if (!deck || !home) return;
  heatVisible = true;
  flatHeat = false; // back to extruded 3D hexagons
  viewState = {
    ...viewState,
    zoom: 12.5,
    pitch: OVERVIEW_PITCH,
    transitionDuration: 1600,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
  };
  deck.setProps({ initialViewState: viewState, layers: allLayers() });
}

/** Swap in a new power path (e.g. after a premise change / severity change). */
export function setPowerPath(pp: PowerPath | null, premiseId: string): void {
  powerPath = pp;
  currentPremiseId = premiseId;
  refresh();
}

/** Storm-timeline hook: recolour circuit, restyle pin, show/hide heat. */
export function setPhaseVisuals(opts: {
  pin?: PinState;
  circuit?: Color;
  showHeat?: boolean;
}): void {
  if (opts.pin) pinState = opts.pin;
  if (opts.circuit) circuitPhaseColor = opts.circuit;
  if (opts.showHeat != null) heatVisible = opts.showHeat;
  refresh();
}

/** Keep the deck canvas sized to its container (parity with invalidateSize). */
export function resizeMap(): void {
  if (deck) deck.redraw();
}
