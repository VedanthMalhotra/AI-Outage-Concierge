# AI Outage Concierge: MVP plan

Companion to [data-usage-and-scope.md](data-usage-and-scope.md), which covers the scope statement and the full data inventory. This document covers **what we build, how each part works, and how we demo it**. No code yet.

---

## 1. What the MVP is

A web dashboard with a built-in AI chatbot for **residential Appalachian Power customers in the Roanoke Valley, VA**, used before and during a storm modelled on the **13–17 Feb 2025 event**.

A customer picks their location and gets:
1. **Outage risk:** a band, a confidence level and the top reasons
2. **Restoration estimate:** a range that judges can change with scenario controls
3. **Preparation guidance:** tailored to their risk, expected duration and declared needs
4. **Alerts:** whether they qualify, and the four proactive messages as a simulated storm plays out
5. **A chatbot** that answers questions in plain language **using only the outputs above**

Guiding principle from the brief: *"a focused, credible prototype with transparent assumptions is preferred over broad functionality."*

---

## 2. Customer journey (the demo flow)

| Step | What the customer does | What they see | Brief requirement (MVD) |
|---|---|---|---|
| 1 | Clicks the map or enters an anonymized premise ID | Their location pin and circuit area (no other customers shown) | MVD 1 |
| 2 | (automatic) | Risk card: **"High risk · Medium confidence"** + 3 reasons | MVD 2, Req 1 |
| 3 | Moves the crew / storm / access sliders | Restoration range updates live: **"likely 10–26 hours"** | MVD 3, Req 2 |
| 4 | Optionally ticks "I use medical equipment" | Guidance panel adapts, alert escalation turns on | MVD 4, Req 3 |
| 5 | Presses **Play storm** | Timeline runs and the notifications feed fills with 4 messages | MVD 5, Req 4 |
| 6 | Asks the chatbot "Will I lose power?" or "Why so long?" | A plain-language answer citing the model's factors and labelled as an estimate | Req 5 |
| 7 | Asks for something off-limits (a neighbour's data, an exact hospital location) or picks a premise with poor data | A refusal or a fallback message | MVD 6 |

Every number on screen carries one of three labels: **Model estimate**, **Confirmed** (simulated "utility-confirmed" events in the timeline), or **Your action**. The brief asks for this separation.

---

## 3. Architecture

```
 Raw data (data/raw/*.zip, xlsx, pdf)
        │  offline, run once
        ▼
 ┌─────────────────────┐
 │ 1. Data prep        │  read shapefiles + topology → joined tables
 └─────────┬───────────┘
           ▼
   processed store (SQLite / parquet)
           │
 ┌─────────┴──────────────────────────────────────────┐
 │ 2. Analytics engine (deterministic Python)         │
 │   risk model · restoration simulator · guidance    │
 │   rules · alert rules · message templates          │
 └─────────┬──────────────────────────────┬───────────┘
           │                              │ same functions exposed as tools
           ▼                              ▼
 ┌──────────────────┐           ┌─────────────────────────┐
 │ 3. REST API      │◄──────────│ 4. AI assistant (Claude)│
 │  (FastAPI)       │  /chat    │  tool use + guardrails  │
 └────────┬─────────┘           └─────────────────────────┘
          ▼
 ┌──────────────────┐
 │ 5. Dashboard UI  │  map · risk card · restoration sliders ·
 │  (HTML + Leaflet)│  guidance · notifications · chat panel
 └──────────────────┘
```

**Key design decision:** the chatbot **never touches raw data**. It can only call the analytics functions, which return sanitized results. Two consequences:
- It **cannot make up numbers**. Every figure comes from a tool result.
- It **cannot leak private data**. The tools never return addresses, Life Support flags, crew fields or other customers.

---

## 4. Data prep (component 1)

**Inputs:** all files in `data/raw/`, plus the labor workbook and the structure drawings. Field-level detail is in [data-usage-and-scope.md](data-usage-and-scope.md).

**Steps**
1. **Read** every shapefile directly from the zips (geometry + attributes). Convert the hospital / fire / EMS files from Web Mercator to latitude/longitude (all other files already use latitude/longitude).
2. **Normalize circuit IDs:** customer / device `circuit_id` `0000060` ↔ ARCOS `CIR60`.
3. **Parse `matched_upstream.txt`** into a premise → ordered chain: transformer → fuse(s) / recloser(s) → circuit breaker. Build a **topology graph** (device → downstream devices → premises).
4. **Assign each damage record to the network.** Match the damage point to its nearest transformer (spatial nearest-neighbour), then:
   - transformer / secondary damage → the outage zone is **that transformer**
   - pole / primary wire / fuse / recloser / switch damage → the outage zone is the **first protective device upstream** of that transformer
   - light and capacitor damage → ignored (no customer outage)
5. **Label outages per event:** a premise was "out" in an event if any damage record's outage zone is on its chain. This gives labels for **Feb 2025** (training) and **Sep 2024 + other dates** (validation).
6. **Build features** per transformer (premises inherit them). See §5.1.
7. **Load the labor tables** (per-unit hours, adders, ILM = 4.5) into a lookup.
8. **Privacy pass:** drop addresses and road names from anything the API serves. Keep the Life Support flag only in an internal aggregate (count of priority customers per device).

**Output tables:** `premise` (id, location, transformer, circuit, service type), `chain` (premise → ordered devices), `device` (type, location, circuit, downstream premise count, priority flag), `damage` (event, type, quantity, access, special equipment, zone), `features`, `labor`.

---

## 5. Analytics engine (component 2)

### 5.1 Outage-risk model (Req 1)

| Item | Plan |
|---|---|
| Unit | Transformer (26,959). Premises inherit their transformer's score. |
| Label | Transformer's customers lost power in the **Feb 2025** event (from step 5 above) |
| Model | **Logistic regression**: transparent, and each factor's contribution is easy to explain. A gradient-boosted model is an optional stretch, explained with SHAP. |
| Features | overhead vs underground service share · age, material, height and class of nearby poles · overhead primary length upstream (exposure) · number and type of protective devices on the chain (recloser vs fuse) · premises sharing the first protective device (zone size) · damage density in *other* events nearby (history) · distance to the nearest damage cluster |
| Validation | Train on Feb 2025, **test on Sep 2024 and other events** (a held-out storm). Report AUC and calibration. This number drives the confidence level. |
| Storm severity | No weather data, so a slider applies a **logit offset**: minor 0.5× · Feb-2025-like 1.0× · severe 1.5× · extreme 2.0×. Shown as an assumption. |
| Risk bands | Low < 15% · Moderate 15–40% · High 40–70% · Very High > 70% (probability of losing power at that severity) |
| Confidence | **High / Medium / Low**, from validation performance, how much data covers the area (damage history, unknown pole fields) and how close the score is to a band boundary |
| Explanation | Top 3 feature contributions converted to plain-language templates, for example "Your power comes through about 2 miles of overhead line" or "Poles near you average 55 years old" |
| Fallback | No upstream chain (about 40 premises missing from the file), or Low confidence with a borderline score → *"We can't give a reliable estimate for your location"* + general guidance |

### 5.2 Restoration-time simulator (Req 2)

**Per-damage repair bundles.** The structure drawings say which parts are involved, and the labor workbook gives the hours (install + removal):

| Damage type | Parts replaced (from drawings) | Direct hours |
|---|---|---|
| Pole (40 ft) | pole 3.43 · crossarm 0.59 · 3× insulator + pin 0.59 · guying 0.53 · grounding 0.69 | **≈ 5.8 h** (small pole ≈ 5.1, large ≈ 6.8) |
| Transformer (25 kVA) | transformer 1.99 · fuse cutout 0.38 · equipment leads 0.86 · grounding 0.69 | **≈ 3.9 h** |
| Switch | switch 2.77 | **≈ 2.8 h** |
| Recloser | recloser 1.10 · equipment leads 0.86 | **≈ 2.0 h** |
| Secondary / service | service 2.17 · secondary attachment 0.36 | **≈ 2.5 h** |
| Fuse bank | fuse cutout 0.38 | **≈ 0.4 h** |
| Primary wire span | 2× dead-end 0.34 · 2× connector 0.52 · insulator + pin 0.20 | **≈ 1.1 h** ⚠ the workbook has no conductor-pulling hours, so this is an assumption to confirm |

**Adders** (from the "Labor only work" sheet): `Access_Iss = Yes` → +0.5 h · backyard bucket → +0.5 h · track hoe / off-road → +1.31 h · other special equipment → +0.5 h.

**Formula for one job:** `crew-hours = (bundle hours × quantity + adders) × ILM (4.5)`

**Simulating the customer's restoration time:**
1. **Damage scenario** for the customer's circuit: replay that circuit's actual Feb 2025 damage, scaled by the storm-severity slider. Judges can also add or remove damage directly ("+1 broken pole on your line").
2. **Crews** (slider, for example 1–10 on the circuit) work jobs in **priority order**: (1) circuit breaker / main line, (2) devices serving hospitals, fire, EMS or priority customers, (3) devices with the most customers downstream, (4) everything else.
3. **Start delay** (slider): no climbing in high winds plus assessment time, default 6 h.
4. **Dependencies:** the customer is restored when **every job on their chain** is done. **Step restoration:** where a switch can isolate a damaged section further down the line, upstream customers are restored when their own section is clear.
5. **Range:** run about 200 Monte Carlo simulations varying ILM (3.5–5.5), job hours (±30%), damage count and start delay (±50%). Show **P10–P90** as "likely X–Y hours" and the median as the most likely value.
6. **What moves it:** show the top 2 drivers ("adding 2 crews cuts about 6 h", "a broken pole upstream of you adds about 8 h").
7. **Sanity check:** in a Feb-2025-like scenario, about 90% of customers should be restored within about 2 days, matching the historical repair dates.

### 5.3 Preparation guidance (Req 3)

Rules matrix: **risk band × expected duration**, plus modifiers.

| | < 4 h | 4–24 h | > 24 h |
|---|---|---|---|
| **Low / Moderate** | charge phones, flashlights ready | + water, non-perishable food, check medications | + plan where to stay, fill car tank |
| **High / Very High** | + unplug sensitive electronics | + fridge/freezer plan, cash, neighbour check-in | + arrange to stay elsewhere, medication refrigeration plan |

**Modifiers:**
- **Overhead service** → "Stay at least 30 ft from downed lines, including the line to your house."
- **Declared medical equipment (opt-in only)** → battery backup check, contact your equipment provider, plan where to go if power is out longer than battery life, and turn on alert escalation.
- **Declared accessibility need** → simpler checklist, larger text, phone alerts preferred.
- **Always shown, in a red ⚠ SAFETY box:** downed-line warning, generator carbon-monoxide warning, never refuel a running generator, **medical emergency → call 911**.
- **The Life Support flag in the data never changes what a customer sees.**

### 5.4 Alert eligibility and escalation (Req 4)

These are challenge assumptions. Replace them with AEP's rules if the mentors provide any.

| Rule | Trigger | Action · channel · timing |
|---|---|---|
| **A0 Basic alerts** | Any customer in the area | Eligible for opt-in outage alerts (answers "Do I qualify?") |
| **A1 Pre-storm** | Risk ≥ Moderate | SMS + email at T−24 h. High or above: also app push at T−6 h. |
| **A2 Outage confirmed** | Simulated damage on the customer's chain | SMS + push immediately |
| **A3 Estimate updated** | Median estimate moves > 2 h, or the upper bound crosses 24 h | SMS. Max one per 3 h to avoid spam. |
| **A4 Restored** | Last job on the chain completes | SMS + "Still out? Reply OUT" |
| **E1 Medical escalation** | Declared medical need **and** (risk ≥ High **or** upper estimate > 4 h) | Notice at T−48 h, phone call option, flag for human follow-up |
| **E2 Low confidence** | Confidence = Low | Message says "we'll update you as crews assess damage" and routes to human review |
| **E3 Emergency** | Customer mentions a downed line, fire or medical emergency | Stop the normal flow: **call 911** / AEP emergency line, labelled EMERGENCY |

### 5.5 Proactive messages (Req 4)

Four message types are generated from structured outputs. Claude rewrites them in plain language, with a **fixed template fallback** so the demo works without the API. Examples (SMS-length):

- **Pre-storm:** "AEP: A strong storm may affect your area tomorrow. Your outage risk is HIGH. If you lose power, restoration may take 10–26 hrs (estimate). Charge devices tonight. Stay away from downed lines."
- **Outage confirmed:** "AEP: We've confirmed an outage affecting your home. Crews will assess damage after winds ease. Next update by 2 PM."
- **Estimate updated:** "AEP: Updated estimate: power likely back 6 PM–2 AM (was 4–10 PM). Reason: additional damage found upstream of your area."
- **Restored:** "AEP: Power should now be restored at your home. Still out? Reply OUT."

### 5.6 Storm timeline ("live updates")

A simulated clock replaces random live data. **Play / step** buttons move through:
`T−24 h forecast → T−6 h → T0 storm peak → T+2 h damage reports arrive → T+6 h assessment done → T+12 h crews progressing → restoration`

At each step the risk and estimate update, events are labelled **Confirmed (simulated)**, and alert rules fire messages into the notifications feed. The damage sequence is taken from the Feb 2025 report and repair order on the customer's circuit.

---

## 6. AI assistant (component 4)

| Item | Plan |
|---|---|
| Model | **Claude Opus 5.5** (`claude-opus-5-5`) via the Anthropic Python SDK, with adaptive thinking and low/medium effort for chat responsiveness. Server-side refusal fallback enabled. |
| Pattern | **Tool use**: the SDK tool runner (or a manual tool loop). Claude picks the tool. No forced tool choice (that's unsupported on this model). |
| Tools | `get_my_context(premise_id)` → circuit area, service type, data-coverage level<br>`get_outage_risk(premise_id, storm_severity)` → band, probability, confidence, top factors<br>`estimate_restoration(premise_id, crews, storm_severity, start_delay_h, access_issues, extra_damage)` → P10/P50/P90, drivers, assumptions<br>`get_preparation_guidance(premise_id, declared_needs)` → checklist + safety items<br>`check_alert_eligibility(premise_id, declared_needs)` → rules met, channel, timing, escalations<br>`draft_message(premise_id, message_type)` → message text<br>`explain_assumptions()` → assumptions and limitations list |
| System prompt rules | Plain language at about an 8th-grade reading level · **only state numbers that came from a tool** · always label estimates and give the range plus confidence · name the main reasons · never reveal other customers, addresses, Life Support flags, crew data or exact sensitive-facility locations · emergency / downed line → 911 and stop · if a tool returns a fallback, say so honestly · stay on topic (storm outages) |
| Scope of chat | The four brief questions plus "why?", "what if more crews?" and "what changed?". Scenario questions call the tool with new parameters, so the chat and the sliders stay consistent. |
| Audit trail | Every turn logged (JSON lines): question, tools called, tool outputs, final answer, timestamp. Viewable on a hidden "Audit" tab during judging. |
| Offline fallback | No API key or network → a simple intent matcher maps the four questions to the same tools and answers from templates. The demo never depends on the network. |

---

## 7. REST API (component 3)

| Endpoint | Returns |
|---|---|
| `GET /premise/lookup?lat=&lon=` or `?id=` | Nearest premise (own session only) + circuit area outline |
| `GET /risk/{premise}?severity=` | Risk band, confidence, factors |
| `POST /restoration/{premise}` (scenario body) | P10/P50/P90, drivers, assumptions |
| `POST /guidance/{premise}` (declared needs) | Checklist, safety items |
| `POST /alerts/{premise}` | Eligibility, rules fired, channel/timing |
| `POST /timeline/{premise}/step` | Next timeline state + any new messages |
| `POST /chat` | Assistant reply (+ tool trace for the audit log) |
| `GET /assumptions` | Assumptions and limitations panel content |

---

## 8. Dashboard UI (component 5)

```
┌───────────────────────────────────────────────┬──────────────────────┐
│  MAP (Leaflet)                                │  CHAT                │
│  · your pin + your circuit area (shaded)      │  "Will I lose power?"│
│  · damage density heat layer (aggregated)     │  → answer + labels   │
├──────────────────────┬────────────────────────┤                      │
│ RISK CARD            │ RESTORATION            │                      │
│ HIGH · Medium conf.  │ likely 10–26 h         │                      │
│ 1. overhead line…    │ [crews ▮▮▮▯▯]          │                      │
│ 2. pole age…         │ [storm ▮▮▯▯]           │                      │
│ 3. single fuse…      │ [access ☐] [+damage]   │                      │
├──────────────────────┼────────────────────────┤                      │
│ PREPARE              │ ALERTS & MESSAGES      │                      │
│ ⚠ SAFETY box         │ eligible ✔ · SMS+email │                      │
│ ☐ checklist…         │ ▶ Play storm  T+6h     │                      │
│ ☐ I use medical eqp. │ [feed of 4 messages]   │                      │
└──────────────────────┴────────────────────────┴──────────────────────┘
  Footer: "Model estimates, not official AEP information" · Assumptions ⓘ
```

- Never plots other customers' points. Other areas appear only as aggregated zones.
- Accessible design: colour plus text labels for bands (never colour alone), keyboard navigation, readable font sizes.

---

## 9. Responsible-AI checklist (Req 5 / MVD 6)

| Control | Where |
|---|---|
| Labels: Confirmed / Model estimate / Your action | UI, messages, chat |
| Confidence on every prediction | Risk card, restoration, chat |
| Assumptions and limitations panel | UI footer + `explain_assumptions` tool |
| Fallback when unreliable | Risk model, restoration, chat |
| Privacy filter at the tool layer | Analytics → API → chat |
| No inferring sensitive attributes (medical only if declared) | Guidance, alerts |
| Emergency handling → 911 | Guidance, chat, alerts (E3) |
| Human escalation | E1, E2 rules |
| Audit trail | Chat log |
| Input validation (premise IDs, slider bounds, prompt-injection-resistant system prompt) | API + chat |

---

## 10. Tech stack and repo layout

- **Python 3.12 virtual environment recommended.** The machine has Python 3.14, which some geospatial packages may not support yet. Packages: pandas, numpy, geopandas + shapely (or pyshp), scikit-learn, FastAPI + uvicorn, anthropic.
- **Frontend:** a single HTML page + vanilla JS + Leaflet (no build step). Switch to React only if a teammate is fastest in it.
- **Secrets:** `ANTHROPIC_API_KEY` from the environment, never committed.

```
prep/          data prep scripts → data/processed/ (gitignored)
engine/        risk.py · restoration.py · guidance.py · alerts.py · messages.py
api/           FastAPI app + chat/tools
web/           index.html · app.js · styles.css
docs/          scope, data usage, this plan, demo script
```

---

## 11. Build plan (assuming a ~24 h hackathon, team of 4)

| Phase | Hours | Person A (data) | Person B (models) | Person C (backend + AI) | Person D (frontend) |
|---|---|---|---|---|---|
| 0 Setup | 0–1 | env, extract data | env | repo skeleton, API stubs | UI wireframe |
| 1 Core | 1–6 | joins, topology, damage→zone, labels | labor bundles, restoration formula | tool definitions, system prompt | map + panels on mock JSON |
| 2 Models | 6–12 | features | risk model + validation; Monte Carlo restoration | real endpoints, chat with tools | sliders, risk card, guidance |
| 3 Integrate | 12–18 | timeline replay data | alert rules, guidance matrix, messages | audit log, offline fallback | timeline player, notifications, chat panel |
| 4 Polish | 18–22 | sanity checks vs Feb 2025 | assumptions panel content | guardrail tests (privacy, 911) | accessibility, labels |
| 5 Demo | 22–24 | — | — | — | rehearse the 5-minute script |

**Cut list if time runs short** (in order): gradient-boosted model → Monte Carlo (use fixed optimistic/pessimistic cases) → step restoration → damage heat layer. **Never cut:** sliders updating the range, the 4 messages, confidence + fallback, privacy refusals.

---

## 12. Demo script (5 minutes)

1. **Scope (20 s):** "Residential customers, Roanoke Valley, Feb-2025-style storm."
2. **Pick a premise** on a hard-hit circuit → High risk, Medium confidence, 3 reasons (MVD 1–2).
3. **Change crews 2 → 6** → range shrinks. Toggle access issues → it grows (MVD 3, "change one input").
4. **Tick medical equipment** → guidance and escalation change (MVD 4).
5. **Play storm** → 4 messages appear in sequence (MVD 5).
6. **Chat:** "Will I lose power?", "Why will it take so long?", "What if more crews come?"
7. **Guardrails:** "Who else on my street has life support?" → refused. "Where's the nearest hospital, I'm having chest pains" → 911. A premise with missing data → fallback (MVD 6).
8. **Close:** show the assumptions panel and the held-out-storm validation score.

---

## 13. Assumptions and open questions

**Assumptions we state openly:** storm severity is a scenario input (no weather data) · `Media` = damage quantity · wire-span repair hours are approximate (no conductor hours in the workbook) · ILM 4.5 applies to all labor and may be a multi-company average · default start delay 6 h · alert rules are our own design · repair dates are day-level only and used as a sanity check, not for training durations.

**Ask the mentors** (full list in the earlier discussion; top items):
1. What does `Media` mean, and what do 0 values mean?
2. Is `Repaired_D` restoration or record closeout?
3. Are labor hours per crew or per person, and what is a typical crew size?
4. Is ILM 4.5 right for this area, and does it include storm-wait / assessment time?
5. **New:** how many hours should we use to re-string a span of primary conductor? It isn't in the workbook.
6. Can the Life Support flag be used in aggregate for prioritization?

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spatial matching of damage to the network is noisy | Use the provided `NEAR_FID` / `NEAR_DIST` where valid, and cap the match distance. Report the match rate. |
| Weak risk model (few events) | Present it honestly with a validation score and confidence. Fall back to transparent weighted scoring if logistic regression underperforms. |
| Restoration numbers look unrealistic | Sanity-check against Feb 2025. Show the assumptions and let judges adjust them. |
| API or network down during judging | Offline chat fallback + template messages |
| Geospatial packages fail to install | Python 3.12 virtual environment. pyshp needs no compiled dependencies. |
| LLM says something unsafe or made up | Tools-only numbers, sanitized tool outputs, guardrail prompt, audit log, scripted guardrail tests before the demo |
