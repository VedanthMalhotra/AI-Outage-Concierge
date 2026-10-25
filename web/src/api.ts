/* =============================================================================
 * Live backend client + adapters.
 *
 * The FastAPI backend (see backend/app/main.py) serves the cleaned AEP data
 * from S3. It covers a subset of what the dashboard needs: premise lookup,
 * power path, damage heat, circuit summary, facilities, and labor reference.
 *
 * It also serves the model output: risk-by-severity and the restoration grid.
 * The pieces the backend does NOT yet serve — guidance, alerts, the storm
 * timeline and the assumptions list — stay on the mock JSON in ../mock/api.
 *
 * Each adapter here reshapes a backend response into the exact UI shape
 * declared in types.ts, so main.ts keeps consuming one consistent contract.
 * ========================================================================== */

import type {
  DamageHeat,
  DemoPremise,
  PremiseLookup,
  RestorationGrid,
  RiskBySeverity,
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

/** Demo premise IDs to populate the dev picker (match the old mock list). */
const DEMO_PREMISE_IDS = [
  "716589371", // first = default: High risk, and every restoration control moves its estimate
  "858810648",
  "840408754",
  "934287012",
  "906593047",
  "998522028",
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
    }));

  // Guarantee the requested premise is present in the picker.
  if (!demo_premises.some((d) => d.premise_id === main.premise.premise_id)) {
    demo_premises.unshift({
      premise_id: main.premise.premise_id,
      lat: main.premise.lat,
      lon: main.premise.lon,
      service_type: main.premise.service_type ?? "Unknown",
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

export async function sendChat(message: string, premiseId: string): Promise<ChatReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, premise_id: premiseId, session_id: readChatSession() }),
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

/* ---------------------------------------------------------------------------
 * damage heat — the backend already aggregates into ~1 km cells.
 * ------------------------------------------------------------------------- */
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
