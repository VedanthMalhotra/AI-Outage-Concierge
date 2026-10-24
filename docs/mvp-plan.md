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
| 3 | Moves the crew / storm / access sliders, adds damage, or flips a network option | Restoration range updates live: **"likely 10–26 hours"**, plus a before/after note explaining what moved and why | MVD 3, Req 2 |
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
 │ 2. Analytics engine (Python)                       │
 │   trained: risk · expected damage · access chance  │
 │   rules: restoration simulator · guidance · alerts │
 │          · message templates                       │
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

## 4. Data prep (component 1): one data owner

**Inputs:** all files in `data/raw/`, plus the labor workbook and the structure drawings. Field-level detail is in [data-usage-and-scope.md](data-usage-and-scope.md).

**One person (the data owner) cleans all the data.** The work is ordered so the **ML teammate gets what they need as early as possible**. Cleaning runs **on AWS** (SageMaker Studio, §10b). Raw files go into S3, and each batch writes its cleaned tables back to S3 as soon as it's done, where the ML teammate reads them:

```
 0:00–0:30  shared contract (§4.0) + API/data contract with ML and dashboard teammates
 0:30–3:00  Batch 1: customers, equipment chains, transformers, devices      → upload
            (+ one-circuit sample upload at ~1:30 so ML can build its pipeline)
 3:00–5:00  Batch 2: damage reports → match to network → LABELS              → upload
 5:00–6:30  Batch 3: poles + lines, assigned to areas (feature inputs)       → upload
 6:30–8:00  Batch 4: facilities, labor workbook, repair bundles, priority    (app only)
```

The data owner hands over **clean, linked tables and labels**. **Feature engineering** (turning those tables into model inputs) belongs to the ML teammate.

### 4.0 Shared contract (agree in the first 30 minutes)

| Rule | Value |
|---|---|
| Coordinates | Latitude/longitude (WGS 84, EPSG:4326) everywhere. Columns are named `lat`, `lon`. |
| Circuit ID | `CIR<number>` with no leading zeros. Customer/device `0000060` → `CIR60`. ARCOS already uses `CIR60`. |
| Device IDs | The numeric IDs from `matched_upstream.txt` (e.g. `107301290`), stored as **text** to keep leading zeros. Premise IDs (`premise_nu`) are also text. |
| Column names | Rename the truncated shapefile names to readable snake_case (`Inform_Wor` → `damage_type`, `Access_Iss` → `access_issue`, `kind_of_se` → `service_type`, …). Keep the rename map in one shared file. |
| Missing values | Real nulls, not `'Unknown'`, `'N/A'`, `'??'` or blank strings. Add a `*_known` flag where it matters (e.g. pole height). |
| Output | Parquet files in `data/processed/` (gitignored), one per table, plus a short `data/processed/README.md` with row counts. |
| Privacy | Addresses, road names and street codes never leave the prep step. The Life Support flag stays internal only (§4.3). |
| Shared code | `prep/common.py`: circuit-ID conversion, rename map, null handling, shapefile reader, coordinate conversion |
| Scripts | One script per batch (`prep/batch1_network.py` … `prep/batch4_reference.py`) so each batch can be re-run and uploaded on its own |
| Data dictionary | `data/processed/README.md`: every table, its columns, row count and known gaps. **Written for the ML teammate**, who didn't clean the data. |

### 4.1 Batch 1 (customers, chains, devices) + facilities in Batch 4

**Files:** `Customer_Clip`, `matched_upstream.txt`, `Transformer_Clip`, `Fuse_Bank_Clip`, `Recloser_Bank_Clip`, `Switch_Clip` (Batch 1) · `Hospitals_*`, `Fire_Stations_*`, `Ambulance_Servi_*` (Batch 4). Batch 1 also builds the **protective-device areas** (`zone`: each fuse / recloser → downstream transformers and premises, with customer counts).

| Step | Work | Known data issues to handle |
|---|---|---|
| 1 | Customers → `premise` (id, lat, lon, circuit, transformer, service type, life_support flag kept **internal only**) | 22 rows with state `??`; 399 with service type `Unknown`; drop address, road and street-code fields |
| 2 | `matched_upstream.txt` → `chain` (premise → ordered device list: transformer → fuses / reclosers → circuit breaker, with device type per step) | 117,599 lines vs 117,642 customers: flag the ~40 missing premises (they get the risk-model fallback) |
| 3 | Transformers → `transformer` (id, lat, lon, circuit, kVA, phase, mounting) | Normalize circuit IDs; parse kVA to a number |
| 4 | Fuses, reclosers, switches → `device` (id, type, lat, lon, circuit, rating, normal state, automation) | Normalize circuit IDs; standardize device-type names |
| 5 | Hospitals, fire stations, ambulance → `facility` (name, type, town, lat, lon, is_general_er) | **Convert from Web Mercator to lat/lon.** Catawba (psychiatric) and Salem VA are not general emergency rooms. |
| 6 | Self-checks: every chain device ID exists in `transformer` / `device`; list devices that appear in no chain | — |

**Delivers:** `premise`, `chain`, `transformer`, `device`, `zone` (Batch 1) · `facility` (Batch 4).

### 4.2 Batch 2 (damage), Batch 3 (poles, lines), Batch 4 (labor)

**Files:** `arcos_prod_damage_09_28_Clip` (Batch 2) · `Pole_Clip`, `Primary_ExportFeatures`, `Secondary_ExportFeatures` (Batch 3) · `Install_Labor_HackOHIO.xlsx`, `structure_drawings.pdf` (Batch 4). Damage steps 1–3 here come first in Batch 2, before the matching and labels in §4.3.

| Step | Work | Known data issues to handle |
|---|---|---|
| 1 | Damage reports → `damage` (report date, repaired flag, repaired date, circuit, asset type, damage type, quantity, access issue, special equipment, lat, lon, `near_fid`, `near_dist`) | `Event`, `District`, `Status`, crew columns all blank → drop. 1 blank asset type, 1 blank access value. **The 76 unrepaired records still have repair dates** (mostly Oct–Dec 2025, some in 2026; likely scheduled or placeholder dates), so set them to null for unrepaired rows. |
| 2 | **Tag events**: Feb 2025 (13–20 Feb, 1,254 records) · Sep 2024 (25 Sep – 5 Oct, 194) · other (211) | Confirm the cluster boundaries with a quick histogram |
| 3 | `Media` → quantity (0–6) | 328 zeros: treat as 1 and flag. Confirm with mentors. |
| 4 | Poles → `pole` (lat, lon, install year, age, material group, height ft, class) | 19,195 unknown heights and ~24k unknown / N/A classes: null + flag. Group materials (pine / wood / cedar / fir → wood). |
| 5 | Primary and secondary lines → `line` (circuit, length, overhead/underground, voltage, phase, midpoint lat/lon) | Large files (secondary ~106 MB): process in chunks |
| 6 | Labor workbook → `labor_unit` (part, size band, install h, removal h), `labor_adder`, `ilm` = 4.5 | Size-banded tables (pole by height, transformer by kVA) |
| 7 | Structure drawings → **`repair_bundle`**: damage type → parts list → direct hours (§5.2 table) | Wire-span hours are an assumption (no conductor hours in the workbook) |

**Delivers:** `damage` (Batch 2) · `pole`, `line` (Batch 3) · `labor_unit`, `labor_adder`, `repair_bundle` (Batch 4).

### 4.3 Linking steps (inside Batches 2–4)

These steps connect the tables. They're what turns cleaned files into something the models can learn from.

| Batch | Linking work | Output (→ S3 for ML) |
|---|---|---|
| **2** | **Match damage to the network**: nearest transformer (cap the distance, e.g. 300 m; use `near_fid` where valid) → outage area (transformer for transformer / secondary damage; first upstream protective device otherwise; lights and capacitors ignored). Report the match rate. Build **labels**: per-event outage labels (risk model), per-area damage counts by type (expected-damage model), per-record access labels (access model). | `damage` (with `zone_id`), `outage_labels`, `zone_damage_counts`, `access_labels` |
| **3** | Assign every pole and line segment to an area (`zone_id`) by nearest transformer / circuit. **No aggregation here.** Computing features is the ML teammate's job. | `pole` (with `zone_id`), `line` (with `zone_id`) |
| **4** | Facilities → nearest device / circuit. Internal **priority aggregate** (Life Support counts + critical facilities per device). **Stays local, never uploaded.** | `device_priority` (app only) |

### 4.4 Done checklist (before models start)

- Row counts match the source (customers 117,642; damage 1,659; poles 107,013; …) or the difference is explained
- Every `premise` has a circuit, and every chain device exists in `device`
- Damage match rate reported, and Feb 2025 labels produce a sensible outage share
- No address or road fields in any processed file, and no premise-level Life Support flag
- `data/processed/README.md` lists every table, its row count and any known gaps

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

### 5.1b Supporting models that feed the simulator

Restoration time itself is **not** a trained model. The data has no crew counts, no network details and only day-level repair dates, so a trained model couldn't respond to judges' changes or explain itself. Instead, two trained models supply the simulator's **inputs**, where the data does record the outcome:

```
 trained models (learned from data)        simulator (labor workbook + rules)
   outage risk  ───────────────────────►  risk card
   expected damage per zone  ──────────►  damage list ─┐
   access-problem chance per zone  ────►  job adders  ─┼► crews, order, delay → time range
```

**Expected-damage model**

| Item | Plan |
|---|---|
| Unit | Protective-device zone: the area downstream of each fuse or recloser. Pooled up to the circuit where zones have too little data. |
| Target | Count of damage items per zone, **by type**: pole, primary wire, transformer, fuse/recloser/switch, secondary/service. Uses quantity (`Media`) where valid, otherwise 1 per record. |
| Model | **Poisson regression** (a count model) per damage type. Negative binomial if the counts are too spread out for Poisson. |
| Features | overhead primary length in zone · pole count, average age and wood share · number of transformers · overhead vs underground share · damage history in *other* events |
| Training / validation | Train on Feb 2025 zone counts, test on Sep 2024 (rank correlation of zones + error on total counts). Report both in the assumptions panel. |
| Storm severity | The slider multiplies expected counts (0.5×–2.0×) |
| Output to simulator | An expected count per type for every zone on the customer's circuit. Each Monte Carlo run **samples** the actual counts from those expectations, which is a main source of the P10–P90 spread. |
| Explanation | "We expect about 3 broken poles and 5 downed wire spans on your circuit in a storm like this, mainly because of 14 mi of overhead line with 1960s wood poles." |

**Access-problem model**

| Item | Plan |
|---|---|
| Unit | Damage record (1,658 labelled with `Access_Iss` yes/no, 32% yes) |
| Model | **Logistic regression** (yes/no) |
| Features | local customer density (rural vs town) · asset type · overhead vs underground · pole density and age in the area · distance to the nearest circuit main line. **`Special_Eq` is excluded:** it's written on the same report, so it would leak the answer. |
| Training / validation | Train on Feb 2025, test on Sep 2024 + other events (AUC) |
| Output to simulator | An access-problem probability per zone. In each Monte Carlo run, each job gets the access adder (+0.5 h × ILM) with that probability. |
| Stretch | Same approach for **special equipment needed** (backyard bucket / track hoe → +0.5 h / +1.31 h adders) |

**Judge overrides.** Model outputs are defaults, never locks. Damage has a **"Model expected / Replay Feb 2025"** switch plus "+ add damage". Access is a three-way control: **Auto (model) / Force on / Force off**. The before/after note says which one changed: "Access: Auto (38% chance) → Force on: 10–26 h → 13–31 h".

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
1. **Damage scenario** for the customer's circuit: by default, sampled from the **expected-damage model** (§5.1b) at the chosen storm severity, with access adders drawn from the **access-problem model**. Alternative mode: replay that circuit's actual Feb 2025 damage. Judges can also add or remove damage directly ("+1 broken pole on your line").
2. **Crews** (slider, for example 1–10 on the circuit) work jobs in **priority order**: (1) circuit breaker / main line, (2) devices serving hospitals, fire, EMS or priority customers, (3) devices with the most customers downstream, (4) everything else.
3. **Start delay** (slider): no climbing in high winds plus assessment time, default 6 h.
4. **Dependencies:** the customer is restored when **every job on their chain** is done. **Step restoration:** where a switch can isolate a damaged section further down the line, upstream customers are restored when their own section is clear.
5. **Range:** run about 200 Monte Carlo simulations varying ILM (3.5–5.5), job hours (±30%), damage count and start delay (±50%). Show **P10–P90** as "likely X–Y hours" and the median as the most likely value.
6. **What moves it:** show the top 2 drivers ("adding 2 crews cuts about 6 h", "a broken pole upstream of you adds about 8 h").
7. **Sanity check:** in a Feb-2025-like scenario, about 90% of customers should be restored within about 2 days, matching the historical repair dates.

**Scenario controls judges can change.** The brief says to *"update the estimate when damage, crew, access, or network assumptions change"*, so each of those four has a control:

| Brief input | Control | Effect in the simulator |
|---|---|---|
| Damage | Storm severity (0.5×–2.0×) · **Model expected / Replay Feb 2025** switch · **+ add damage** (pole / wire span / transformer on the customer's line) | Scales the expected (or replayed) damage; added items go into the job queue on the customer's chain |
| Crew | Crews on circuit (1–10) | More jobs run in parallel |
| Access | Access **Auto (model) / Force on / Force off** · start delay (0–24 h) | Auto: each job gets the access adder with the model's probability · Force: every job or no job · delay shifts all start times |
| **Network** | **Switching available** on/off | On: step restoration is allowed, so customers upstream of an isolated section are restored early. Off: everyone waits for the whole section. |
| | **Upstream device failed**: pick a fuse or recloser on the customer's chain | Adds a device repair job that blocks the customer until done, and lists it as a dependency |
| | **Prioritize critical facilities** on/off | On: jobs feeding hospitals / fire / EMS / priority customers jump the queue. Off: pure customers-downstream order. Shows how the customer's queue position changes. |

**Before/after explanation.** Every change re-runs the simulator with the same random seed, so the difference comes only from the input. The UI and chat then show a short delta note:
- **What changed:** "Crews: 2 → 6"
- **Result:** "Likely restoration 10–26 h → 6–14 h (most likely 17 h → 9 h)"
- **Why:** the biggest contributor to the change, taken from the simulator. For example: "the 3 jobs ahead of you in the queue now run at the same time", or "with switching off, you wait for the broken pole 1.2 mi downstream of your fuse to be fixed".
- A **Reset to defaults** button, and the last 5 changes kept in a small history list so judges can compare.

The same delta logic applies to the risk card when storm severity changes ("Moderate 32% → High 51%: storm severity 1.0× → 1.5×").

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
| Tools | `get_my_context(premise_id)` → circuit area, service type, data-coverage level<br>`get_outage_risk(premise_id, storm_severity)` → band, probability, confidence, top factors<br>`estimate_restoration(premise_id, crews, storm_severity, start_delay_h, access_issues, extra_damage, switching_available, failed_upstream_device, prioritize_critical)` → P10/P50/P90, drivers, assumptions<br>`compare_scenarios(premise_id, baseline, changed)` → before/after range and the main reason for the difference (answers "what if…?" and "what changed?")<br>`get_preparation_guidance(premise_id, declared_needs)` → checklist + safety items<br>`check_alert_eligibility(premise_id, declared_needs)` → rules met, channel, timing, escalations<br>`draft_message(premise_id, message_type)` → message text<br>`explain_assumptions()` → assumptions and limitations list |
| System prompt rules | Plain language at about an 8th-grade reading level · **only state numbers that came from a tool** · always label estimates and give the range plus confidence · name the main reasons · never reveal other customers, addresses, Life Support flags, crew data or exact sensitive-facility locations · emergency / downed line → 911 and stop · if a tool returns a fallback, say so honestly · stay on topic (storm outages) |
| Scope of chat | The four brief questions plus "why?", "what if more crews?" and "what changed?". Scenario questions call the tool with new parameters, so the chat and the sliders stay consistent. |
| Audit trail | Every turn logged (JSON lines) with **personal details removed**: random session ID (not the premise ID), question with phone numbers / emails / addresses stripped, tools called, sanitized tool outputs, final answer, timestamp. Declared needs are logged only as yes/no. Logs are deleted automatically after 7 days (or right after judging). Viewable on a hidden "Audit" tab during judging. See §9b. |
| Offline fallback | No API key or network → a simple intent matcher maps the four questions to the same tools and answers from templates. The demo never depends on the network. |

---

## 7. REST API (component 3)

| Endpoint | Returns |
|---|---|
| `GET /premise/lookup?lat=&lon=` or `?id=` | Nearest premise (own session only) + circuit area outline |
| `GET /risk/{premise}?severity=` | Risk band, confidence, factors |
| `POST /restoration/{premise}` (scenario body, including the network options) | P10/P50/P90, drivers, assumptions |
| `POST /restoration/{premise}/compare` (baseline + changed scenario) | Before/after ranges and the reason for the difference |
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
│                      │ Network: [switching ☑] │                      │
│                      │ [upstream fail ▾]      │                      │
│                      │ [critical first ☑]     │                      │
│                      │ Δ crews 2→6: 10–26h →  │                      │
│                      │   6–14h (jobs parallel)│                      │
│                      │ [Reset] · history      │                      │
├──────────────────────┼────────────────────────┤                      │
│ PREPARE              │ ALERTS & MESSAGES      │                      │
│ ⚠ SAFETY box         │ eligible ✔ · SMS+email │                      │
│ ☐ checklist…         │ ▶ Play storm  T+6h     │                      │
│ ☐ I use medical eqp. │ [feed of 4 messages]   │                      │
└──────────────────────┴────────────────────────┴──────────────────────┘
  Footer: "Model estimates, not official AEP information" · Assumptions ⓘ
          "Your location and needs are used only for this session" · [Clear my data]
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
| Audit trail (personal details removed, auto-deleted after 7 days) | Chat log |
| Session-only data + "Clear my data" button | API session store, UI (§9b) |
| Input validation (premise IDs, slider bounds, prompt-injection-resistant system prompt) | API + chat |

---

## 9b. Data handling and retention

**Principle:** collect the minimum, keep it only as long as the session needs it, and never store health information.

| Data | Where it lives | Retention |
|---|---|---|
| Provided challenge data (anonymized AEP extracts) | `data/raw/`; extracted and processed files gitignored | Kept for the hackathon. Use afterwards follows AEP / HackOHI/O terms. |
| Selected premise / location | Server memory, keyed by a random session ID | Cleared when the session ends, after 30 min of inactivity, or on **Clear my data** |
| Declared medical / accessibility needs | Server memory only, **never written to disk** | Same as the session. Logged only as "declared need: yes/no". |
| Scenario settings (sliders, change history) | Browser memory + server session | Same as the session |
| Chat messages | Server memory for the conversation | Same as the session. Personal details stripped before any logging. |
| Audit log | Local JSON-lines file | Personal details removed (§6). Auto-deleted after 7 days or right after judging. |
| Requests to Claude | Sent to the Anthropic API | Only the user's question (personal details stripped) and sanitized tool outputs are sent. Covered by Anthropic's API data-retention policy. |

**What users see**
- Footer note: *"Your location and any needs you share are used only for this session and are not stored."*
- **Clear my data** button: ends the session, wipes server memory for it, resets the UI.
- An assumptions-panel entry explaining what the audit log keeps, for how long, and that it holds no personal details.

**Out of scope:** a production AEP deployment would follow AEP's own legal and regulatory retention requirements. This prototype doesn't claim to set them.

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

## 10b. AWS setup (data cleaning + model training)

**One AWS account, one region, one S3 bucket, one SageMaker Studio domain**, shared by the data owner and the ML teammate.

```
 S3 bucket  aep-outage-concierge-<team>
 ├── raw/          the 3 zips, labor xlsx, drawings pdf (uploaded once)
 ├── processed/    cleaned parquet tables, one folder per batch (data owner writes)
 ├── features/     model-ready feature tables (ML teammate writes)
 └── models/       trained model files + metrics.json + feature list (ML writes)

 SageMaker Studio (JupyterLab spaces)
   data owner: prep notebooks/scripts  →  reads raw/, writes processed/
   ML teammate: feature + training notebooks → reads processed/, writes features/, models/
```

**Data cleaning on AWS**

| Option | Verdict |
|---|---|
| **SageMaker Studio JupyterLab** (Python: pandas, geopandas / pyshp, pyarrow) | ✅ **Use this.** The same Python cleaning code runs as-is, it handles shapefiles and spatial matching, and it's the same tool the ML teammate uses. A mid-size CPU instance (e.g. `ml.m5.xlarge`) is enough for these files. |
| SageMaker Processing job | Optional: re-run the final cleaning scripts as one repeatable job once they're stable |
| AWS Glue / Glue DataBrew | ❌ Built for big tabular data. No native shapefile support, and spatial joins and the equipment-chain parsing are awkward. Overkill at this size (~32 MB compressed). |
| Athena (SQL) | Optional: quick SQL checks on the cleaned parquet. Not for the cleaning itself. |

**Model training on AWS (ML teammate)**

| Item | Plan |
|---|---|
| Where | SageMaker Studio notebooks with scikit-learn (logistic regression, Poisson regression). Small data, so no GPU and no distributed training needed. |
| Tracking | SageMaker Experiments (or a simple `metrics.json` per run): AUC / calibration on Sep 2024, feature list, run date |
| Output | `models/<model>/model.joblib` + `metrics.json` + `features.json` + coefficient table (for explanations) |
| Serving | **The app downloads the model files from S3 and predicts locally.** No always-on SageMaker endpoint: cheaper, faster, and the demo still works if AWS is slow. A live endpoint is an optional stretch to show off. |
| Hand-off contract to the app | Agree on day 1: a `predict_risk(features) → {probability, band, top_factors}` style interface, plus the same for expected damage and access probability |

**Claude for the chatbot (open decision):** the same Python SDK works either directly against the Anthropic API or through **Amazon Bedrock** (Claude Opus 5.5 is on Bedrock; only the client setup differs). Bedrock keeps everything in one AWS account.

**Rules**
- **Check first** that the organizers allow uploading the challenge data to a cloud account. Add this to the mentor questions.
- **Upload only what's needed:** no addresses or road names, and no premise-level Life Support flag. The `device_priority` aggregate stays off AWS (§4.3).
- **Access:** one IAM role per teammate, scoped to this bucket; bucket encryption on, public access blocked.
- **Cost:** stop JupyterLab spaces when idle, delete any endpoint after the demo, set a billing alert.
- **Retention:** delete `processed/` and `features/` after the hackathon per §9b (keep only the code).

---

## 11. Build plan (assuming a ~24 h hackathon, team of 3)

| Role | Owns |
|---|---|
| **Data owner (you)** | All data cleaning and linking on AWS (§4, §10b) → then, by default, the **backend API, restoration simulator and chatbot** (open decision, see below) |
| **ML teammate** | AWS setup for training, **feature engineering**, the three trained models (risk, expected damage, access), validation, model files + predict interface (§5.1, §5.1b, §10b) |
| **Dashboard teammate** | The whole UI (§8): map, panels, scenario controls, before/after notes, timeline player, notifications, chat panel, accessibility |

| Phase | Hours | Data owner (you) | ML teammate | Dashboard teammate |
|---|---|---|---|---|
| 0 Setup | 0–0.5 | S3 bucket + raw upload, `prep/common.py`; agree data contract with ML and API contract with dashboard | SageMaker Studio domain, IAM roles, billing alert | UI wireframe from the API contract |
| 1 Cleaning | 0.5–3 | **Batch 1**: customers, chains, transformers, devices, areas → S3 (one-circuit sample at ~1.5 h) | training pipeline skeleton on the sample; baseline features | map + panels on mock JSON |
| 1b | 3–5 | **Batch 2**: damage → matching → **labels** → S3 | first risk model on labels + simple features | risk card, restoration panel, sliders (mock) |
| 1c | 5–8 | **Batch 3**: poles + lines with area IDs → S3 · **Batch 4**: facilities, labor, repair bundles, priority (local) · done checklist (§4.4) | feature engineering from poles / lines / areas; expected-damage + access models | network controls, before/after note, guidance panel (mock) |
| 2 Build | 8–13 | restoration simulator (bundles + ILM + crews + order + Monte Carlo); API endpoints | validation on Sep 2024, calibration, coefficient → plain-language factor templates | timeline player, notifications feed, chat panel (mock) |
| 3 Integrate | 13–18 | load model files from S3 into the API; chatbot with tools, guardrails, audit log, offline fallback | export final model files + `metrics.json`; support API integration | switch UI from mock JSON to the real API |
| 4 Polish | 18–22 | guardrail tests (privacy, 911), sanity checks vs Feb 2025 | assumptions-panel metrics, model limitations text | accessibility, labels, layout fixes |
| 5 Demo | 22–24 | rehearse | rehearse | rehearse the 5-minute script |

**Contracts agreed at hour 0 so nobody waits:**
- **Data owner → ML:** table names and columns in S3 (the data dictionary, §4.0), plus the upload order Batch 1 → 2 → 3
- **ML → app:** model file layout in `models/` and the predict interface (§10b)
- **App → dashboard:** API endpoints and JSON shapes (§7). The dashboard builds against mock JSON with exactly those shapes.

**Open decision: who builds the backend + chatbot?** The default above is you, from hour 8. You'll know the data best by then, and the restoration simulator uses tables you cleaned. That makes your load the heaviest, so if the dashboard teammate finishes early they can take the audit log and offline fallback.

**Cut list if time runs short** (in order): gradient-boosted model → special-equipment model → access model (use the 32% historical rate everywhere) → expected-damage model (use Feb 2025 replay only) → Monte Carlo (use fixed optimistic/pessimistic cases) → step restoration → damage heat layer. **Never cut:** controls for all four brief inputs (damage, crew, access, network) updating the range with a before/after note, the 4 messages, confidence + fallback, privacy refusals.

---

## 12. Demo script (5 minutes)

1. **Scope (20 s):** "Residential customers, Roanoke Valley, Feb-2025-style storm."
2. **Pick a premise** on a hard-hit circuit → High risk, Medium confidence, 3 reasons (MVD 1–2).
3. **Change crews 2 → 6** → range shrinks, with a before/after note. Toggle access issues → it grows. Turn **switching off** or **fail an upstream fuse** → the range grows and the note names the dependency. Then invite a judge to change any input themselves (MVD 3, "change one input").
4. **Tick medical equipment** → guidance and escalation change (MVD 4).
5. **Play storm** → 4 messages appear in sequence (MVD 5).
6. **Chat:** "Will I lose power?", "Why will it take so long?", "What if more crews come?"
7. **Guardrails:** "Who else on my street has life support?" → refused. "Where's the nearest hospital, I'm having chest pains" → 911. A premise with missing data → fallback. Press **Clear my data** and show the session is wiped (MVD 6).
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
7. **New:** are we allowed to upload the challenge data to our own AWS account (S3 / SageMaker)?

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Spatial matching of damage to the network is noisy | Use the provided `NEAR_FID` / `NEAR_DIST` where valid, and cap the match distance. Report the match rate. |
| Weak risk model (few events) | Present it honestly with a validation score and confidence. Fall back to transparent weighted scoring if logistic regression underperforms. |
| Sparse zone damage counts (65 circuits hit in Feb 2025, many zones with 0) | Pool zones up to the circuit level, use a count model that handles many zeros, and fall back to Feb 2025 replay where the model fits poorly |
| Access model learns little (no terrain or road data) | Report its AUC honestly. If it's near chance, use the 32% base rate and say so. |
| Restoration numbers look unrealistic | Sanity-check against Feb 2025. Show the assumptions and let judges adjust them. |
| API or network down during judging | Offline chat fallback + template messages |
| Geospatial packages fail to install | Python 3.12 virtual environment. pyshp needs no compiled dependencies. |
| LLM says something unsafe or made up | Tools-only numbers, sanitized tool outputs, guardrail prompt, audit log, scripted guardrail tests before the demo |
