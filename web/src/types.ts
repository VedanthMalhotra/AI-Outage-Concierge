/* =============================================================================
 * Types for the mock API shapes (mock/api/*.json). These mirror MVP plan §7, so
 * swapping fetch('../mock/api/x.json') for the real endpoint keeps the compiler
 * honest about response shapes.
 * ========================================================================== */


export type Band = "Low" | "Moderate" | "High" | "Very High";
export type Access = "auto" | "on" | "off";
export type FailedUpstreamDevice = null | "fuse";

/* ---- premise_lookup.json ---- */
export interface DemoPremise {
  premise_id: string;
  lat: number;
  lon: number;
  service_type: string;
  city?: string | null;
  circuit_id?: string;
}
export interface PremiseLookup {
  premise_id: string;
  lat: number;
  lon: number;
  circuit_id: string;
  area_label: string;
  service_type: string;
  has_chain: boolean;
  data_coverage: string;
  demo_premises: DemoPremise[];
  is_mock?: boolean;
  source?: string;
}

/* ---- power_path.json ---- */
export interface PowerPathLink {
  step: number;
  device_loc: string | null;
  device_type: string;
  lat: number | null;
  lon: number | null;
  /* Model A per-link damage probability + its band, when available. */
  p_damage?: number | null;
  band?: Band | null;
  reason?: string | null;
  /* NOTE: no per-link customer counts here. The path only shows this home's
   * route to the substation and never how many other homes share equipment. */
}
export interface PowerPath {
  premise_id: string;
  circuit_id: string;
  storm_severity?: number;
  home?: { lat: number; lon: number } | null;
  links: PowerPathLink[];
  weakest_link_step?: number | null;
  home_probability?: number | null;
  home_band?: Band | null;
  note?: string;
  /* "good" = full recorded chain; "fallback" = chain missing, synthesized. */
  coverage?: "good" | "fallback";
  is_mock?: boolean;
  source?: string;
}

/* ---- damage_heat.json ---- */
export interface HeatCell {
  lat: number;
  lon: number;
  count: number;
}
export interface DamageHeat {
  event: string;
  cell_size_deg: number;
  note?: string;
  cells: HeatCell[];
}

/* ---- backend /risk/heat: predicted outage chance per ~500 m area ---- */
export interface RiskHeatCell {
  lat: number;
  lon: number;
  probability: number; // average P(lose power) of the homes in the area
  band: Band;
  homes: number; // rounded to 10
}
export interface RiskHeat {
  storm_severity: number;
  cell_size_deg: number;
  min_homes: number;
  label: string;
  note?: string;
  cells: RiskHeatCell[];
}

/* ---- risk_by_severity.json / risk_fallback.json ---- */
export interface RiskFactor {
  key: string;
  label: string;
  detail: string;
  evidence?: string | null; // Feb 2025 damage rate for areas like this one (real labels)
  direction?: string;
  weight?: number;
}
export interface RiskFallback {
  message: string;
  [k: string]: unknown;
}
export interface Risk {
  premise_id: string;
  storm_severity: number;
  probability: number;
  band: Band;
  confidence: string;
  confidence_reason?: string;
  top_factors: RiskFactor[];
  label: string;
  fallback: RiskFallback | null;
  is_mock?: boolean;
  source?: string;
}
export type RiskBySeverity = Record<string, Risk>;
export interface RiskFallbackDoc {
  fallback: RiskFallback;
  [k: string]: unknown;
}

/* ---- restoration_grid.json ---- */
export interface GridRow {
  crews: number;
  storm_severity: number;
  access: Access;
  switching_available: boolean;
  failed_upstream_device: FailedUpstreamDevice;
  prioritize_critical: boolean;
  p10: number;
  p50: number;
  p90: number;
}
export interface RestorationDriver {
  text: string;
  impact_h: number;
}
export interface RestorationJob {
  order: number;
  what: string;
  crew_hours: number;
  status?: string;
  on_your_line?: boolean;
}
export interface RestorationGrid {
  start_delay_h: number;
  note?: string;
  results: GridRow[];
  /* live API only (backend/app/predict.py); the mock grid has none */
  drivers?: RestorationDriver[];
  jobs_ahead_of_you?: RestorationJob[];
  /* set when this premise is a hospital, fire station or ambulance station */
  critical_facility?: { type: string; label: string; note: string } | null;
}

/* ---- guidance.json ---- */
export interface SafetyItem {
  level: "emergency" | "safety";
  text: string;
}
export interface GuidanceVariant {
  risk_band: string;
  duration_bucket: string;
  declared_needs: string[];
  safety: SafetyItem[];
  escalation?: string;
  checklist: string[];
  label: string;
}
export interface Guidance {
  variants: Record<string, GuidanceVariant>;
}

/* ---- alerts.json ---- */
export interface AlertRule {
  id: string;
  name: string;
  met: boolean | null;
  why: string;
  channels?: string[];
  timing?: string[];
}
export interface AlertEscalation {
  name: string;
  why: string;
  actions: string[];
}
export interface AlertVariant {
  eligible: boolean;
  rules: AlertRule[];
  escalations?: AlertEscalation[];
}
export interface Alerts {
  variants: Record<string, AlertVariant>;
}

/* ---- timeline.json ---- */
export type Phase =
  | "pre_storm"
  | "storm"
  | "outage"
  | "assessing"
  | "repairing"
  | "restored";
export interface TimelineMessage {
  type: string;
  channel?: string[];
  text: string;
}
export interface TimelineStep {
  t: string;
  title: string;
  phase: Phase;
  confirmed_event: { text: string; label: string } | null;
  risk: { probability: number; band: Band } | null;
  restoration: { p10: number; p50: number; p90: number; label: string } | null;
  message: TimelineMessage | null;
  messages?: TimelineMessage[]; // live API: every message sent at this step
}
export interface Timeline {
  premise_id: string;
  steps: TimelineStep[];
}

/* ---- chat_examples.json ---- */
export interface ChatExample {
  user: string;
  tools_called: string[];
  assistant: string;
  emergency?: boolean;
}
export interface ChatExamples {
  examples: ChatExample[];
}

/* ---- assumptions.json ---- */
export interface Assumptions {
  items: string[];
}

/* ---- GeoJSON (circuit_area.geojson) ---- */
export type CircuitGeoJSON = GeoJSON.GeoJsonObject;

/* ---- scenario / app state ---- */
export interface Scenario {
  crews: number;
  storm_severity: number;
  access: Access;
  switching_available: boolean;
  failed_upstream_device: FailedUpstreamDevice;
  prioritize_critical: boolean;
  start_delay_h: number;
}
export interface RestorationSnapshot {
  p10: number;
  p50: number;
  p90: number;
  scenario: Scenario;
}

export interface AppData {
  lookup: PremiseLookup | null;
  circuit: CircuitGeoJSON | null;
  heat: RiskHeat | null; // predicted-risk heat from the backend (null offline)
  powerPath: PowerPath | null;
  riskBySeverity: RiskBySeverity | null;
  riskFallback: RiskFallbackDoc | null;
  grid: RestorationGrid | null;
  guidance: Guidance | null;
  alerts: Alerts | null;
  timeline: Timeline | null;
  chat: ChatExamples | null;
  assumptions: Assumptions | null;
}

export interface AppState {
  premiseId: string;
  severity: number;
  scenario: Scenario;
  declaredNeeds: string[];
  lastRestoration: RestorationSnapshot | null;
  history: string[];
  timelineStep: number;
  playTimer: ReturnType<typeof setInterval> | null;
}
