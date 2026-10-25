/* =============================================================================
 * AI Outage Concierge — dashboard (mock-data build), TypeScript + Tailwind.
 *
 * Reads the sample JSON in ../mock/api/*. Every shape here matches MVP plan §7
 * (see types.ts), so swapping the mock fetch for the real endpoint is the only
 * change needed when the backend exists.
 *
 * NOTE: all figures are illustrative sample data, never model output.
 * ========================================================================== */

import L from "leaflet";
import "./styles.css";
import { $, el, getJSON, toast } from "./dom";
import {
  DEFAULT_PREMISE_ID,
  apiHealthy,
  endChat,
  fetchDamageHeat,
  fetchPremiseLookup,
  fetchRestorationGrid,
  fetchRiskBySeverity,
  sendChat,
} from "./api";
import type {
  AppData,
  AppState,
  Band,
  GridRow,
  Phase,
  Risk,
  Scenario,
  TimelineStep,
} from "./types";

/* Mock API base, relative to web/index.html. */
const API = "../mock/api";

/* Severity slider index -> multiplier used by the mock files. */
const SEVERITIES = [0.5, 1.0, 1.5, 2.0] as const;
const SEVERITY_LABELS: Record<number, string> = {
  0.5: "Minor (0.5×)",
  1.0: "Feb-2025-like (1.0×)",
  1.5: "Severe (1.5×)",
  2.0: "Extreme (2.0×)",
};

/* Band -> css modifier so colour is never used alone. */
const BAND_CLASS: Record<Band, string> = {
  Low: "band-low",
  Moderate: "band-moderate",
  High: "band-high",
  "Very High": "band-veryhigh",
};

/* ---------------------------------------------------------------------------
 * Global state (session only — mirrors the privacy promise in the footer).
 * ------------------------------------------------------------------------- */
const state: AppState = {
  premiseId: DEFAULT_PREMISE_ID,
  severity: 1.0,
  scenario: {
    crews: 2,
    storm_severity: 1.0,
    access: "auto",
    switching_available: true,
    failed_upstream_device: null,
    prioritize_critical: true,
    start_delay_h: 6,
  },
  declaredNeeds: [],
  lastRestoration: null,
  history: [],
  timelineStep: -1,
  playTimer: null,
};

/* Loaded mock data caches */
const data: AppData = {
  lookup: null,
  circuit: null,
  heat: null,
  riskBySeverity: null,
  riskFallback: null,
  grid: null,
  guidance: null,
  alerts: null,
  timeline: null,
  chat: null,
  assumptions: null,
};

/* remembers the previous risk sample for the before/after delta note */
let prevRisk: Risk | null = null;

/* true once the backend answered /health; model output then comes from it */
let live = false;

/* Risk and restoration for one premise from the trained models (live API).
 * Keeps whatever is loaded (mock or the previous premise) if the call fails. */
async function loadModelOutput(premiseId: string): Promise<void> {
  if (!live) return;
  try {
    const [risk, grid] = await Promise.all([
      fetchRiskBySeverity(premiseId),
      fetchRestorationGrid(premiseId),
    ]);
    data.riskBySeverity = risk;
    data.grid = grid;
  } catch (err) {
    console.warn("Model output unavailable, keeping current data:", err);
  }
}

/* =============================================================================
 * BOOT
 * ========================================================================== */
let map: L.Map;
let pinLayer: L.Marker;
let circuitLayer: L.GeoJSON;
let heatLayer: L.LayerGroup;

async function boot(): Promise<void> {
  try {
    // The mock pieces the backend does not yet serve (circuit outline, risk,
    // restoration grid, guidance, alerts, timeline, chat, assumptions). These
    // always load; the backend has no equivalents yet.
    [
      data.circuit,
      data.riskBySeverity,
      data.riskFallback,
      data.grid,
      data.guidance,
      data.alerts,
      data.timeline,
      data.chat,
      data.assumptions,
    ] = await Promise.all([
      getJSON<AppData["circuit"]>(API, "circuit_area.geojson"),
      getJSON<AppData["riskBySeverity"]>(API, "risk_by_severity.json"),
      getJSON<AppData["riskFallback"]>(API, "risk_fallback.json"),
      getJSON<AppData["grid"]>(API, "restoration_grid.json"),
      getJSON<AppData["guidance"]>(API, "guidance.json"),
      getJSON<AppData["alerts"]>(API, "alerts.json"),
      getJSON<AppData["timeline"]>(API, "timeline.json"),
      getJSON<AppData["chat"]>(API, "chat_examples.json"),
      getJSON<AppData["assumptions"]>(API, "assumptions.json"),
    ]);

    // Premise lookup + damage heat come from the live backend when it is
    // reachable, otherwise fall back to the mock JSON so the page still works.
    live = await apiHealthy();
    if (live) {
      try {
        [data.lookup, data.heat] = await Promise.all([
          fetchPremiseLookup(state.premiseId),
          fetchDamageHeat("feb2025"),
        ]);
      } catch (liveErr) {
        console.warn("Live API call failed, falling back to mock:", liveErr);
      }
    }
    if (!data.lookup) {
      data.lookup = await getJSON<AppData["lookup"]>(API, "premise_lookup.json");
    }
    if (!data.heat) {
      data.heat = await getJSON<AppData["heat"]>(API, "damage_heat.json");
    }

    // Keep state in sync with whatever premise the lookup settled on.
    state.premiseId = data.lookup!.premise_id;
    await loadModelOutput(state.premiseId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    document.body.innerHTML =
      `<p style="padding:2rem;font-family:sans-serif">Could not load data. ` +
      `Start the backend (<code>uv run uvicorn app.main:app --port 8000</code>) ` +
      `or serve the mock folder over http (e.g. <code>npm run dev</code>) and open ` +
      `<code>web/index.html</code>.<br><br>${msg}</p>`;
    return;
  }

  const src = data.lookup!.is_mock === false ? "live API" : "sample data";
  $("#area-label").textContent = `${data.lookup!.area_label} · ${src}`;

  buildPremisePicker();
  initMap();
  wireControls();
  buildChatSuggestions();
  renderAssumptions();
  seedChat();

  // first render
  renderRisk();
  renderRestoration({ silent: true });
  renderGuidance();
  renderAlerts();
  buildTimelineTrack();
}

/* =============================================================================
 * PREMISE PICKER (dev-only; real app uses map clicks / ID entry)
 * ========================================================================== */
function buildPremisePicker(): void {
  const sel = $<HTMLSelectElement>("#premise-select");
  sel.innerHTML = "";
  data.lookup!.demo_premises.forEach((p) => {
    const o = el("option");
    o.value = p.premise_id;
    o.textContent = `${p.premise_id} · ${p.service_type}`;
    sel.appendChild(o);
  });
  sel.value = state.premiseId;
  sel.addEventListener("change", async () => {
    state.premiseId = sel.value;
    await loadModelOutput(sel.value);
    const p = data.lookup!.demo_premises.find((x) => x.premise_id === sel.value);
    if (p && map) {
      pinLayer.setLatLng([p.lat, p.lon]);
      map.panTo([p.lat, p.lon]);
    }
    renderRisk();
    renderRestoration({ silent: true });
    toast(`Selected premise ${sel.value}`);
  });
}

/* =============================================================================
 * MAP (Leaflet) — own pin + circuit outline + aggregated damage heat only
 * ========================================================================== */
function initMap(): void {
  const { lat, lon } = data.lookup!;
  map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: false,
    attributionControl: false,
  }).setView([lat, lon], 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

  // Basemap: Esri World Imagery (satellite) — keyless, shows real rooftops.
  const ESRI_IMAGERY =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ESRI_LABELS =
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
  const ESRI_TRANSPORT =
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}";

  const imagery = L.tileLayer(ESRI_IMAGERY, {
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(map);

  // Roads + place names as semi-transparent reference overlays.
  L.tileLayer(ESRI_TRANSPORT, { maxZoom: 19, opacity: 0.9, crossOrigin: true }).addTo(map);
  L.tileLayer(ESRI_LABELS, { maxZoom: 19, opacity: 0.9, crossOrigin: true }).addTo(map);

  // If satellite tiles are blocked, fall back to keyless OSM streets.
  let swappedTiles = false;
  imagery.on("tileerror", () => {
    if (swappedTiles) return;
    swappedTiles = true;
    map.removeLayer(imagery);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
  });

  // Circuit area (shaded). Kept on a ref so the storm can recolor it.
  circuitLayer = L.geoJSON(data.circuit as GeoJSON.GeoJsonObject, {
    style: { color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 },
  }).addTo(map);

  // Aggregated damage heat — graduated circles per ~1 km cell.
  const counts = data.heat!.cells.map((c) => c.count);
  const maxCount = Math.max(...counts, 1);
  heatLayer = L.layerGroup();
  data.heat!.cells.forEach((c) => {
    const t = c.count / maxCount;
    L.circle([c.lat, c.lon], {
      radius: 450,
      stroke: false,
      fillColor: t > 0.66 ? "#ef4444" : t > 0.33 ? "#f97316" : "#eab308",
      fillOpacity: 0.12 + 0.35 * t,
    })
      .bindTooltip(`${c.count} damage report(s) in this ~1 km cell (Feb 2025)`)
      .addTo(heatLayer);
  });
  heatLayer.addTo(map); // shown at rest; the storm hides then re-reveals it

  // The customer's own pin (the only point we ever plot).
  pinLayer = L.marker([lat, lon], {
    title: "Your home",
    icon: makePinIcon("normal"),
  })
    .addTo(map)
    .bindPopup(
      `<strong>Your home</strong><br>${data.lookup!.area_label}<br>Service: ${data.lookup!.service_type}`
    );

  setTimeout(() => map.invalidateSize(), 200);
}

type PinState = "normal" | "out" | "restored";
function makePinIcon(stateName: PinState): L.DivIcon {
  const mod =
    stateName === "out"
      ? " pin-dot--out"
      : stateName === "restored"
        ? " pin-dot--restored"
        : "";
  return L.divIcon({
    className: "pin-icon",
    html: `<div class="pin-dot${mod}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

/* =============================================================================
 * RISK CARD (Req 1)
 * ========================================================================== */
function renderRisk(): void {
  const sevKey =
    state.severity === 1
      ? "1.0"
      : state.severity === 2
        ? "2.0"
        : String(state.severity);
  const prev = prevRisk;
  const r = data.riskBySeverity![sevKey];

  const body = $("#risk-body");
  const fb = $("#risk-fallback");

  if (!r || r.fallback) {
    body.hidden = true;
    fb.hidden = false;
    $("#risk-fallback-msg").textContent =
      (r && r.fallback && r.fallback.message) || data.riskFallback!.fallback.message;
    return;
  }
  body.hidden = false;
  fb.hidden = true;

  $("#risk-label").textContent = r.label;

  const badge = $("#risk-band");
  badge.textContent = `${r.band} risk`;
  badge.className = "band-badge " + (BAND_CLASS[r.band] || "");

  $("#risk-prob").textContent = `about ${Math.round(r.probability * 100)}%`;
  $("#risk-confidence").textContent = `· ${r.confidence} confidence`;
  $("#risk-confidence-reason").textContent = r.confidence_reason || "";

  const list = $("#risk-factors");
  list.innerHTML = "";
  r.top_factors.forEach((f) => {
    const li = el("li");
    li.appendChild(el("strong", null, f.label));
    li.appendChild(el("span", null, f.detail));
    list.appendChild(li);
  });

  // before/after delta note when severity changed
  const deltaEl = $("#risk-delta");
  if (prev && prev.band && (prev.band !== r.band || prev.probability !== r.probability)) {
    deltaEl.hidden = false;
    deltaEl.innerHTML =
      `<strong>${prev.band} ${Math.round(prev.probability * 100)}% → ${r.band} ${Math.round(r.probability * 100)}%:</strong> ` +
      `storm severity ${prev.storm_severity}× → ${r.storm_severity}×.`;
  } else {
    deltaEl.hidden = true;
  }
  prevRisk = r;
}

/* =============================================================================
 * RESTORATION (Req 2) — live via the mock lookup grid
 * ========================================================================== */
function findGridRow(sc: Scenario): GridRow | undefined {
  return data.grid!.results.find(
    (r) =>
      r.crews === sc.crews &&
      r.storm_severity === sc.storm_severity &&
      r.access === sc.access &&
      r.switching_available === sc.switching_available &&
      r.failed_upstream_device === sc.failed_upstream_device &&
      r.prioritize_critical === sc.prioritize_critical
  );
}

interface RenderRestorationOpts {
  silent?: boolean;
  changeLabel?: string | null;
}
function renderRestoration({ silent = false, changeLabel = null }: RenderRestorationOpts = {}): void {
  const sc = state.scenario;
  const row = findGridRow(sc);

  const rangeEl = $("#rest-range");
  if (!row) {
    rangeEl.textContent = "No estimate for this combination.";
    return;
  }

  rangeEl.textContent = `Likely ${Math.round(row.p10)}–${Math.round(row.p90)} hours (most likely about ${Math.round(row.p50)})`;
  $("#rest-confidence").textContent = "Model estimate · Medium confidence";

  renderDriversAndJobs();

  // before/after note
  const prev = state.lastRestoration;
  const deltaEl = $("#rest-delta");
  if (!silent && prev && changeLabel) {
    const why = whyFor(changeLabel, prev, row);
    deltaEl.hidden = false;
    deltaEl.innerHTML =
      `<strong>${changeLabel}</strong><br>` +
      `Likely ${Math.round(prev.p10)}–${Math.round(prev.p90)} h → ` +
      `${Math.round(row.p10)}–${Math.round(row.p90)} h ` +
      `(most likely ${Math.round(prev.p50)} h → ${Math.round(row.p50)} h).` +
      (why ? `<br><span class="muted">${why}</span>` : "");
    pushHistory(`${changeLabel}: ${Math.round(prev.p50)} h → ${Math.round(row.p50)} h`);
  } else if (silent) {
    deltaEl.hidden = true;
  }

  state.lastRestoration = { p10: row.p10, p50: row.p50, p90: row.p90, scenario: { ...sc } };
}

/* Plausible "why" for the before/after note. */
function whyFor(
  changeLabel: string,
  prev: { p50: number },
  now: { p50: number }
): string {
  const grew = now.p50 > prev.p50;
  if (changeLabel.startsWith("Crews")) {
    return grew
      ? "Fewer crews means jobs ahead of you run one after another."
      : "The jobs ahead of you in the queue can now run at the same time.";
  }
  if (changeLabel.startsWith("Access")) {
    return grew
      ? "Every repair job now includes extra time for restricted access."
      : "Repair jobs no longer carry the access delay.";
  }
  if (changeLabel.startsWith("Switching")) {
    return grew
      ? "Without switching, you wait for the damaged section downstream of your fuse to be fully repaired."
      : "Switching lets crews isolate the damaged section so your part comes back sooner.";
  }
  if (changeLabel.startsWith("Upstream")) {
    return grew
      ? "Your fuse must be replaced before power can return; it is now a dependency."
      : "Removing the upstream failure clears a dependency on your line.";
  }
  if (changeLabel.startsWith("Prioritize")) {
    return grew
      ? "Critical-facility jobs now jump ahead of you in the queue."
      : "Without critical-first ordering, your queue position improves.";
  }
  if (changeLabel.startsWith("Storm")) {
    return grew
      ? "More expected damage on your circuit means a longer repair queue."
      : "Less expected damage shortens the repair queue.";
  }
  return "";
}

function renderDriversAndJobs(): void {
  // live grids carry the simulator's drivers and repair queue; the mock grid doesn't
  const drivers = data.grid!.drivers ?? [
    { text: "Number of crews: adding more crews cuts the queue time", impact_h: -6.2 },
    { text: "A broken pole on your line adds about 8 hours", impact_h: 8.0 },
  ];
  const jobs = data.grid!.jobs_ahead_of_you ?? [
    { order: 1, what: "Main line repairs on your circuit", crew_hours: 9.5 },
    { order: 2, what: "Lines feeding critical facilities", crew_hours: 6.0 },
    { order: 3, what: "Broken pole + downed wire behind your fuse", crew_hours: 26.0, on_your_line: true },
  ];

  const dl = $("#rest-drivers");
  dl.innerHTML = "";
  drivers.forEach((d) => dl.appendChild(el("li", null, d.text)));

  const jl = $("#rest-jobs");
  jl.innerHTML = "";
  jobs.forEach((j) => {
    const li = el("li", j.on_your_line ? "on-your-line" : null);
    li.textContent = `${j.what} (~${j.crew_hours} crew-h)${j.on_your_line ? " · on your line" : ""}`;
    jl.appendChild(li);
  });
}

function pushHistory(text?: string): void {
  if (text) {
    state.history.unshift(text);
    state.history = state.history.slice(0, 5);
  }
  const ol = $("#change-history");
  ol.innerHTML = "";
  if (!state.history.length) {
    ol.appendChild(el("li", "muted", "No changes yet."));
    return;
  }
  state.history.forEach((h) => ol.appendChild(el("li", null, h)));
}

/* =============================================================================
 * GUIDANCE (Req 3)
 * ========================================================================== */
function guidanceVariantKey(): string {
  const medical = state.declaredNeeds.includes("medical_equipment");
  return medical ? "high_4-24h_medical" : "high_4-24h_no-needs";
}

function renderGuidance(): void {
  const v = data.guidance!.variants[guidanceVariantKey()];
  if (!v) return;

  $("#prep-label").textContent = v.label;

  const safety = $("#prep-safety");
  safety.innerHTML = "";
  v.safety.forEach((s) => {
    safety.appendChild(el("div", `safety-box safety-box--${s.level}`, `<span>${s.text}</span>`));
  });

  const esc = $("#prep-escalation");
  if (v.escalation) {
    esc.hidden = false;
    esc.textContent = v.escalation;
  } else {
    esc.hidden = true;
  }

  const cl = $("#prep-checklist");
  cl.innerHTML = "";
  v.checklist.forEach((c) => cl.appendChild(el("li", null, c)));
}

/* =============================================================================
 * ALERTS (Req 4)
 * ========================================================================== */
function renderAlerts(): void {
  const medical = state.declaredNeeds.includes("medical_equipment");
  const v = data.alerts!.variants[medical ? "medical" : "no-needs"];

  const chip = $("#alerts-eligible");
  chip.textContent = v.eligible ? "Eligible ✓" : "Not eligible";
  chip.classList.toggle("is-no", !v.eligible);

  const list = $("#alerts-rules");
  list.innerHTML = "";
  v.rules.forEach((rule) => {
    const li = el("li");
    const statusTxt =
      rule.met === true ? "✓ Active" : rule.met === false ? "— Not met" : "• Conditional";
    const statusCls = rule.met === true ? "rule-status--met" : "rule-status--maybe";
    const head = el("div", "rule-head");
    head.appendChild(el("span", `rule-status ${statusCls}`, statusTxt));
    head.appendChild(el("span", null, `<strong>${rule.name}</strong>`));
    li.appendChild(head);
    li.appendChild(el("span", "rule-why", rule.why));
    if (rule.channels) {
      const ch = el("div", "rule-channels");
      rule.channels.forEach((c) => ch.appendChild(el("span", "tag", c.toUpperCase())));
      (rule.timing || []).forEach((t) => ch.appendChild(el("span", "tag", t)));
      li.appendChild(ch);
    }
    list.appendChild(li);
  });

  const escWrap = $("#alerts-escalations");
  escWrap.innerHTML = "";
  (v.escalations || []).forEach((e) => {
    const card = el("div", "escalation-card");
    card.innerHTML = `<strong>${e.name}</strong> — ${e.why}<br>${e.actions.join(" · ")}`;
    escWrap.appendChild(card);
  });
}

/* =============================================================================
 * TIMELINE (Req 4 / §5.6)
 * ========================================================================== */
function buildTimelineTrack(): void {
  const track = $("#timeline-track");
  track.innerHTML = "";
  data.timeline!.steps.forEach(() => track.appendChild(el("span", "step")));
  updateTimelineTrack();
}
function updateTimelineTrack(): void {
  const steps = $("#timeline-track").children;
  for (let i = 0; i < steps.length; i++) {
    steps[i].className =
      "step" +
      (i < state.timelineStep ? " is-done" : i === state.timelineStep ? " is-current" : "");
  }
}

const PHASE_LABEL: Record<Phase, string> = {
  pre_storm: "Pre-storm",
  storm: "Storm peak",
  outage: "Outage",
  assessing: "Assessing damage",
  repairing: "Crews repairing",
  restored: "Power restored",
};

function applyMapPhase(step: TimelineStep | null): void {
  const phase = step ? step.phase : null;
  const wrap = $("#map-wrap");
  const badge = $("#map-phase");

  // default (no storm running)
  if (!phase) {
    wrap.removeAttribute("data-phase");
    badge.hidden = true;
    if (circuitLayer)
      circuitLayer.setStyle({ color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 });
    if (pinLayer) pinLayer.setIcon(makePinIcon("normal"));
    if (heatLayer && map && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
    return;
  }

  // weather tint + rain
  wrap.setAttribute("data-phase", phase);

  // phase badge
  badge.hidden = false;
  badge.innerHTML =
    `<span class="map-phase__dot"></span>${PHASE_LABEL[phase] || phase}` +
    `<span class="map-phase__t">${step!.t}</span>`;

  // pin state
  const pinState: PinState =
    phase === "restored"
      ? "restored"
      : (["outage", "assessing", "repairing"] as Phase[]).includes(phase)
        ? "out"
        : "normal";
  if (pinLayer) pinLayer.setIcon(makePinIcon(pinState));

  // circuit recolor
  if (circuitLayer) {
    if (phase === "restored") {
      circuitLayer.setStyle({ color: "#4ade80", weight: 3, fillColor: "#16a34a", fillOpacity: 0.14 });
    } else if ((["outage", "assessing", "repairing"] as Phase[]).includes(phase)) {
      circuitLayer.setStyle({ color: "#fbbf24", weight: 3, fillColor: "#b45309", fillOpacity: 0.14 });
    } else {
      circuitLayer.setStyle({ color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 });
    }
  }

  // damage heat: hidden before/at the peak, deposited once reports arrive
  if (heatLayer && map) {
    const showHeat = (["outage", "assessing", "repairing", "restored"] as Phase[]).includes(phase);
    if (showHeat && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
    if (!showHeat && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
  }
}

function stepStorm(): void {
  if (state.timelineStep >= data.timeline!.steps.length - 1) {
    stopPlay();
    return;
  }
  state.timelineStep++;
  const step = data.timeline!.steps[state.timelineStep];
  updateTimelineTrack();

  const now = $("#timeline-now");
  now.innerHTML =
    `<strong>${step.t}</strong> — ${step.title}` +
    (step.confirmed_event ? `<span class="confirmed">${step.confirmed_event.label}</span>` : "");

  if (step.restoration) {
    $("#rest-range").textContent =
      `Likely ${Math.round(step.restoration.p10)}–${Math.round(step.restoration.p90)} hours ` +
      `(most likely about ${Math.round(step.restoration.p50)})`;
    $("#rest-confidence").textContent = `${step.restoration.label} · updated at ${step.t}`;
  }
  if (step.risk) {
    const badge = $("#risk-band");
    badge.textContent = `${step.risk.band} risk`;
    badge.className = "band-badge " + (BAND_CLASS[step.risk.band] || "");
    $("#risk-prob").textContent = `about ${Math.round(step.risk.probability * 100)}%`;
  }

  if (step.message) addNotification(step.message, step.t);

  applyMapPhase(step);
}

function addNotification(message: NonNullable<TimelineStep["message"]>, t: string): void {
  const feed = $("#notifications");
  if (feed.querySelector(".muted")) feed.innerHTML = "";
  const li = el("li", "msg");
  const meta = el("div", "msg-meta");
  meta.appendChild(el("span", "msg-type", message.type.replace(/_/g, " ")));
  (message.channel || []).forEach((c) => meta.appendChild(el("span", "tag", c.toUpperCase())));
  meta.appendChild(el("span", "muted", t));
  li.appendChild(meta);
  li.appendChild(el("div", null, message.text));
  feed.prepend(li);
}

function playStorm(): void {
  if (state.playTimer) {
    stopPlay();
    return;
  }
  $("#play-storm").textContent = "⏸ Pause";
  stepStorm();
  state.playTimer = setInterval(() => {
    stepStorm();
    if (state.timelineStep >= data.timeline!.steps.length - 1) stopPlay();
  }, 1600);
}
function stopPlay(): void {
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  $("#play-storm").textContent = "▶ Play storm";
}
function resetStorm(): void {
  stopPlay();
  state.timelineStep = -1;
  updateTimelineTrack();
  $("#timeline-now").textContent = "Press play to simulate the storm on the map.";
  $("#notifications").innerHTML = '<li class="muted">Messages appear as the storm plays.</li>';
  applyMapPhase(null);
  renderRisk();
  renderRestoration({ silent: true });
}

/* =============================================================================
 * CHAT (Req 5) — intent matcher over the sample exchanges + tool-style replies
 * ========================================================================== */
function seedChat(): void {
  addBubble(
    "bot",
    "Hi! Ask me about your outage risk, restoration time, how to prepare, or alerts. I only use this session's data."
  );
}
function buildChatSuggestions(): void {
  const wrap = $("#chat-suggestions");
  const prompts = [
    "Will I lose power?",
    "How long would it take to get power back?",
    "What if more crews come?",
    "What should I do to prepare?",
    "Who else on my street has life support equipment?",
  ];
  prompts.forEach((p) => {
    const b = el("button", null, p);
    b.type = "button";
    b.addEventListener("click", () => handleChat(p));
    wrap.appendChild(b);
  });
}

interface BubbleOpts {
  tools?: string[];
  emergency?: boolean;
}
/** Render **bold** and line breaks from model replies using text nodes only (no innerHTML). */
function appendFormatted(target: HTMLElement, text: string): void {
  text.split("\n").forEach((rawLine, i) => {
    if (i > 0) target.appendChild(document.createElement("br"));
    const line = rawLine.replace(/^\s*#{1,6}\s*/, ""); // drop markdown heading markers
    line.split("**").forEach((part, j) => {
      if (!part) return;
      if (j % 2 === 1) {
        const s = document.createElement("strong");
        s.textContent = part;
        target.appendChild(s);
      } else target.appendChild(document.createTextNode(part));
    });
  });
}

function addBubble(role: "user" | "bot", text: string, opts: BubbleOpts = {}): HTMLElement {
  const log = $("#chat-log");
  // full class names written out so Tailwind keeps these rules (it can't see `bubble--${...}`)
  const variant =
    role === "user" ? "bubble--user" : opts.emergency ? "bubble--emergency" : "bubble--bot";
  const b = el("div", `bubble ${variant}`);
  appendFormatted(b, text);
  if (opts.tools && opts.tools.length) {
    const t = el("span", "tools");
    t.textContent = `tools used: ${opts.tools.join(", ")}`;
    b.appendChild(t);
  }
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
  return b;
}

function matchExample(q: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const nq = norm(q);
  const examples = data.chat!.examples;
  let ex = examples.find((e) => norm(e.user) === nq);
  if (ex) return ex;
  if (/life support|neighbou?r|someone else|other customer|my street/.test(nq))
    return examples.find((e) => e.tools_called.length === 0 && !e.emergency);
  if (/chest pain|911|emergency|downed line|fire|hurt/.test(nq))
    return examples.find((e) => e.emergency);
  if (/more crew|what if|what changed|extra crew/.test(nq))
    return examples.find((e) => e.tools_called.includes("compare_scenarios"));
  if (/how long|restoration|power back|get power/.test(nq))
    return examples.find((e) => e.tools_called.includes("estimate_restoration"));
  if (/lose power|risk|will i/.test(nq))
    return examples.find((e) => e.tools_called.includes("get_outage_risk"));
  return null;
}

let chatBusy = false;

async function handleChat(q: string): Promise<void> {
  if (chatBusy) return;
  chatBusy = true;
  addBubble("user", q);
  const typing = addBubble("bot", "Thinking…");
  typing.classList.add("bubble--typing");
  try {
    // live: Amazon Nova with this tab's private conversation memory
    const r = await sendChat(q, state.premiseId);
    typing.remove();
    addBubble("bot", r.reply, { tools: r.tools_used, emergency: r.emergency });
    return;
  } catch {
    typing.remove(); // backend or model unavailable: fall back to the sample answers below
  } finally {
    chatBusy = false;
  }
  const ex = matchExample(q);
  if (ex) {
    addBubble("bot", ex.assistant, { tools: ex.tools_called, emergency: ex.emergency });
  } else {
    addBubble(
      "bot",
      "I can answer about your outage risk, restoration time, how to prepare, or alerts. Try one of the suggested questions. I only state numbers that come from the model's tools."
    );
  }
}

/* =============================================================================
 * CONTROLS WIRING
 * ========================================================================== */
function wireControls(): void {
  // Severity (risk)
  const sev = $<HTMLInputElement>("#severity");
  sev.addEventListener("input", () => {
    state.severity = SEVERITIES[Number(sev.value)];
    state.scenario.storm_severity = state.severity;
    $("#severity-value").textContent = SEVERITY_LABELS[state.severity];
    const prevP50 = state.lastRestoration ? state.lastRestoration.p50 : null;
    renderRisk();
    renderRestoration({
      changeLabel: `Storm severity: ${state.scenario.storm_severity.toFixed(1)}×`,
      silent: prevP50 === null,
    });
  });

  // Crews
  const crews = $<HTMLInputElement>("#crews");
  crews.addEventListener("input", () => {
    $("#crews-value").textContent = crews.value;
  });
  crews.addEventListener("change", () => {
    const old = state.scenario.crews;
    state.scenario.crews = Number(crews.value);
    renderRestoration({ changeLabel: `Crews: ${old} → ${crews.value}` });
  });

  // Access segmented control
  document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");
      const old = state.scenario.access;
      const next = (btn.dataset.access || "auto") as Scenario["access"];
      state.scenario.access = next;
      renderRestoration({ changeLabel: `Access: ${labelAccess(old)} → ${labelAccess(next)}` });
    });
  });

  // Switching
  $<HTMLInputElement>("#switching").addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    state.scenario.switching_available = checked;
    renderRestoration({ changeLabel: `Switching available: ${checked ? "off → on" : "on → off"}` });
  });

  // Prioritize critical
  $<HTMLInputElement>("#critical").addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    state.scenario.prioritize_critical = checked;
    renderRestoration({ changeLabel: `Prioritize critical: ${checked ? "off → on" : "on → off"}` });
  });

  // Failed upstream fuse
  $<HTMLInputElement>("#failed-fuse").addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const old = state.scenario.failed_upstream_device;
    state.scenario.failed_upstream_device = checked ? "fuse" : null;
    renderRestoration({ changeLabel: `Upstream device failed: ${old ? "fuse → none" : "none → your fuse"}` });
  });

  // Reset scenario
  $("#reset-scenario").addEventListener("click", resetScenario);

  // Prepare — medical toggle
  $<HTMLInputElement>("#medical").addEventListener("change", (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    state.declaredNeeds = checked ? ["medical_equipment"] : [];
    renderGuidance();
    renderAlerts();
    toast(checked ? "Medical needs on — guidance & alerts updated" : "Medical needs cleared");
  });

  // Timeline
  $("#play-storm").addEventListener("click", playStorm);
  $("#step-storm").addEventListener("click", () => {
    stopPlay();
    stepStorm();
  });
  $("#reset-storm").addEventListener("click", resetStorm);

  // Chat
  $<HTMLFormElement>("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>("#chat-input");
    const q = inp.value.trim();
    if (!q) return;
    handleChat(q);
    inp.value = "";
  });

  // Assumptions modal
  $("#open-assumptions").addEventListener("click", () => ($("#assumptions-modal").hidden = false));
  $("#close-assumptions").addEventListener("click", () => ($("#assumptions-modal").hidden = true));
  $("#assumptions-modal").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "assumptions-modal")
      $("#assumptions-modal").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#assumptions-modal").hidden = true;
  });

  // Clear my data
  $("#clear-data").addEventListener("click", clearMyData);
}

function labelAccess(a: Scenario["access"]): string {
  return a === "auto" ? "Auto" : a === "on" ? "Force on" : "Force off";
}

function resetScenario(): void {
  state.scenario = {
    crews: 2,
    storm_severity: 1.0,
    access: "auto",
    switching_available: true,
    failed_upstream_device: null,
    prioritize_critical: true,
    start_delay_h: 6,
  };
  state.severity = 1.0;

  $<HTMLInputElement>("#crews").value = "2";
  $("#crews-value").textContent = "2";
  $<HTMLInputElement>("#severity").value = "1";
  $("#severity-value").textContent = SEVERITY_LABELS[1.0];
  $<HTMLInputElement>("#switching").checked = true;
  $<HTMLInputElement>("#critical").checked = true;
  $<HTMLInputElement>("#failed-fuse").checked = false;
  document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) => {
    const on = b.dataset.access === "auto";
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });

  prevRisk = null;
  state.lastRestoration = null;
  $("#rest-delta").hidden = true;
  $("#risk-delta").hidden = true;
  renderRisk();
  renderRestoration({ silent: true });
  toast("Scenario reset to defaults");
}

function clearMyData(): void {
  stopPlay();
  state.declaredNeeds = [];
  state.history = [];
  $<HTMLInputElement>("#medical").checked = false;
  pushHistory();
  resetScenario();
  resetStorm();
  $("#chat-log").innerHTML = "";
  void endChat();
  seedChat();
  toast("Your session data has been cleared.");
}

/* =============================================================================
 * ASSUMPTIONS PANEL
 * ========================================================================== */
function renderAssumptions(): void {
  const ul = $("#assumptions-list");
  ul.innerHTML = "";
  data.assumptions!.items.forEach((item) => ul.appendChild(el("li", null, item)));
}

/* go */
boot();
