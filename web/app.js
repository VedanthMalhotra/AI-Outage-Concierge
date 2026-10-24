/* =============================================================================
 * AI Outage Concierge — dashboard (mock-data build)
 *
 * Reads the sample JSON in ../mock/api/*. Every shape here matches MVP plan §7,
 * so swapping fetch('../mock/api/x.json') for the real endpoint is the only
 * change needed when the backend exists.
 *
 * NOTE: all figures are illustrative sample data, never model output.
 * ========================================================================== */

const API = "../mock/api";

/* Severity slider index -> multiplier used by the mock files. */
const SEVERITIES = [0.5, 1.0, 1.5, 2.0];
const SEVERITY_LABELS = {
  0.5: "Minor (0.5×)",
  1.0: "Feb-2025-like (1.0×)",
  1.5: "Severe (1.5×)",
  2.0: "Extreme (2.0×)",
};

/* Band -> css modifier + plain-text so colour is never used alone. */
const BAND_CLASS = {
  Low: "band-low",
  Moderate: "band-moderate",
  High: "band-high",
  "Very High": "band-veryhigh",
};

/* ---------------------------------------------------------------------------
 * Global state (session only — mirrors the privacy promise in the footer).
 * ------------------------------------------------------------------------- */
const state = {
  premiseId: "858810648",
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
  lastRestoration: null, // last P10/P50/P90 for before/after notes
  history: [],
  timelineStep: -1,
  playTimer: null,
};

/* Loaded mock data caches */
const data = {
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

/* small DOM helpers */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
async function getJSON(name) {
  const res = await fetch(`${API}/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

/* =============================================================================
 * BOOT
 * ========================================================================== */
let map, pinLayer, circuitLayer, heatLayer;

async function boot() {
  try {
    [
      data.lookup,
      data.circuit,
      data.heat,
      data.riskBySeverity,
      data.riskFallback,
      data.grid,
      data.guidance,
      data.alerts,
      data.timeline,
      data.chat,
      data.assumptions,
    ] = await Promise.all([
      getJSON("premise_lookup.json"),
      getJSON("circuit_area.geojson"),
      getJSON("damage_heat.json"),
      getJSON("risk_by_severity.json"),
      getJSON("risk_fallback.json"),
      getJSON("restoration_grid.json"),
      getJSON("guidance.json"),
      getJSON("alerts.json"),
      getJSON("timeline.json"),
      getJSON("chat_examples.json"),
      getJSON("assumptions.json"),
    ]);
  } catch (err) {
    document.body.innerHTML =
      `<p style="padding:2rem;font-family:sans-serif">Could not load mock data. ` +
      `Serve this folder over http (e.g. <code>python -m http.server</code>) and open ` +
      `<code>web/index.html</code>.<br><br>${err.message}</p>`;
    return;
  }

  $("#area-label").textContent = data.lookup.area_label;

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
function buildPremisePicker() {
  const sel = $("#premise-select");
  sel.innerHTML = "";
  data.lookup.demo_premises.forEach((p) => {
    const o = el("option");
    o.value = p.premise_id;
    o.textContent = `${p.premise_id} · ${p.service_type}`;
    sel.appendChild(o);
  });
  sel.value = state.premiseId;
  sel.addEventListener("change", () => {
    state.premiseId = sel.value;
    const p = data.lookup.demo_premises.find((x) => x.premise_id === sel.value);
    if (p && map) {
      pinLayer.setLatLng([p.lat, p.lon]);
      map.panTo([p.lat, p.lon]);
    }
    // In the mock, only premise 858810648 has full risk/restoration samples.
    // Other picks reuse the same shapes so the UI stays live.
    renderRisk();
    renderRestoration({ silent: true });
    toast(`Selected premise ${sel.value}`);
  });
}

/* =============================================================================
 * MAP (Leaflet) — own pin + circuit outline + aggregated damage heat only
 * ========================================================================== */
function initMap() {
  const { lat, lon } = data.lookup;
  map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: false,
    attributionControl: false,
  }).setView([lat, lon], 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);

  // Basemap: Esri World Imagery (satellite) — keyless, shows real rooftops so
  // "your home" is tangible. A light street/place label layer sits on top so
  // roads and town names stay readable over the imagery.
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
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(map);
  });

  // Circuit area (shaded). Kept on a ref so the storm can recolor it.
  circuitLayer = L.geoJSON(data.circuit, {
    style: { color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 },
  }).addTo(map);

  // Aggregated damage heat — graduated circles per ~1 km cell (never individual
  // points). Built now but NOT added to the map until damage "arrives" in the
  // storm timeline, so the storm visibly deposits damage as it plays.
  const counts = data.heat.cells.map((c) => c.count);
  const maxCount = Math.max(...counts, 1);
  heatLayer = L.layerGroup();
  data.heat.cells.forEach((c) => {
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

  // The customer's own pin (the only point we ever plot). A divIcon lets us
  // restyle it (normal / out / restored) as the storm progresses.
  pinLayer = L.marker([lat, lon], {
    title: "Your home",
    icon: makePinIcon("normal"),
  })
    .addTo(map)
    .bindPopup(`<strong>Your home</strong><br>${data.lookup.area_label}<br>Service: ${data.lookup.service_type}`);

  setTimeout(() => map.invalidateSize(), 200);
}

/* Build the home-pin icon for a given state: "normal" | "out" | "restored". */
function makePinIcon(stateName) {
  const mod = stateName === "out" ? " pin-dot--out" : stateName === "restored" ? " pin-dot--restored" : "";
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
function renderRisk() {
  const key = String(state.severity.toFixed(1)).replace(".0", ".0");
  // risk_by_severity keys are "0.5" / "1.0" / "1.5" / "2.0"
  const sevKey = state.severity === 1 ? "1.0" : state.severity === 2 ? "2.0" : String(state.severity);
  const prev = renderRisk._prev;
  const r = data.riskBySeverity[sevKey];

  const body = $("#risk-body");
  const fb = $("#risk-fallback");

  if (!r || r.fallback) {
    body.hidden = true;
    fb.hidden = false;
    $("#risk-fallback-msg").textContent = (r && r.fallback && r.fallback.message) || data.riskFallback.fallback.message;
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
  renderRisk._prev = r;
}

/* =============================================================================
 * RESTORATION (Req 2) — live via the mock lookup grid
 * ========================================================================== */
function findGridRow(sc) {
  return data.grid.results.find(
    (r) =>
      r.crews === sc.crews &&
      r.storm_severity === sc.storm_severity &&
      r.access === sc.access &&
      r.switching_available === sc.switching_available &&
      r.failed_upstream_device === sc.failed_upstream_device &&
      r.prioritize_critical === sc.prioritize_critical
  );
}

function renderRestoration({ silent = false, changeLabel = null } = {}) {
  const sc = state.scenario;
  const row = findGridRow(sc);

  const rangeEl = $("#rest-range");
  if (!row) {
    rangeEl.textContent = "No estimate for this combination.";
    return;
  }

  rangeEl.textContent = `Likely ${Math.round(row.p10)}–${Math.round(row.p90)} hours (most likely about ${Math.round(row.p50)})`;
  $("#rest-confidence").textContent = "Model estimate · Medium confidence";

  // Drivers + jobs come from the default-scenario sample (illustrative).
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

/* Pull a plausible "why" from compare_examples shapes where we can, else a rule. */
function whyFor(changeLabel, prev, now) {
  const grew = now.p50 > prev.p50;
  if (changeLabel.startsWith("Crews")) {
    return grew
      ? "Fewer crews means jobs ahead of you run one after another."
      : "The jobs ahead of you in the queue can now run at the same time.";
  }
  if (changeLabel.startsWith("Access")) {
    return grew ? "Every repair job now includes extra time for restricted access." : "Repair jobs no longer carry the access delay.";
  }
  if (changeLabel.startsWith("Switching")) {
    return grew
      ? "Without switching, you wait for the damaged section downstream of your fuse to be fully repaired."
      : "Switching lets crews isolate the damaged section so your part comes back sooner.";
  }
  if (changeLabel.startsWith("Upstream")) {
    return grew ? "Your fuse must be replaced before power can return; it is now a dependency." : "Removing the upstream failure clears a dependency on your line.";
  }
  if (changeLabel.startsWith("Prioritize")) {
    return grew ? "Critical-facility jobs now jump ahead of you in the queue." : "Without critical-first ordering, your queue position improves.";
  }
  if (changeLabel.startsWith("Storm")) {
    return grew ? "More expected damage on your circuit means a longer repair queue." : "Less expected damage shortens the repair queue.";
  }
  return "";
}

function renderDriversAndJobs() {
  // Static illustrative detail from restoration.json shape (kept inline to avoid
  // an extra fetch; same fields the real POST /restoration returns).
  const drivers = [
    { text: "Number of crews: adding more crews cuts the queue time", impact_h: -6.2 },
    { text: "A broken pole on your line adds about 8 hours", impact_h: 8.0 },
  ];
  const jobs = [
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

function pushHistory(text) {
  state.history.unshift(text);
  state.history = state.history.slice(0, 5);
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
function guidanceVariantKey() {
  // The mock only ships a few variants; map current state to the closest one.
  const medical = state.declaredNeeds.includes("medical_equipment");
  return medical ? "high_4-24h_medical" : "high_4-24h_no-needs";
}

function renderGuidance() {
  const v = data.guidance.variants[guidanceVariantKey()];
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
function renderAlerts() {
  const medical = state.declaredNeeds.includes("medical_equipment");
  const v = data.alerts.variants[medical ? "medical" : "no-needs"];

  const chip = $("#alerts-eligible");
  chip.textContent = v.eligible ? "Eligible ✓" : "Not eligible";
  chip.classList.toggle("is-no", !v.eligible);

  const list = $("#alerts-rules");
  list.innerHTML = "";
  v.rules.forEach((rule) => {
    const li = el("li");
    const statusTxt = rule.met === true ? "✓ Active" : rule.met === false ? "— Not met" : "• Conditional";
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
function buildTimelineTrack() {
  const track = $("#timeline-track");
  track.innerHTML = "";
  data.timeline.steps.forEach(() => track.appendChild(el("span", "step")));
  updateTimelineTrack();
}
function updateTimelineTrack() {
  const steps = $("#timeline-track").children;
  for (let i = 0; i < steps.length; i++) {
    steps[i].className =
      "step" + (i < state.timelineStep ? " is-done" : i === state.timelineStep ? " is-current" : "");
  }
}

/* ---------------------------------------------------------------------------
 * Drive the MAP visuals from the current timeline step.
 *   - weather tint + rain via data-phase on .map-wrap
 *   - phase badge (top-left)
 *   - home pin state (normal -> out -> restored)
 *   - circuit outline recolor
 *   - damage heat revealed when damage arrives
 * ------------------------------------------------------------------------- */
const PHASE_LABEL = {
  pre_storm: "Pre-storm",
  storm: "Storm peak",
  outage: "Outage",
  assessing: "Assessing damage",
  repairing: "Crews repairing",
  restored: "Power restored",
};

function applyMapPhase(step) {
  const phase = step ? step.phase : null;
  const wrap = $("#map-wrap");
  const badge = $("#map-phase");

  // default (no storm running)
  if (!phase) {
    wrap.removeAttribute("data-phase");
    badge.hidden = true;
    if (circuitLayer) circuitLayer.setStyle({ color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 });
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
    `<span class="map-phase__t">${step.t}</span>`;

  // pin state
  const pinState =
    phase === "restored" ? "restored" : ["outage", "assessing", "repairing"].includes(phase) ? "out" : "normal";
  if (pinLayer) pinLayer.setIcon(makePinIcon(pinState));

  // circuit recolor: amber while out, green once restored, red otherwise
  if (circuitLayer) {
    if (phase === "restored") {
      circuitLayer.setStyle({ color: "#4ade80", weight: 3, fillColor: "#16a34a", fillOpacity: 0.14 });
    } else if (["outage", "assessing", "repairing"].includes(phase)) {
      circuitLayer.setStyle({ color: "#fbbf24", weight: 3, fillColor: "#b45309", fillOpacity: 0.14 });
    } else {
      circuitLayer.setStyle({ color: "#ff5a52", weight: 3, fillColor: "#c22823", fillOpacity: 0.12 });
    }
  }

  // damage heat: hidden before/at the peak, deposited once reports arrive
  if (heatLayer && map) {
    const showHeat = ["outage", "assessing", "repairing", "restored"].includes(phase);
    if (showHeat && !map.hasLayer(heatLayer)) heatLayer.addTo(map);
    if (!showHeat && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
  }
}

function stepStorm() {
  if (state.timelineStep >= data.timeline.steps.length - 1) {
    stopPlay();
    return;
  }
  state.timelineStep++;
  const step = data.timeline.steps[state.timelineStep];
  updateTimelineTrack();

  // Update the "now" line
  const now = $("#timeline-now");
  now.innerHTML =
    `<strong>${step.t}</strong> — ${step.title}` +
    (step.confirmed_event ? `<span class="confirmed">${step.confirmed_event.label}</span>` : "");

  // Reflect risk/restoration updates on the cards where present
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

  // Push any message into the notifications feed
  if (step.message) addNotification(step.message, step.t);

  // Drive the map visuals for this phase
  applyMapPhase(step);
}

function addNotification(message, t) {
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

function playStorm() {
  if (state.playTimer) {
    stopPlay();
    return;
  }
  $("#play-storm").textContent = "⏸ Pause";
  stepStorm();
  state.playTimer = setInterval(() => {
    stepStorm();
    if (state.timelineStep >= data.timeline.steps.length - 1) stopPlay();
  }, 1600);
}
function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  $("#play-storm").textContent = "▶ Play storm";
}
function resetStorm() {
  stopPlay();
  state.timelineStep = -1;
  updateTimelineTrack();
  $("#timeline-now").textContent = "Press play to simulate the storm on the map.";
  $("#notifications").innerHTML = '<li class="muted">Messages appear as the storm plays.</li>';
  applyMapPhase(null); // clear weather tint, badge, pin/circuit/heat state
  renderRisk();
  renderRestoration({ silent: true });
}

/* =============================================================================
 * CHAT (Req 5) — intent matcher over the sample exchanges + tool-style replies
 * ========================================================================== */
function seedChat() {
  addBubble("bot", "Hi! Ask me about your outage risk, restoration time, how to prepare, or alerts. I only use this session's data.");
}
function buildChatSuggestions() {
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

function addBubble(role, text, opts = {}) {
  const log = $("#chat-log");
  const b = el("div", `bubble bubble--${role === "user" ? "user" : opts.emergency ? "emergency" : "bot"}`);
  b.appendChild(document.createTextNode(text));
  if (opts.tools && opts.tools.length) {
    b.appendChild(el("span", "tools", `tools used: ${opts.tools.join(", ")}`));
  }
  log.appendChild(b);
  log.scrollTop = log.scrollHeight;
}

function matchExample(q) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const nq = norm(q);
  // exact-ish match first
  let ex = data.chat.examples.find((e) => norm(e.user) === nq);
  if (ex) return ex;
  // keyword routing
  if (/life support|neighbou?r|someone else|other customer|my street/.test(nq))
    return data.chat.examples.find((e) => e.tools_called.length === 0 && !e.emergency);
  if (/chest pain|911|emergency|downed line|fire|hurt/.test(nq))
    return data.chat.examples.find((e) => e.emergency);
  if (/more crew|what if|what changed|extra crew/.test(nq))
    return data.chat.examples.find((e) => e.tools_called.includes("compare_scenarios"));
  if (/how long|restoration|power back|get power/.test(nq))
    return data.chat.examples.find((e) => e.tools_called.includes("estimate_restoration"));
  if (/lose power|risk|will i/.test(nq))
    return data.chat.examples.find((e) => e.tools_called.includes("get_outage_risk"));
  return null;
}

function handleChat(q) {
  addBubble("user", q);
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
function wireControls() {
  // Severity (risk)
  const sev = $("#severity");
  sev.addEventListener("input", () => {
    state.severity = SEVERITIES[Number(sev.value)];
    state.scenario.storm_severity = state.severity;
    $("#severity-value").textContent = SEVERITY_LABELS[state.severity];
    const prevP50 = state.lastRestoration ? state.lastRestoration.p50 : null;
    renderRisk();
    renderRestoration({ changeLabel: `Storm severity: ${(state.scenario.storm_severity).toFixed(1)}×`, silent: prevP50 === null });
  });

  // Crews
  const crews = $("#crews");
  crews.addEventListener("input", () => {
    $("#crews-value").textContent = crews.value;
  });
  crews.addEventListener("change", () => {
    const old = state.scenario.crews;
    state.scenario.crews = Number(crews.value);
    renderRestoration({ changeLabel: `Crews: ${old} → ${crews.value}` });
  });

  // Access segmented control
  document.querySelectorAll(".segmented button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".segmented button").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");
      const old = state.scenario.access;
      state.scenario.access = btn.dataset.access;
      renderRestoration({ changeLabel: `Access: ${labelAccess(old)} → ${labelAccess(btn.dataset.access)}` });
    });
  });

  // Switching
  $("#switching").addEventListener("change", (e) => {
    state.scenario.switching_available = e.target.checked;
    renderRestoration({ changeLabel: `Switching available: ${e.target.checked ? "off → on" : "on → off"}` });
  });

  // Prioritize critical
  $("#critical").addEventListener("change", (e) => {
    state.scenario.prioritize_critical = e.target.checked;
    renderRestoration({ changeLabel: `Prioritize critical: ${e.target.checked ? "off → on" : "on → off"}` });
  });

  // Failed upstream fuse
  $("#failed-fuse").addEventListener("change", (e) => {
    const old = state.scenario.failed_upstream_device;
    state.scenario.failed_upstream_device = e.target.checked ? "fuse" : null;
    renderRestoration({ changeLabel: `Upstream device failed: ${old ? "fuse → none" : "none → your fuse"}` });
  });

  // Reset scenario
  $("#reset-scenario").addEventListener("click", resetScenario);

  // Prepare — medical toggle
  $("#medical").addEventListener("change", (e) => {
    state.declaredNeeds = e.target.checked ? ["medical_equipment"] : [];
    renderGuidance();
    renderAlerts();
    toast(e.target.checked ? "Medical needs on — guidance & alerts updated" : "Medical needs cleared");
  });

  // Timeline
  $("#play-storm").addEventListener("click", playStorm);
  $("#step-storm").addEventListener("click", () => {
    stopPlay();
    stepStorm();
  });
  $("#reset-storm").addEventListener("click", resetStorm);

  // Chat
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#chat-input");
    const q = inp.value.trim();
    if (!q) return;
    handleChat(q);
    inp.value = "";
  });

  // Assumptions modal
  $("#open-assumptions").addEventListener("click", () => ($("#assumptions-modal").hidden = false));
  $("#close-assumptions").addEventListener("click", () => ($("#assumptions-modal").hidden = true));
  $("#assumptions-modal").addEventListener("click", (e) => {
    if (e.target.id === "assumptions-modal") $("#assumptions-modal").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#assumptions-modal").hidden = true;
  });

  // Clear my data
  $("#clear-data").addEventListener("click", clearMyData);
}

function labelAccess(a) {
  return a === "auto" ? "Auto" : a === "on" ? "Force on" : "Force off";
}

function resetScenario() {
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

  $("#crews").value = 2;
  $("#crews-value").textContent = "2";
  $("#severity").value = 1;
  $("#severity-value").textContent = SEVERITY_LABELS[1.0];
  $("#switching").checked = true;
  $("#critical").checked = true;
  $("#failed-fuse").checked = false;
  document.querySelectorAll(".segmented button").forEach((b) => {
    const on = b.dataset.access === "auto";
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });

  renderRisk._prev = null;
  state.lastRestoration = null;
  $("#rest-delta").hidden = true;
  $("#risk-delta").hidden = true;
  renderRisk();
  renderRestoration({ silent: true });
  toast("Scenario reset to defaults");
}

function clearMyData() {
  stopPlay();
  state.declaredNeeds = [];
  state.history = [];
  $("#medical").checked = false;
  pushHistory();
  resetScenario();
  resetStorm();
  $("#chat-log").innerHTML = "";
  seedChat();
  toast("Your session data has been cleared.");
}

/* =============================================================================
 * ASSUMPTIONS PANEL
 * ========================================================================== */
function renderAssumptions() {
  const ul = $("#assumptions-list");
  ul.innerHTML = "";
  data.assumptions.items.forEach((item) => ul.appendChild(el("li", null, item)));
}

/* go */
boot();
