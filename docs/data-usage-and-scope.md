# Project scope and data usage

## Scope statement (for judges)

**AI Outage Concierge for residential customers of Appalachian Power in the Roanoke Valley, Virginia, during a severe wind / ice / heavy-rain storm.**

The extract covers 117,642 customer premises on 110 distribution circuits around Roanoke, Vinton, Salem, Blue Ridge, Troutville and nearby towns. The scenario is calibrated against the largest event in the damage data: **13–17 February 2025**, with 1,254 damage records on 65 circuits. A residential customer picks their premise on a map (or enters an anonymized premise ID) before and during that storm. The concierge then answers the four questions in the brief: *Will I lose power? How long could restoration take? What should I do to prepare? Do I qualify for outage alerts?*

| In scope | Out of scope |
|---|---|
| Residential customers in the supplied Roanoke-area extract | Other AEP operating companies or regions |
| Storm-damage outages on the distribution network (poles, primary/secondary wire, transformers, fuses, reclosers, switches) | Transmission and substation failures, planned outages, billing |
| Pre-storm risk, restoration-range estimate, preparation guidance, alerts and messages | Crew dispatch, real outage-management integration, live weather feeds |
| A simulated storm timeline using historical damage patterns | Real-time telemetry (none is supplied) |
| Medical / accessibility needs **only when the customer declares them** | Inferring health or vulnerability from data |

Demo focus: the full extract is loaded, but the walkthrough uses the hardest-hit circuits from February 2025 (for example CIR2, CIR10, CIR72), where the damage data is densest.

---

## What the supplied data contains

| Dataset (file) | Records | Key fields we use |
|---|---|---|
| **ARCOS damage assessments** (`arcos_prod_damage_09_28_Clip`) | 1,659 | `Report_Tim`, `Repaired_D`, `Substation`, `Circuit`, `Asset_Type` (primary 704, pole 355, fuse bank 280, secondary 156, transformer 74, recloser 58, …), damage type (`Inform_Wor`: wire 861, switch 357, pole 355, equipment 81), quantity (`Media`, 0–6), `Access_Iss` (yes on 32% of records), `Special_Eq` (backyard bucket, track hoe, …), `Latitude`/`Longitude` |
| **Customers** (`Customer_Clip`) | 117,642 | `premise_nu` (anonymized), `circuit_id`, `aep_xfmr_l` (transformer), `kind_of_se` (overhead 64,824 / underground 52,419), service-point coordinates, city, `critical_c` (113 flagged Life Support) |
| **Upstream topology** (`matched_upstream.txt`) | 117,599 | For each premise: transformer, then the chain of fuses / reclosers, then the circuit breaker |
| **Poles** (`Pole_Clip`) | 107,013 | Install date, material (78k pine), height, class |
| **Primary / secondary lines** (`Primary_ExportFeatures`, `Secondary_ExportFeatures`) | 62,788 / 127,403 segments | Circuit, overhead/underground, voltage, conductor spec, length |
| **Transformers** (`Transformer_Clip`) | 26,959 | kVA size, pole-mount vs pad, phase, circuit |
| **Fuses / reclosers / switches** (`Fuse_Bank_Clip`, `Recloser_Bank_Clip`, `Switch_Clip`) | 7,616 / 331 / 900 | Device type, rating, normal state, circuit, automation (recloser) |
| **Hospitals / fire stations / ambulance** (`*_Pairwis_Clip`) | 5 / 37 / 10 | Public USGS facility points |
| **Labor workbook** (`Install_Labor_HackOHIO.xlsx`) | 6 sheets | Install/removal hours per compatible unit (pole by size 1.9–3.4 h, transformer by kVA ~1.2–1.4 h, crossarm, insulator, guying …), labor-only adders (restricted access 0.5 h, remote site 1.31 h, …), **Indirect Labor Multiplier = 4.5** (drive, safety briefing, setup) |
| **Structure drawings** (`structure_drawings.pdf`) | 9 drawings | Pole-top assemblies: crossarms, insulators, cutouts, arresters, transformer mounts, guying, dead-ends |

Joins: customer `circuit_id` `0000060` is the same circuit as ARCOS / GIS `CIR60`. Premise → transformer → protective devices comes from `matched_upstream.txt`. Damage points are matched to assets by spatial nearest-neighbour (ARCOS already carries `NEAR_FID` / `NEAR_DIST`).

---

## Data use by requirement

### Requirement 1 — Outage-risk prediction

| Data | How it is used |
|---|---|
| Customers + upstream topology | The customer selects a premise. We look up its transformer, every fuse and recloser above it, and its circuit. This exposure path is what can fail and cut their power. |
| ARCOS damage (Feb 2025 event) | **Training label.** A transformer or protective-device zone is labelled "damaged" if a damage record falls on its path. This gives a historical outage rate per zone. |
| ARCOS damage (Sep 2024 and other events) | **Held-out validation.** We train on one event and test on the others, which gives an honest confidence number instead of a guess. |
| Poles | Features: age (install date), material, height and class of poles along the premise's path. Older, smaller wood poles carry more risk. |
| Primary / secondary lines | Features: overhead length on the path (exposure to trees and wind) and the share of underground line. |
| Customer `kind_of_se` | Feature: overhead vs underground service drop. |
| Fuses / reclosers / switches | Features: number and type of devices between the premise and the substation. A recloser can clear temporary faults, while a single fuse on a long lateral is a weak point. |
| Storm scenario (simulated input) | No weather data is supplied, so a storm-severity slider scales the risk. "Feb-2025-like" = 1.0×. This is shown as an assumption. |

**Output:** Low / Moderate / High / Very High risk band, a confidence level from validation accuracy and how much data covers that area, and the top 3 contributing factors in plain language (for example, "your power comes through 2.3 miles of overhead line with 1960s wood poles").

### Requirement 2 — Restoration-time estimate

| Data | How it is used |
|---|---|
| ARCOS damage types and quantities | Build the scenario's damage list: what broke (`Asset_Type`, damage type) and how many (`Media`). We sample from the February 2025 pattern for the customer's circuit. |
| Structure drawings | Translate each damage type into the parts that must be replaced. For example, a broken pole means a new pole plus crossarm, insulators, pins, guying and grounding, and a damaged transformer means a transformer plus cutout, arrester and leads. |
| Labor workbook (per-unit hours) | Sum the install + removal hours for those parts. Pole hours depend on height (from the Pole table), and transformer hours on kVA (from the Transformer table). |
| Labor workbook (adders) | Add hours when the ARCOS record shows `Access_Iss` = yes (restricted access), or `Special_Eq` = backyard bucket / track hoe (confined property, specialised handling). |
| Labor workbook (ILM 4.5) | Multiply direct hours by 4.5 to cover travel, safety briefing and setup. |
| Upstream topology | **Dependency order.** The customer is restored only after every damaged device above them is repaired. |
| Switches / reclosers | **Step restoration.** Where a switch can isolate a damaged section, upstream customers are restored earlier. |
| Hospitals / fire / EMS | **Priority sequencing.** Circuits feeding critical facilities are repaired first, which can push other customers later in the queue. |
| ARCOS Feb 2025 report→repair dates | Sanity check: 90% of February 2025 repairs closed within 2 days, so the modelled range must be consistent with that. |

**Output:** a range (for example, "likely 8–20 hours"), not a single time. It is driven by user-adjustable inputs: **number of crews, storm severity, damage count, road-access problems**. Every figure is labelled *Model estimate*, never *Confirmed*.

Worked illustration: replacing one 40 ft pole is about 0.93 h removal + 2.50 h install + crossarm and hardware ≈ 4 h direct. With a 0.5 h restricted-access adder that is ≈ 4.5 h, × 4.5 ILM ≈ 20 crew-hours, before dependencies and queue position.

### Requirement 3 — Personalized preparation guidance

| Data | How it is used |
|---|---|
| Risk band (Req 1) × restoration range (Req 2) | Select a guidance tier. For example, low risk and under 4 h means charge devices. High risk and over 24 h means plan for food, water, medication refrigeration and somewhere to stay. |
| Customer `kind_of_se` | Tailor advice. Overhead service gets "stay away from the drop line to your house and report it if it's down". |
| Customer-declared needs (opt-in toggle) | Adds medical-equipment / accessibility steps. The **Life Support flag in the data is never used to change what a customer sees.** |
| Hospitals / fire / EMS | "Where to get help" pointers at town level, never exact sensitive locations. |

Safety messages (downed lines, generator carbon monoxide, flooded equipment) are always visually labelled as **Safety / Emergency**.

### Requirement 4 — Alerts and proactive communications

| Data | How it is used |
|---|---|
| Risk band + restoration range | **Eligibility rules** (documented in the app). Example: eligible if risk ≥ High *or* upper estimate > 4 h. |
| Customer-declared medical need | Escalation trigger: earlier pre-storm notice and a phone call option. |
| Life Support flag + critical facilities (internal only) | Used only in aggregate to justify crew priority, for example "this circuit serves priority customers". Never shown to anyone. |
| Simulated storm timeline (from Feb 2025 report/repair sequence) | Drives the four messages: **pre-storm → outage confirmed → estimate updated → restored**. "Estimate updated" fires when the range moves by more than 2 h. |

The AI assistant drafts each message in plain language from the structured outputs, and recommends a channel (SMS / email / app push) and timing.

### Requirement 5 — Explainability and responsible use

| Data | How it is used |
|---|---|
| Model factor contributions (Req 1) and calculation breakdown (Req 2) | The chatbot explains answers **only from these tool outputs**. It never makes up numbers. |
| Data-coverage metrics (damage records near the premise, unknown pole heights/classes: about 18% of poles) | Lower the confidence and trigger the **fallback** ("we can't give a reliable estimate for your location; here's general guidance") when coverage is thin. |
| Privacy filter over all datasets | Never shown: street addresses, `premise_nu` outside the user's own session, Life Support flags, crew/job fields, exact critical-facility coordinates. Map shows aggregated zones, not other customers' points. |
| Assumptions panel | Lists every assumption: simulated storm severity, the ILM 4.5 average, which events were used for training, and day-level-only repair dates. |

---

## Known data limitations (stated openly)

- **No weather data.** Storm severity is a scenario input, not a forecast.
- **Repair dates are day-level, not hour-level,** and some look like administrative closeout (September 2024 median report-to-repair is 23 days). Restoration hours therefore come from the labor workbook. Historical dates are a sanity check only.
- **`Media` as quantity** is our interpretation of a 0–6 field, to be confirmed with AEP mentors.
- **Single region** (Appalachian Power, Roanoke area). Results are not claimed to generalise elsewhere.
- **ILM 4.5** is a single representative multiplier. The brief says it may be averaged across AEP operating companies, so it may not reflect travel times in this mountainous area.
