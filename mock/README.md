# Mock API data (for the dashboard)

Sample JSON with the **exact shapes the real API will return** (MVP plan §7), so the dashboard can be built before the backend and models exist. When the API is ready, swap `fetch('mock/api/…json')` for the real endpoint. Nothing else should change.

> ⚠️ Every file carries `"is_mock": true`. The **map data and facts are real** (circuit CIR72, Roanoke area): locations, damage counts, device types. **Risk and restoration numbers are made up** and only roughly plausible. Never present them as model output.

## Files → future endpoints

| File | Future endpoint | Used by (UI panel) |
|---|---|---|
| `api/premise_lookup.json` | `GET /premise/lookup?lat=&lon=` or `?id=` | Map pin, header. Includes `demo_premises` (6 real premise IDs on CIR72) for a dev-only picker. |
| `api/circuit_area.geojson` | (part of lookup) | Map: shaded outline of the customer's circuit area |
| `api/damage_heat.json` | `GET /damage/heat?event=feb2025` | Map: heat layer. **Aggregated ~1 km cells, never individual points.** |
| `api/risk.json` | `GET /risk/{premise}?severity=1.0` | Risk card |
| `api/risk_by_severity.json` | same, keyed by severity `0.5 / 1.0 / 1.5 / 2.0` | Risk card reacting to the storm slider, plus its before/after note |
| `api/risk_fallback.json` | same, when the model can't predict | Fallback state of the risk card |
| `api/restoration.json` | `POST /restoration/{premise}` | Restoration panel (default scenario): range, drivers, jobs ahead of you, assumptions |
| `api/restoration_grid.json` | (dev only) | **Lookup table so sliders feel live.** 960 combinations of all controls. |
| `api/compare_examples.json` | `POST /restoration/{premise}/compare` | Before/after note ("Crews 2 → 6: 11–29 h → 7–19 h, because…") |
| `api/guidance.json` | `POST /guidance/{premise}` | Prepare panel: 3 variants incl. medical-equipment toggle |
| `api/alerts.json` | `POST /alerts/{premise}` | Alerts panel: with / without declared medical need |
| `api/timeline.json` | `POST /timeline/{premise}/step` | Storm timeline player + notifications feed (7 steps, 4 messages) |
| `api/chat_examples.json` | `POST /chat` | Chat panel: 5 sample exchanges incl. a privacy refusal and a 911 emergency |
| `api/assumptions.json` | `GET /assumptions` | Footer "Assumptions ⓘ" panel |

## Using the restoration grid (live sliders without a backend)

Find the row whose inputs match the controls:

```js
const row = grid.results.find(r =>
  r.crews === crews && r.storm_severity === severity && r.access === access &&      // access: "auto" | "on" | "off"
  r.switching_available === switching && r.failed_upstream_device === failed &&    // failed: null | "fuse"
  r.prioritize_critical === criticalFirst);
// row.p10 / row.p50 / row.p90 → "Likely {p10}–{p90} h (most likely {p50})"
```

Keep the previous row to build the before/after note: change, old range → new range. Use the `why` texts in `compare_examples.json` as placeholders.

## Key field conventions

| Field | Meaning |
|---|---|
| `label` | `"Model estimate"`, `"Confirmed (simulated)"` or `"Your action"`. **Always show it** next to the value (brief requirement). |
| `band` | `Low` < 15% · `Moderate` 15–40% · `High` 40–70% · `Very High` > 70%. Show colour **and** text, never colour alone. |
| `confidence` | `High` / `Medium` / `Low` |
| `fallback` | `null` normally. When set, hide the numbers and show `fallback.message`. |
| `p10 / p50 / p90` | Hours. Show as a range (p10–p90) with p50 as "most likely". |
| `safety[].level` | `emergency` → red box, `safety` → amber box |
| `emergency: true` (chat) | Show the reply in an EMERGENCY style and stop the normal flow |

## Scenario controls (match these names)

`crews` 1–10 · `storm_severity` 0.5 / 1.0 / 1.5 / 2.0 · `access` auto / on / off · `start_delay_h` (fixed at 6 in the mock) · `switching_available` true / false · `failed_upstream_device` null / "fuse" · `prioritize_critical` true / false · `declared_needs` [] / ["medical_equipment"]

## Privacy rules for the UI
- Show only the selected customer's own pin. **Never plot other customers.**
- No addresses anywhere. Show the area as "Roanoke area · circuit CIR72".
- Footer: *"Your location and any needs you share are used only for this session."* plus a **Clear my data** button.
