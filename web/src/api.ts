/* =============================================================================
 * Live backend client + adapters.
 *
 * The FastAPI backend (see backend/app/main.py) serves the cleaned AEP data
 * from S3. It covers a subset of what the dashboard needs: premise lookup,
 * power path, damage heat, circuit summary, facilities, and labor reference.
 *
 * It also serves the model output (risk-by-severity, the restoration grid) and
 * the rules built on it (guidance, alerts, storm-replay timeline, assumptions).
 * The dashboard uses no sample data.
 *
 * Each adapter here reshapes a backend response into the exact UI shape
 * declared in types.ts, so main.ts keeps consuming one consistent contract.
 * ========================================================================== */

import type {
  Alerts,
  Assumptions,
  CircuitGeoJSON,
  DamageHeat,
  Guidance,
  Timeline,
  DemoPremise,
  PowerPath,
  PowerPathLink,
  PremiseLookup,
  RestorationGrid,
  RiskBySeverity,
  RiskHeat,
} from "./types";

/* ---------------------------------------------------------------------------
 * Base URL. Configured via VITE_API_BASE (see web/.env.example). Falls back to
 * the local dev server. Trailing slashes are trimmed.
 * ------------------------------------------------------------------------- */
const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const API_BASE: string = (ENV.VITE_API_BASE ?? "http://localhost:8000").replace(
  /\/+$/,
  ""
);

/** Demo homes for the pitch: six different circuits and towns, every risk band,
 * overhead and underground, all with full data coverage and a restoration
 * estimate that drops when crews are added (picked from the model's scores). */
const DEMO_PREMISE_IDS = [
  "400797248", // first = default. Salem, CIR31, overhead, Very High (~80%), lost power Feb 2025
  "823929604", // Roanoke, CIR14, overhead, High (~55%), lost power Feb 2025
  "399053172", // Boones Mill, CIR18, underground, High (~50%), lost power Feb 2025
  "100862103", // Vinton, CIR40, overhead, Moderate (~28%)
  "655649579", // Cloverdale, CIR73, underground, Moderate (~22%)
  "151197223", // Blue Ridge, CIR61, underground, Low (~5%)
] as const;

/** The premise shown first / used for the map centre. */
export const DEFAULT_PREMISE_ID = DEMO_PREMISE_IDS[0];

/* ---------------------------------------------------------------------------
 * Low-level fetch against the live API with a timeout, so a missing backend
 * fails fast and the caller can fall back to mock.
 * ------------------------------------------------------------------------- */
async function apiGet<T>(path: string, timeoutMs = 4000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 * Backend response shapes (subset; mirror backend/app/models.py).
 * ------------------------------------------------------------------------- */
interface ApiPremise {
  premise_id: string;
  lat: number;
  lon: number;
  circuit_id: string;
  transformer_loc: string;
  service_type: string | null;
  city: string | null;
  has_chain: boolean;
  zone_id: string | null;
}
interface ApiPremiseLookup {
  premise: ApiPremise;
  outage_history: {
    out_feb2025: boolean;
    out_sep2024: boolean;
    out_other: boolean;
  } | null;
  data_coverage: string;
}
interface ApiHeatCell {
  lat: number;
  lon: number;
  count: number;
}

/* ---------------------------------------------------------------------------
 * Health probe — lets the caller decide live vs mock up front.
 * ------------------------------------------------------------------------- */
export async function apiHealthy(): Promise<boolean> {
  try {
    const h = await apiGet<{ status: string }>("/health", 2500);
    return h.status === "ok";
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * premise lookup (+ derived area label + demo premise list)
 *
 * The backend returns one premise at a time. The dashboard also wants a short
 * `area_label` and a `demo_premises` list for the dev picker, so we look up a
 * handful of known IDs in parallel and derive the label from the circuit.
 * ------------------------------------------------------------------------- */
function areaLabel(p: ApiPremise): string {
  const place = p.city ? `${p.city} area` : "Service area";
  return `${place} · circuit ${p.circuit_id}`;
}

export async function fetchPremiseLookup(
  premiseId: string = DEFAULT_PREMISE_ID
): Promise<PremiseLookup> {
  const main = await apiGet<ApiPremiseLookup>(
    `/premise/lookup?id=${encodeURIComponent(premiseId)}`
  );

  // Build the demo list: resolve each known id, skip any that 404.
  const settled = await Promise.allSettled(
    DEMO_PREMISE_IDS.map((id) =>
      apiGet<ApiPremiseLookup>(`/premise/lookup?id=${encodeURIComponent(id)}`)
    )
  );
  const demo_premises: DemoPremise[] = settled
    .filter(
      (r): r is PromiseFulfilledResult<ApiPremiseLookup> => r.status === "fulfilled"
    )
    .map((r) => ({
      premise_id: r.value.premise.premise_id,
      lat: r.value.premise.lat,
      lon: r.value.premise.lon,
      service_type: r.value.premise.service_type ?? "Unknown",
      city: r.value.premise.city ?? null,
      circuit_id: r.value.premise.circuit_id,
    }));

  // Guarantee the requested premise is present in the picker.
  if (!demo_premises.some((d) => d.premise_id === main.premise.premise_id)) {
    demo_premises.unshift({
      premise_id: main.premise.premise_id,
      lat: main.premise.lat,
      lon: main.premise.lon,
      service_type: main.premise.service_type ?? "Unknown",
      city: main.premise.city ?? null,
      circuit_id: main.premise.circuit_id,
    });
  }

  return {
    premise_id: main.premise.premise_id,
    lat: main.premise.lat,
    lon: main.premise.lon,
    circuit_id: main.premise.circuit_id,
    area_label: areaLabel(main.premise),
    service_type: main.premise.service_type ?? "Unknown",
    has_chain: main.premise.has_chain,
    data_coverage: main.data_coverage,
    demo_premises,
    is_mock: false,
    source: `live:${API_BASE}`,
  };
}

/* ---------------------------------------------------------------------------
 * chat — Amazon Nova via POST /chat. The backend keeps each conversation in
 * memory under a random session id; we hold that id in sessionStorage so it
 * survives a page refresh but stays private to this browser tab.
 * ------------------------------------------------------------------------- */
const CHAT_SESSION_KEY = "aep_chat_session";

function readChatSession(): string | null {
  try {
    return sessionStorage.getItem(CHAT_SESSION_KEY);
  } catch {
    return null;
  }
}

export interface ChatReply {
  session_id: string;
  reply: string;
  tools_used: string[];
  emergency: boolean;
}

/* the dashboard sliders the chatbot should answer for */
export interface ChatScenario {
  storm_severity: number;
  crews: number;
  access: "auto" | "on" | "off";
  switching_available: boolean;
  prioritize_critical: boolean;
}

export async function sendChat(
  message: string,
  premiseId: string,
  scenario?: ChatScenario,
  dashboard?: Record<string, unknown>
): Promise<ChatReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, premise_id: premiseId, session_id: readChatSession(), scenario, dashboard }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`/chat -> ${res.status}`);
    const r = (await res.json()) as ChatReply;
    try {
      sessionStorage.setItem(CHAT_SESSION_KEY, r.session_id);
    } catch {
      /* storage blocked: the conversation just won't survive a refresh */
    }
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** Forget this tab's conversation on the server and locally ("Clear my data"). */
export async function endChat(): Promise<void> {
  const sid = readChatSession();
  try {
    sessionStorage.removeItem(CHAT_SESSION_KEY);
  } catch {
    /* ignore */
  }
  if (!sid) return;
  try {
    await fetch(`${API_BASE}/chat/${encodeURIComponent(sid)}`, { method: "DELETE" });
  } catch {
    /* backend down: the server copy expires on its own */
  }
}

/* ---------------------------------------------------------------------------
 * power path — the ordered equipment chain feeding one premise.
 *
 * The backend's /premise/{id}/power-path returns the links with coordinates and
 * customer counts but no risk yet (Model A fills p_damage later). We pass the
 * links straight through; p_damage/band stay undefined until the model is wired
 * in, and the map falls back to a neutral colour for those links.
 * ------------------------------------------------------------------------- */
interface ApiChainLink {
  step: number;
  device_loc: string | null;
  device_type: string;
  circuit_id?: string | null;
  lat?: number | null;
  lon?: number | null;
  rating?: string | null;
  automated?: boolean | null;
  p_damage?: number | null;
  band?: PowerPath["home_band"];
  reason?: string | null;
}
interface ApiPowerPath {
  premise_id: string;
  circuit_id: string;
  links: ApiChainLink[];
  note?: string;
  coverage?: PowerPath["coverage"];
  home_probability?: number | null;
  home_band?: PowerPath["home_band"];
  weakest_link_step?: number | null;
}

export async function fetchPowerPath(
  premiseId: string,
  severity = 1.0
): Promise<PowerPath> {
  const pp = await apiGet<ApiPowerPath>(
    `/premise/${encodeURIComponent(premiseId)}/power-path?severity=${severity}`,
    30000 // link risk comes from the models, which load on the backend's first request
  );
  const links: PowerPathLink[] = pp.links.map((l) => ({
    step: l.step,
    device_loc: l.device_loc ?? null,
    device_type: l.device_type,
    lat: l.lat ?? null,
    lon: l.lon ?? null,
    p_damage: l.p_damage ?? null,
    band: l.band ?? null,
    reason: l.reason ?? null,
  }));
  return {
    premise_id: pp.premise_id,
    circuit_id: pp.circuit_id,
    links,
    note: pp.note,
    coverage: pp.coverage ?? "good",
    home_probability: pp.home_probability ?? null,
    home_band: pp.home_band ?? null,
    weakest_link_step: pp.weakest_link_step ?? null,
    is_mock: false,
    source: `live:${API_BASE}`,
  };
}

/* ---------------------------------------------------------------------------
 * model output — risk card per storm severity and the restoration grid, from
 * the trained models (backend/app/predict.py). Same shapes as the mock JSON.
 * The grid is simulated on first request, so it gets a longer timeout.
 * ------------------------------------------------------------------------- */
export async function fetchRiskBySeverity(premiseId: string): Promise<RiskBySeverity> {
  return apiGet<RiskBySeverity>(`/premise/${encodeURIComponent(premiseId)}/risk`, 30000);
}

export async function fetchRestorationGrid(premiseId: string): Promise<RestorationGrid> {
  return apiGet<RestorationGrid>(
    `/premise/${encodeURIComponent(premiseId)}/restoration-grid`,
    30000
  );
}

const premisePath = (id: string, what: string) => `/premise/${encodeURIComponent(id)}/${what}`;

/** Preparation checklist + safety from the home's risk and expected outage length. */
export const fetchGuidance = (id: string) => apiGet<Guidance>(premisePath(id, "guidance"), 30000);
/** Before / during / after checklist written by the chatbot's model for this home (null if unavailable). */
export const fetchAiChecklist = (id: string, severity: number, crews: number, medical: boolean,
                                 appliances: string[] = [], scenario?: {
                                   access: string; switching_available: boolean;
                                   prioritize_critical: boolean; failed_upstream_device: string | null;
                                 }) =>
  apiGet<import("./prepare").AiChecklist | null>(
    `${premisePath(id, "ai-checklist")}?severity=${severity}&crews=${crews}&medical=${medical}` +
      `&appliances=${encodeURIComponent(appliances.join(","))}` +
      (scenario ? `&access=${scenario.access}&switching_available=${scenario.switching_available}` +
        `&prioritize_critical=${scenario.prioritize_critical}` +
        `&failed_upstream_device=${encodeURIComponent(scenario.failed_upstream_device ?? "")}` : ""), 45000);
/** Alert eligibility, channels and escalations. */
export const fetchAlerts = (id: string) => apiGet<Alerts>(premisePath(id, "alerts"), 30000);
/** Storm replay: model estimates + the real Feb 2025 damage on this home's path. */
export const fetchTimeline = (id: string) => apiGet<Timeline>(premisePath(id, "timeline"), 30000);
/** Every simulated outage length (hours) for the current sliders, for "Time That Matters". */
export interface OutageHours { hours: number[]; p10: number; p50: number; p90: number }
export const fetchOutageHours = (id: string, sc: {
  crews: number; storm_severity: number; access: string; switching_available: boolean; prioritize_critical: boolean;
}) =>
  apiGet<OutageHours>(
    premisePath(id, "outage-hours") +
      `?crews=${sc.crews}&storm_severity=${sc.storm_severity}&access=${sc.access}` +
      `&switching_available=${sc.switching_available}&prioritize_critical=${sc.prioritize_critical}`,
    15000
  );
/** Model and data assumptions for the footer panel. */
export const fetchAssumptions = () => apiGet<Assumptions>("/assumptions");
/** Outline of the area the circuit serves (no individual homes). */
export const fetchCircuitOutline = (circuitId: string) =>
  apiGet<CircuitGeoJSON>(`/circuits/${encodeURIComponent(circuitId)}/outline`, 15000);

/* ---------------------------------------------------------------------------
 * damage heat — the backend already aggregates into ~1 km cells.
 * ------------------------------------------------------------------------- */
/* predicted-risk heat (trained model): average P(lose power) per ~500 m area.
 * Long timeout: the first call after a server restart loads the models. */
export async function fetchRiskHeat(severity = 1.0): Promise<RiskHeat> {
  return apiGet<RiskHeat>(`/risk/heat?severity=${severity}`, 90000);
}

export async function fetchDamageHeat(
  event = "feb2025"
): Promise<DamageHeat> {
  const cells = await apiGet<ApiHeatCell[]>(
    `/damage/heat?event=${encodeURIComponent(event)}`
  );
  return {
    event,
    cell_size_deg: 0.01,
    note: "Aggregated counts per ~1 km cell from the live API. Never individual records.",
    cells: cells.map((c) => ({ lat: c.lat, lon: c.lon, count: c.count })),
  };
}
