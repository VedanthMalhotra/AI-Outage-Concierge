/// <reference types="vite/client" />
/** TomTom vector map with native, terrain-aware AEP GeoJSON overlays. */
import { TomTomMap, BaseMapModule, TerrainModule } from "@tomtom-org/maps-sdk/map";
import { Marker, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Color } from "@deck.gl/core";
import type { InitMapArgs } from "./map3d";
import type { Band, PowerPath, RiskHeat } from "./types";

setWorkerUrl(workerUrl);
const COLORS: Record<Band, string> = {
  Low: "#22c55e", Moderate: "#facc15", High: "#f97316", "Very High": "#ef4444",
};
let sdk: TomTomMap | null = null;
let terrain: TerrainModule | null = null;
let buildings: BaseMapModule | null = null;
let mode: "2d" | "3d" = "3d";
let home: InitMapArgs["home"] | null = null;
let premiseId = "";
let path: PowerPath | null = null;
let heat: RiskHeat | null = null;
let outline: GeoJSON.GeoJsonObject | null = null;
let homeVisible = true;
let heatVisible = true;
let phase: "damaged" | "restored" | null = null;
let circuitColor = "#467d78";
let marker: Marker | null = null;
let ready = false;
const empty = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });
const feature = (geometry: GeoJSON.Geometry, properties: Record<string, unknown> = {}): GeoJSON.Feature =>
  ({ type: "Feature", geometry, properties });
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function status(text: string) {
  const node = document.getElementById("map-status");
  if (node) node.textContent = text;
}
function updateSource(id: string, data: GeoJSON.GeoJSON) {
  (sdk?.mapLibreMap.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}
/* our overlays: risk heat, circuit outline, power path and its equipment (idempotent) */
function addAepLayers(map: TomTomMap["mapLibreMap"]) {
  if (map.getSource("aep-risk")) return;
  for (const id of ["aep-risk", "aep-circuit", "aep-path", "aep-nodes"]) {
    map.addSource(id, { type: "geojson", data: empty() });
  }
  map.addLayer({ id: "aep-risk-fill", type: "fill", source: "aep-risk",
    paint: { "fill-color": ["get", "color"], "fill-opacity": .38, "fill-outline-color": "rgba(255,255,255,0.1)" } });
  map.addLayer({ id: "aep-circuit-line", type: "line", source: "aep-circuit",
    paint: { "line-color": circuitColor, "line-width": 2, "line-opacity": .6, "line-dasharray": [3, 3] } });
  map.addLayer({ id: "aep-path-casing", type: "line", source: "aep-path",
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fff", "line-width": 7 } });
  map.addLayer({ id: "aep-path-line", type: "line", source: "aep-path",
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#147c99", "line-width": 3 } });
  map.addLayer({ id: "aep-weakest", type: "circle", source: "aep-nodes", filter: ["==", ["get", "weak"], true],
    paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#233e45", "circle-stroke-width": 2 } });
  map.addLayer({ id: "aep-equipment", type: "circle", source: "aep-nodes",
    paint: { "circle-radius": 11, "circle-color": ["get", "color"], "circle-stroke-color": "white", "circle-stroke-width": 2 } });
}

/* one-letter equipment labels on the power path (T transformer, F fuse, R recloser, ...),
 * as HTML markers so they don't depend on the map style's fonts */
const LETTER: [RegExp, string][] = [[/transformer/i, "T"], [/fuse/i, "F"], [/recloser/i, "R"],
  [/breaker|substation/i, "B"], [/switch/i, "S"]];
let nodeMarkers: Marker[] = [];
function drawNodeLabels(map: TomTomMap["mapLibreMap"], nodes: GeoJSON.FeatureCollection) {
  nodeMarkers.forEach(m => m.remove());
  nodeMarkers = nodes.features.map(f => {
    const pr = f.properties as { equipment: string; chance: number | null };
    const el = document.createElement("div");
    el.className = "tt-node-label";
    el.textContent = LETTER.find(([re]) => re.test(pr.equipment))?.[1] ?? (pr.equipment || "?").charAt(0).toUpperCase();
    el.title = `${pr.equipment}${pr.chance == null ? "" : ` · ${pr.chance}% chance of damage`}`;
    return new Marker({ element: el, anchor: "center" })
      .setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(map);
  });
}

function refresh() {
  if (!sdk || !ready) return;
  const map = sdk.mapLibreMap;
  addAepLayers(map); // no-op unless a style reload dropped them
  const cells = empty();
  if (heat && heatVisible) {
    const h = heat.cell_size_deg / 2;
    cells.features = heat.cells.map(c => feature({ type: "Polygon", coordinates: [[
      [c.lon-h,c.lat-h], [c.lon+h,c.lat-h], [c.lon+h,c.lat+h], [c.lon-h,c.lat+h], [c.lon-h,c.lat-h],
    ]] }, { color: COLORS[c.band], band: c.band, chance: Math.round(c.probability * 100), homes: c.homes }));
  }
  updateSource("aep-risk", cells);
  updateSource("aep-circuit", (outline as GeoJSON.GeoJSON) ?? empty());
  map.setPaintProperty("aep-circuit-line", "line-color", circuitColor);
  const nodes = empty();
  const spine = empty();
  if (homeVisible && home && path?.premise_id === premiseId) {
    const links = path.links.filter(l => l.lon != null && l.lat != null);
    const points: GeoJSON.Position[] = [[home.lon, home.lat], ...links.map(l => [l.lon!, l.lat!])];
    if (points.length > 1) spine.features = [feature({ type: "LineString", coordinates: points })];
    nodes.features = links.map(l => {
      const p = l.p_damage;
      const band = l.band ?? (p == null ? null : p < .15 ? "Low" : p < .4 ? "Moderate" : p < .7 ? "High" : "Very High");
      const damaged = phase === "damaged" && (band === "High" || band === "Very High");
      return feature({ type: "Point", coordinates: [l.lon!, l.lat!] }, {
        color: phase === "restored" ? "#22c55e" : damaged ? "#ef4444" : band ? COLORS[band] : "#94a3b8",
        weak: l.step === path!.weakest_link_step, equipment: l.device_type,
        chance: p == null ? null : Math.round(p * 100), reason: l.reason ?? "",
      });
    });
  }
  updateSource("aep-path", spine);
  updateSource("aep-nodes", nodes);
  drawNodeLabels(map, nodes);
  map.setPaintProperty("aep-path-line", "line-color", phase === "restored" ? "#22c55e" : "#147c99");
  if (marker && home) {
    marker.setLngLat([home.lon, home.lat]);
    // style, not the hidden attribute: the marker's CSS (display:flex) overrides `hidden`
    marker.getElement().style.display = homeVisible ? "" : "none";
  }
}

export function initMap(args: InitMapArgs): void {
  home = { ...args.home }; premiseId = args.premiseId;
  path = args.powerPath; heat = args.heat; outline = args.circuit;
  const apiKey = import.meta.env.VITE_TOMTOM_API_KEY?.trim();
  if (!apiKey) { status("TomTom key needed"); return; }
  status("Loading TomTom map…");
  sdk = new TomTomMap({
    apiKey, language: "en-US", style: "streetLight", registerMapLibreWorker: false,
    mapLibre: {
      container: args.container, center: [args.lon, args.lat], zoom: 12.5,
      pitch: 55, bearing: -18, minZoom: 8, maxZoom: 19, maxPitch: 70,
    },
  });
  const map = sdk.mapLibreMap;
  const label = document.querySelector(".map-attribution");
  if (label) label.textContent = "Outage layers: processed AEP data · Model estimates";
  map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
  map.on("error", () => {
    // Do not log request URLs: these contain the browser API key.
    status("TomTom map request failed · check key permissions or connection");
  });
  // TomTom's 3D buildings / terrain modules reload the map style, which drops our
  // sources and layers: put them back whenever that happens, then redraw
  map.on("styledata", () => {
    if (ready && !map.getSource("aep-risk")) refresh();
  });
  map.once("load", () => {
    addAepLayers(map);
    const pin = document.createElement("div");
    pin.className = "tomtom-home";
    pin.setAttribute("aria-label", "Your selected home");
    pin.innerHTML = '<span aria-hidden="true">⌂</span><strong>Your home</strong>';
    marker = new Marker({ element: pin, anchor: "bottom" }).setLngLat([home!.lon, home!.lat]).addTo(map);
    ready = true;
    refresh();
    if (areaPending) flyToArea();
    status("TomTom · 3D map");
    void BaseMapModule.get(sdk!, { groups: { buildings3D: { visible: mode === "3d" } } })
      .then(value => { buildings = value; }).catch(() => status("TomTom · 3D buildings unavailable"));
    void TerrainModule.get(sdk!, { hillshade: { visible: true }, elevation: { visible: mode === "3d" } })
      .then(value => { terrain = value; status(mode === "3d" ? "TomTom · 3D terrain & buildings" : "TomTom · 2D map"); })
      .catch(() => status("TomTom · 3D buildings · terrain unavailable"));
    const popup = new Popup({ closeButton: false, closeOnClick: false });
    for (const id of ["aep-risk-fill", "aep-equipment"]) {
      map.on("mousemove", id, e => {
        const props = e.features?.[0]?.properties;
        if (!props) return;
        map.getCanvas().style.cursor = "pointer";
        const text = id === "aep-risk-fill"
          ? `${props.chance}% outage chance · ${props.band}\nAverage for ${props.homes} homes · Model estimate`
          : `${props.equipment}\n${props.chance == null ? "No risk estimate" : `${props.chance}% chance of damage`}\n${props.reason}`;
        popup.setLngLat(e.lngLat).setText(text).addTo(map);
      });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    }
  });
}
export function flyToPremise(lat: number, lon: number, id: string, info?: { label: string; service: string }) {
  premiseId = id;
  areaPending = false; // a home was picked: don't zoom back out later
  if (home) Object.assign(home, { lat, lon }, info);
  refresh();
  sdk?.mapLibreMap.flyTo({ center: [lon, lat], zoom: 16, pitch: mode === "3d" ? 55 : 0,
    bearing: mode === "3d" ? -18 : 0, duration: reducedMotion() ? 0 : 1600 });
}
export function flyToOverview() {
  if (!home) return;
  sdk?.mapLibreMap.flyTo({ center: [home.lon, home.lat], zoom: 12.5, pitch: mode === "3d" ? 55 : 0,
    bearing: mode === "3d" ? -18 : 0, duration: reducedMotion() ? 0 : 1400 });
}
/** Zoom out to show the whole risk heat map (no premise selected, or the overview button).
 * Returns false until the heat has loaded and the map is ready. */
let areaPending = false; // asked to show the whole area before the map/heat was ready
export function flyToArea(): boolean {
  if (!sdk || !ready || !heat || !heat.cells.length) {
    areaPending = true; // done as soon as both are in (map load / setRiskHeat)
    return false;
  }
  areaPending = false;
  const pad = heat.cell_size_deg;
  const lats = heat.cells.map(c => c.lat), lons = heat.cells.map(c => c.lon);
  sdk.mapLibreMap.fitBounds(
    [[Math.min(...lons) - pad, Math.min(...lats) - pad], [Math.max(...lons) + pad, Math.max(...lats) + pad]],
    { padding: 24, pitch: mode === "3d" ? 45 : 0, bearing: 0, duration: reducedMotion() ? 0 : 1400 });
  return true;
}
export function setViewMode(next: "2d" | "3d") {
  mode = next;
  terrain?.setElevationVisible(next === "3d");
  buildings?.setVisible(next === "3d", { layerGroups: { show: "only", values: ["buildings3D"] } });
  sdk?.mapLibreMap.easeTo({ pitch: next === "3d" ? 55 : 0, bearing: next === "3d" ? -18 : 0,
    duration: reducedMotion() ? 0 : 800 });
  status(next === "3d" ? "TomTom · 3D map" : "TomTom · 2D map");
}
export function getViewMode() { return mode; }
export function setHomeVisible(visible: boolean) { homeVisible = visible; refresh(); }
export function setPowerPath(value: PowerPath | null, id: string) { path = value; premiseId = id; refresh(); }
export function setRiskHeat(value: RiskHeat | null) {
  heat = value;
  refresh();
  if (areaPending) flyToArea();
}
export function setCircuit(value: GeoJSON.GeoJsonObject | null) { outline = value; refresh(); }
export function setPhaseVisuals(opts: { pin?: "normal" | "out" | "restored"; circuit?: Color; showHeat?: boolean; pathPhase?: "damaged" | "restored" | null }) {
  if (opts.pin && marker) marker.getElement().dataset.state = opts.pin;
  if (opts.circuit) circuitColor = `rgb(${opts.circuit[0]},${opts.circuit[1]},${opts.circuit[2]})`;
  if (opts.showHeat !== undefined) heatVisible = opts.showHeat;
  if (opts.pathPhase !== undefined) phase = opts.pathPhase;
  refresh();
}
export function resizeMap() { sdk?.mapLibreMap.resize(); }
