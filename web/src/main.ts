/* =============================================================================
 * AI Outage Concierge — dashboard (mock-data build), TypeScript + Tailwind.
 *
 * Reads the sample JSON in ../mock/api/*. Every shape here matches MVP plan §7
 * (see types.ts), so swapping the mock fetch for the real endpoint is the only
 * change needed when the backend exists.
 *
 * NOTE: all figures are illustrative sample data, never model output.
 * ========================================================================== */

import "./styles.css";
import {
  initMap as initMap3D,
  flyToPremise,
  flyToOverview,
  setPowerPath,
  setRiskHeat,
  setPhaseVisuals,
  resizeMap,
} from "./map3d";
import type { Color } from "@deck.gl/core";
import { $, el, getJSON, toast } from "./dom";
import {
  DEFAULT_PREMISE_ID,
  apiHealthy,
  endChat,
  fetchPowerPath,
  fetchPremiseLookup,
  fetchRestorationGrid,
  fetchRiskBySeverity,
  fetchRiskHeat,
  sendChat,
} from "./api";
import type {
  AppData,
  AppState,
  Band,
  GridRow,
  Phase,
  PowerPath,
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
  powerPath: null,
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

/* whether the live backend answered at boot (reused for later premise fetches) */
let apiLive = false;

/* Risk and restoration for one premise from the trained models (live API).
 * Keeps whatever is loaded (mock or the previous premise) if the call fails. */
async function loadModelOutput(premiseId: string): Promise<void> {
  if (!apiLive) return;
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

/* ---------------------------------------------------------------------------
 * Load a premise's power path: live backend first, mock sample otherwise.
 * The mock is a single premise, so we only serve it for that id and skip the
 * graphic for other demo premises when offline (rather than show a wrong path).
 * ------------------------------------------------------------------------- */
async function loadPowerPath(
  premiseId: string,
  live: boolean,
  severity = 1.0
): Promise<PowerPath | null> {
  if (live) {
    try {
      return await fetchPowerPath(premiseId, severity);
    } catch (err) {
      console.warn("power-path fetch failed, trying mock:", err);
    }
  }
  try {
    const mock = await getJSON<PowerPath>(API, "power_path.json");
    return mock.premise_id === premiseId ? mock : null;
  } catch {
    return null;
  }
}

/* =============================================================================
 * BOOT
 * ========================================================================== */
/* deck.gl now owns the map; see map3d.ts. We only track whether it is up. */
let mapReady = false;

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
    const live = await apiHealthy();
    apiLive = live;
    if (live) {
      try {
        data.lookup = await fetchPremiseLookup(state.premiseId);
      } catch (liveErr) {
        console.warn("Live API call failed, falling back to mock:", liveErr);
      }
    }
    if (!data.lookup) {
      data.lookup = await getJSON<AppData["lookup"]>(API, "premise_lookup.json");
    }

    // Power path for the first premise (live, else the mock sample).
    data.powerPath = await loadPowerPath(state.premiseId, live, state.severity);

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
  measureTopChrome();
  window.addEventListener("resize", measureTopChrome);
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

  // Demo dropdown: coords are already known, so selection is instant.
  sel.addEventListener("change", () => {
    const p = data.lookup!.demo_premises.find((x) => x.premise_id === sel.value);
    void selectPremise(sel.value, p ? { lat: p.lat, lon: p.lon } : null);
  });

  // Free-text ID entry: resolve the premise (live lookup / mock), then fly to it.
  const form = $<HTMLFormElement>("#premise-lookup-form");
  const input = $<HTMLInputElement>("#premise-id-input");
  input.value = state.premiseId;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = input.value.trim();
    if (!id) return;
    void selectPremise(id);
  });
}

/* ---------------------------------------------------------------------------
 * Select a premise by id and move the map to it.
 *
 * If coords are supplied (demo dropdown) we fly straight there. Otherwise we
 * resolve the premise: the live backend's lookup when available, else the demo
 * list / mock. Unknown ids surface a toast rather than silently doing nothing.
 * ------------------------------------------------------------------------- */
async function selectPremise(
  id: string,
  coords: { lat: number; lon: number } | null = null
): Promise<void> {
  // Resolve coordinates if we weren't given them.
  if (!coords) {
    // already in the demo list?
    const demo = data.lookup!.demo_premises.find((x) => x.premise_id === id);
    if (demo) {
      coords = { lat: demo.lat, lon: demo.lon };
    } else if (apiLive) {
      try {
        const look = await fetchPremiseLookup(id);
        coords = { lat: look.lat, lon: look.lon };
        // adopt the richer lookup so area label / service type update too
        data.lookup = look;
        $("#area-label").textContent = `${look.area_label} · live API`;
      } catch {
        toast(`Premise ${id} not found`);
        return;
      }
    } else {
      // offline: only the mock premise is known
      const mock = data.lookup!;
      if (mock.premise_id === id) {
        coords = { lat: mock.lat, lon: mock.lon };
      } else {
        toast(`Premise ${id} isn't in the sample data (backend offline)`);
        return;
      }
    }
  }

  state.premiseId = id;
  const sel = $<HTMLSelectElement>("#premise-select");
  if (sel.value !== id) sel.value = id; // keep dropdown in sync when possible
  $<HTMLInputElement>("#premise-id-input").value = id;

  if (coords) {
    data.lookup!.lat = coords.lat;
    data.lookup!.lon = coords.lon;
  }

  await loadModelOutput(id);
  renderRisk();
  renderRestoration({ silent: true });

  // refresh the power-path graphic for the newly selected home
  const pp = await loadPowerPath(state.premiseId, apiLive, state.severity);
  data.powerPath = pp;
  if (mapReady) setPowerPath(pp, state.premiseId);

  // Fly the 3D camera down from the overview hex field to this home. The pin
  // and power path are revealed as the heat fades back.
  if (coords && mapReady) {
    flyToPremise(coords.lat, coords.lon, state.premiseId, {
      label: data.lookup!.area_label,
      service: data.lookup!.service_type,
    });
  }

  toast(`Showing premise ${id}`);
}

/* =============================================================================
 * MAP — now a pitched 3D deck.gl scene (see map3d.ts). On load it shows the
 * predicted-risk heat (trained model) over the circuit; entering a premise id
 * flies the camera down to that home and reveals its pin + power path. This
 * function just hands the loaded data to the map module and wires the legend.
 * ========================================================================== */
/* (Re)load the predicted-risk heat for the current storm severity. Live backend
 * only; offline the map simply shows no heat. */
function loadRiskHeat(): void {
  if (!apiLive) return;
  const sev = state.severity;
  fetchRiskHeat(sev)
    .then((h) => {
      if (sev !== state.severity) return; // slider moved again meanwhile
      data.heat = h;
      if (mapReady) setRiskHeat(h);
    })
    .catch((err) => console.warn("risk heat fetch failed:", err));
}

function initMap(): void {
  const { lat, lon } = data.lookup!;
  initMap3D({
    container: "map",
    lat,
    lon,
    heat: data.heat,
    circuit: (data.circuit as GeoJSON.GeoJsonObject) ?? null,
    home: {
      lat,
      lon,
      label: data.lookup!.area_label,
      service: data.lookup!.service_type,
    },
    powerPath: data.powerPath,
    premiseId: state.premiseId,
  });
  mapReady = true;
  renderPathLegend();
  loadRiskHeat();
}

/* =============================================================================
 * POWER-PATH LEGEND (the colour key shown over the map).
 *
 * The path geometry itself is drawn by deck.gl in map3d.ts; this is just the
 * static HTML legend that used to be a Leaflet control. It lives in the
 * #pp-legend-host overlay inside the map wrap.
 * ========================================================================== */
const PATH_BAND_COLOR: Record<Band, string> = {
  Low: "#22c55e",
  Moderate: "#facc15",
  High: "#f97316",
  "Very High": "#ef4444",
};

function renderPathLegend(): void {
  const host = $("#pp-legend-host", false);
  if (!host) return;
  const pp = data.powerPath;
  const headline =
    pp && pp.home_probability != null
      ? `<div class="pp-legend__home"><strong>Your power path</strong><br>` +
        `whole-home risk ~${Math.round(pp.home_probability * 100)}%` +
        (pp.home_band ? ` (${pp.home_band})` : "") +
        `</div>`
      : `<div class="pp-legend__home"><strong>Your power path</strong></div>`;
  const rows = (["Low", "Moderate", "High", "Very High"] as Band[])
    .map(
      (b) =>
        `<span class="pp-legend__row"><i style="background:${PATH_BAND_COLOR[b]}"></i>${b}</span>`
    )
    .join("");
  const note =
    pp && pp.coverage === "fallback"
      ? `We couldn't find the full equipment chain for this home, so this is the known part of the path to the substation.`
      : `Each node is equipment on your home's path to the substation.`;
  host.innerHTML =
    headline + `<div class="pp-legend__scale">${rows}</div>` + `<div class="pp-legend__note">${note}</div>`;
}

/* Measure the fixed top chrome (masthead + title strip) and expose it as the
 * --top-chrome CSS var so the map and chat panels can fill the rest of the
 * viewport on load. Recomputed on resize. */
function measureTopChrome(): void {
  const header = document.querySelector("header");
  const title = document.querySelector(".page-title");
  const headerH = header ? header.getBoundingClientRect().height : 0;
  const titleH = title ? title.getBoundingClientRect().height : 0;
  const root = document.documentElement.style;
  root.setProperty("--top-chrome", `${Math.round(headerH + titleH)}px`);
  // The masthead is sticky, so the chat panel pins just below it (never hidden
  // behind it). Expose its height for the chat's sticky offset + height.
  root.setProperty("--masthead-h", `${Math.round(headerH)}px`);
  if (mapReady) setTimeout(() => resizeMap(), 50);
}

type PinState = "normal" | "out" | "restored";

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
  v.checklist.forEach((c, i) => {
    const li = el("li", "checklist__item");
    const label = el("label", "checklist__label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "checklist__box";
    box.id = `prep-check-${i}`;
    box.addEventListener("change", () => {
      li.classList.toggle("is-checked", box.checked);
    });
    label.htmlFor = box.id;
    label.appendChild(box);
    label.appendChild(el("span", "checklist__text", c));
    li.appendChild(label);
    cl.appendChild(li);
  });
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
    if (mapReady)
      setPhaseVisuals({ pin: "normal", circuit: [255, 90, 82], showHeat: true });
    return;
  }

  // weather tint + rain
  wrap.setAttribute("data-phase", phase);

  // phase badge
  badge.hidden = false;
  badge.innerHTML =
    `<span class="map-phase__dot"></span>${PHASE_LABEL[phase] || phase}` +
    `<span class="map-phase__t">${step!.t}</span>`;

  const outagePhases = ["outage", "assessing", "repairing"] as Phase[];

  // pin state
  const pinState: PinState =
    phase === "restored" ? "restored" : outagePhases.includes(phase) ? "out" : "normal";

  // circuit recolor (RGB for deck.gl)
  const circuitColor: Color =
    phase === "restored"
      ? [74, 222, 128]
      : outagePhases.includes(phase)
        ? [251, 191, 36]
        : [255, 90, 82];

  // damage heat: hidden before/at the peak, deposited once reports arrive
  const showHeat = ([...outagePhases, "restored"] as Phase[]).includes(phase);

  if (mapReady) setPhaseVisuals({ pin: pinState, circuit: circuitColor, showHeat });
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
    // Recolour the power path for the new severity (live backend only; the mock
    // sample has a single severity so there is nothing to refetch). Keep the
    // current view — the user is adjusting the storm, not changing homes.
    if (apiLive) {
      void loadPowerPath(state.premiseId, apiLive, state.severity).then((pp) => {
        data.powerPath = pp;
        if (mapReady) setPowerPath(pp, state.premiseId);
        renderPathLegend();
      });
      loadRiskHeat(); // area risk changes with storm strength too
    }
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
  // Pull the camera back out to the 3D overview hex field.
  if (mapReady) flyToOverview();
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
