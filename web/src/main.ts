/* =============================================================================
 * AI Outage Concierge — dashboard, TypeScript + Tailwind.
 *
 * Everything shown comes from the backend (backend/app): the cleaned AEP data,
 * the trained models (risk, damage, restoration simulator) and the guidance /
 * alert / storm-replay rules built on their output. No sample data is used.
 * ========================================================================== */

import "./styles.css";
import {
  initMap as initMap3D,
  flyToPremise,
  flyToOverview,
  setPowerPath,
  setPhaseVisuals,
  resizeMap,
} from "./map3d";
import type { Color } from "@deck.gl/core";
import { $, el, toast } from "./dom";
import {
  DEFAULT_PREMISE_ID,
  apiHealthy,
  endChat,
  fetchAlerts,
  fetchAssumptions,
  fetchCircuitOutline,
  fetchDamageHeat,
  fetchGuidance,
  fetchPowerPath,
  fetchPremiseLookup,
  fetchRestorationGrid,
  fetchRiskBySeverity,
  fetchTimeline,
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

/* Severity slider index -> storm severity multiplier (1.0 = like Feb 2025). */
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

/* Data loaded from the backend (cleaned data + model output); no sample data. */
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

/* Everything the panels show for one premise, from the backend: risk (models),
 * restoration (simulator), guidance + alerts (rules on that output) and the storm
 * replay (model estimates + real Feb 2025 damage on this home's path). Homes with
 * no equipment chain get the risk fallback and no personal restoration grid. */
async function loadModelOutput(premiseId: string): Promise<void> {
  if (!apiLive) return;
  try {
    const [risk, guidance, alerts, timeline] = await Promise.all([
      fetchRiskBySeverity(premiseId),
      fetchGuidance(premiseId),
      fetchAlerts(premiseId),
      fetchTimeline(premiseId),
    ]);
    Object.assign(data, { riskBySeverity: risk, guidance, alerts, timeline });
    data.grid = await fetchRestorationGrid(premiseId).catch(() => ({ start_delay_h: 6, results: [] }));
  } catch (err) {
    console.warn("Model output unavailable:", err);
    toast("Couldn't load estimates for this home");
  }
}

/* A premise's power path from the backend (null if it has no chain or the call fails). */
async function loadPowerPath(
  premiseId: string,
  live: boolean,
  severity = 1.0
): Promise<PowerPath | null> {
  if (!live) return null;
  try {
    return await fetchPowerPath(premiseId, severity);
  } catch (err) {
    console.warn("power-path fetch failed:", err);
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
    // Everything comes from the backend: cleaned data, model output and the
    // rules built on it. Without it there is nothing honest to show.
    apiLive = await apiHealthy();
    if (!apiLive) throw new Error("The backend API is not reachable.");
    [data.lookup, data.heat, data.assumptions] = await Promise.all([
      fetchPremiseLookup(state.premiseId),
      fetchDamageHeat("feb2025"),
      fetchAssumptions(),
    ]);
    data.circuit = await fetchCircuitOutline(data.lookup.circuit_id);
    data.powerPath = await loadPowerPath(state.premiseId, apiLive, state.severity);

    // Keep state in sync with whatever premise the lookup settled on.
    state.premiseId = data.lookup!.premise_id;
    await loadModelOutput(state.premiseId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    document.body.innerHTML =
      `<p style="padding:2rem;font-family:sans-serif">Could not load data. ` +
      `Start the backend (<code>uv run uvicorn app.main:app --port 8000</code> in backend/) ` +
      `and reload.<br><br>${msg}</p>`;
    return;
  }

  $("#area-label").textContent = `${data.lookup!.area_label} · live API`;

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

  // Free-text ID entry: resolve the premise (live lookup), then fly to it.
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
 * list. Unknown ids surface a toast rather than silently doing nothing.
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
      toast("The backend is not reachable");
      return;
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
 * extruded damage-hexbin heatmap over the circuit; entering a premise id flies
 * the camera down to that home and reveals its pin + power path. This function
 * just hands the loaded data to the map module and wires the legend.
 * ========================================================================== */
function initMap(): void {
  const { lat, lon } = data.lookup!;
  initMap3D({
    container: "map",
    lat,
    lon,
    heat: data.heat!,
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
      (r && r.fallback && r.fallback.message) ||
      "We can't give a reliable outage estimate for your location. Here is general storm guidance instead.";
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
 * RESTORATION (Req 2) — the simulator's grid for this home (all slider combinations)
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
  // the restoration simulator's drivers and repair queue for this home
  const drivers = data.grid!.drivers ?? [];
  const jobs = data.grid!.jobs_ahead_of_you ?? [];

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
  return medical ? "medical" : "no-needs";
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
  // clear only the "Messages appear…" placeholder, not earlier messages (their time tag is .muted too)
  if (feed.querySelector(":scope > li.muted")) feed.innerHTML = "";
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
  } catch {
    typing.remove();
    addBubble(
      "bot",
      "The assistant is unavailable right now. Your risk, restoration estimate, checklist and alerts are still shown on this page. In an emergency, call 911."
    );
  } finally {
    chatBusy = false;
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
