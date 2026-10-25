/* =============================================================================
 * 3D map (deck.gl standalone) — replaces the old flat Leaflet map.
 *
 * On load the map shows the predicted-risk heat: ~500 m squares coloured by the
 * average chance (from the trained model) that homes there lose power in the
 * chosen storm. When a premise id is entered the camera flies/zooms down to that
 * home (FlyToInterpolator) and the home's pin + power path are revealed.
 *
 * Everything the old Leaflet code drew is reproduced here with deck.gl layers:
 *   - satellite basemap     -> TileLayer + BitmapLayer (Esri World Imagery)
 *   - circuit outline       -> GeoJsonLayer
 *   - predicted-risk heat   -> SolidPolygonLayer (flat squares, band colours)
 *   - the home's own pin     -> ScatterplotLayer + TextLayer
 *   - the power path graphic -> PathLayer + ScatterplotLayer + TextLayer
 *
 * main.ts talks to this module through a small, stable surface so the storm
 * timeline, risk, restoration, chat, etc. are untouched.
 * ========================================================================== */

import { Deck, FlyToInterpolator, WebMercatorViewport, type Color, type PickingInfo } from "@deck.gl/core";
import { TileLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import {
  BitmapLayer,
  GeoJsonLayer,
  PathLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
  TextLayer,
} from "@deck.gl/layers";
import type { Band, PowerPath, PowerPathLink, RiskHeat, RiskHeatCell } from "./types";

/* ---- camera framing --------------------------------------------------- */
const OVERVIEW_PITCH = 52;
const TILT_3D = 52;
const PREMISE_ZOOM = 14.5;

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
let mapEl: HTMLDivElement | null = null; // the map container, for fitting the view
let heat: RiskHeat | null = null;
let circuit: GeoJSON.GeoJsonObject | null = null;
let powerPath: PowerPath | null = null;
let home: { lat: number; lon: number; label: string; service: string } | null = null;

let heatVisible = true; // storm timeline toggles this
let viewMode: "2d" | "3d" = "3d";
let terrainFailed = false;
let pinState: PinState = "normal";
let circuitPhaseColor: Color = [255, 90, 82];

/* storm-timeline state for the power path: during outage phases the whole path
 * reads as "damaged", and at the end of the animation it flips to "restored".
 * null = no storm running, so the path keeps its per-link risk colouring. */
type PathPhase = "damaged" | "restored";
let pathPhase: PathPhase | null = null;
const PATH_PHASE_COLOR: Record<PathPhase, Color> = {
  damaged: [239, 68, 68], // red — same as the Very High risk band
  restored: [34, 197, 94], // green — matches the restored pin
};

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
  if (viewMode === "3d" && !terrainFailed) {
    return [new TerrainLayer({
      id: "roanoke-terrain",
      elevationData: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      texture: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
      minZoom: 0, maxZoom: 14, tileSize: 256, meshMaxError: 8,
      operation: "terrain+draw", strategy: "no-overlap",
      onTileError: () => {
        terrainFailed = true;
        const status = document.getElementById("map-status");
        if (status) status.textContent = "Terrain unavailable · satellite view";
        refresh();
      },
    })];
  }
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
 * Predicted-risk heat: Hanshil's model (backend /risk/heat).
 *
 * Each ~500 m square is coloured by the AVERAGE predicted chance that homes in
 * it lose power, using the same Low / Moderate / High / Very High bands as the
 * power path. Squares with fewer than 5 homes never arrive from the backend, so
 * no single home can be picked out. Flat (no 3D) and refetched when the storm
 * severity slider moves.
 * ========================================================================== */
/* stronger bands are more opaque so the risky areas stand out over the imagery */
const RISK_ALPHA: Record<Band, number> = { Low: 55, Moderate: 105, High: 140, "Very High": 165 };

function cellPolygon(c: RiskHeatCell, size: number): [number, number][] {
  const h = size / 2;
  return [
    [c.lon - h, c.lat - h],
    [c.lon + h, c.lat - h],
    [c.lon + h, c.lat + h],
    [c.lon - h, c.lat + h],
  ];
}

function heatLayer() {
  if (!heat || !heatVisible) return null;
  const size = heat.cell_size_deg;
  return new SolidPolygonLayer<RiskHeatCell>({
    id: "risk-heat",
    data: heat.cells,
    getPolygon: (c) => cellPolygon(c, size),
    getFillColor: (c) => rgba(BAND_COLOR[c.band], RISK_ALPHA[c.band]),
    pickable: true,
    updateTriggers: { getPolygon: size },
  });
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
let homeHidden = false; // "no premise" demo mode: there is no home to mark

/** Show or hide the home pin (hidden when no premise is selected). */
export function setHomeVisible(visible: boolean): void {
  homeHidden = !visible;
  refresh();
}

function pinLayers() {
  if (!home || homeHidden) return [];
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
/** A link is "at risk" (and so can show damaged) when its risk band is High or
 * Very High — i.e. p_damage >= 0.4, the Moderate→High boundary in bandFromProb. */
function linkAtRisk(link: PowerPathLink): boolean {
  const band = link.band || bandFromProb(link.p_damage);
  return band === "High" || band === "Very High";
}
function linkColor(link: PowerPathLink): Color {
  // At the end of the storm the whole path reads as restored.
  if (pathPhase === "restored") return PATH_PHASE_COLOR.restored;
  // During the outage only the at-risk links turn damaged; everything else
  // keeps its normal per-link risk colour.
  if (pathPhase === "damaged" && linkAtRisk(link)) return PATH_PHASE_COLOR.damaged;
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
      // Neutral light spine normally. The spine spans the whole chain, so it
      // only turns green once the path is restored; during the outage it stays
      // neutral and the at-risk nodes carry the damaged colour.
      getColor:
        pathPhase === "restored"
          ? rgba(PATH_PHASE_COLOR.restored, 245)
          : ([229, 231, 235, 240] as Color),
      getWidth: 3,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getColor: pathPhase },
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
      updateTriggers: { getFillColor: pathPhase },
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
  const overlays = [
    circuitLayer(), heatLayer(), ...pinLayers(), ...powerPathLayers(),
  ].filter(Boolean).map((layer) => {
    const onTerrain = viewMode === "3d" && !terrainFailed;
    // deck.gl won't rebuild a layer when only its extensions change, so switching 2D/3D
    // under the same id left the overlays blank in 2D: give each mode its own id
    // (cast: the layers are different types, so TS can't type the shared clone props)
    return (layer as unknown as { clone: (p: object) => typeof layer }).clone({
      id: `${layer!.id}${onTerrain ? "--terrain" : ""}`,
      extensions: onTerrain ? [new TerrainExtension()] : [],
    });
  });
  return [
    ...basemapLayers(),
    ...overlays,
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
  const id = layer.id.replace(/--terrain$/, ""); // same layer in 2D or 3D
  if (id === "risk-heat") {
    const c = object as RiskHeatCell;
    return {
      html:
        `<strong>${Math.round(c.probability * 100)}% chance of losing power</strong> (${c.band})` +
        `<br>average for about ${c.homes} homes in this area` +
        `<br><span style="opacity:.8">Model estimate for a ${heat?.storm_severity ?? 1}× Feb 2025 storm</span>`,
    };
  }
  if (id === "pp-nodes") {
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
  if (id === "home-pin" && home) {
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
  heat: RiskHeat | null;
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
    parent: (mapEl = document.getElementById(args.container) as HTMLDivElement),
    initialViewState: viewState,
    controller: { dragRotate: true, touchRotate: true, inertia: 250 },
    useDevicePixels: Math.min(window.devicePixelRatio, 2),
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
  // Zoom in on the home + its path; the camera tilt follows the user's 2D/3D toggle.
  heatVisible = true;
  viewState = {
    ...viewState,
    longitude: lon,
    latitude: lat,
    zoom: PREMISE_ZOOM,
    pitch: viewMode === "3d" ? TILT_3D : 0,
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
  viewState = {
    ...viewState,
    zoom: 12.5,
    pitch: viewMode === "3d" ? TILT_3D : 0,
    transitionDuration: 1600,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
  };
  deck.setProps({ initialViewState: viewState, layers: allLayers() });
}

/**
 * User-facing 2D/3D toggle. 2D = flat top-down view; 3D = tilted camera over
 * the same predicted-risk squares. Keeps the current center and zoom, only
 * animating the tilt.
 */
export function setViewMode(mode: "2d" | "3d"): void {
  if (!deck || mode === viewMode) return;
  viewMode = mode;
  const status = document.getElementById("map-status");
  if (status) status.textContent = mode === "3d" && !terrainFailed ? "3D terrain · satellite imagery" : "Satellite view";
  viewState = {
    ...viewState,
    pitch: mode === "3d" ? TILT_3D : 0,
    transitionDuration: 900,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }),
  };
  deck.setProps({ initialViewState: viewState, layers: allLayers() });
}

/** Current view mode, so the UI can sync its toggle state. */
export function getViewMode(): "2d" | "3d" {
  return viewMode;
}

/** Swap in a new power path (e.g. after a premise change / severity change). */
export function setPowerPath(pp: PowerPath | null, premiseId: string): void {
  powerPath = pp;
  currentPremiseId = premiseId;
  refresh();
}

/** Swap in a new circuit outline (the selected home is on a different circuit). */
export function setCircuit(c: GeoJSON.GeoJsonObject | null): void {
  circuit = c;
  refresh();
}

/** Zoom out to show the whole predicted-risk heat map (used when no premise is
 * selected). Returns false if the heat hasn't loaded yet. */
export function flyToArea(): boolean {
  if (!deck || !mapEl || !heat || !heat.cells.length) return false;
  const lats = heat.cells.map((c) => c.lat);
  const lons = heat.cells.map((c) => c.lon);
  const pad = heat.cell_size_deg;
  const fit = new WebMercatorViewport({
    width: mapEl.clientWidth || 800,
    height: mapEl.clientHeight || 500,
  }).fitBounds(
    [
      [Math.min(...lons) - pad, Math.min(...lats) - pad],
      [Math.max(...lons) + pad, Math.max(...lats) + pad],
    ],
    { padding: 24 }
  );
  viewState = {
    ...viewState,
    longitude: fit.longitude,
    latitude: fit.latitude,
    zoom: fit.zoom,
    pitch: viewMode === "3d" ? TILT_3D : 0,
    bearing: 0,
    transitionDuration: 1600,
    transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
  };
  deck.setProps({ initialViewState: viewState, layers: allLayers() });
  return true;
}

/** Swap in the predicted-risk heat for a new storm severity. */
export function setRiskHeat(h: RiskHeat | null): void {
  heat = h;
  refresh();
}

/** Storm-timeline hook: recolour circuit, restyle pin, show/hide heat, and
 * drive the power-path phase (damaged / restored). Pass pathPhase:null to
 * restore the per-link risk colouring when the storm is reset. */
export function setPhaseVisuals(opts: {
  pin?: PinState;
  circuit?: Color;
  showHeat?: boolean;
  pathPhase?: PathPhase | null;
}): void {
  if (opts.pin) pinState = opts.pin;
  if (opts.circuit) circuitPhaseColor = opts.circuit;
  if (opts.showHeat != null) heatVisible = opts.showHeat;
  if (opts.pathPhase !== undefined) pathPhase = opts.pathPhase;
  refresh();
}

/** Keep the deck canvas sized to its container (parity with invalidateSize). */
export function resizeMap(): void {
  if (deck) deck.redraw();
}

