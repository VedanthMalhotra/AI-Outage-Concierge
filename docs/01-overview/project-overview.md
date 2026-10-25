# Project overview: what we're building and how it fits together

**Start here.** A one-page explanation of the AI Outage Concierge: what each part does, how the cleaned data is used, who builds what, and where things stand.

---

## The idea in one sentence

> We cleaned and linked AEP's network and storm-damage data, trained models to predict each home's outage risk and the damage on its circuit, and fed those into a restoration simulator and a chatbot that explains the results to customers in plain language.

The customer (a residential customer in the Roanoke Valley, before or during a storm like February 2025) gets answers to the four questions in the brief: **Will I lose power? How long could restoration take? What should I do to prepare? Do I qualify for outage alerts?**

---

## The parts

### Three AI models (trained by the ML teammate)

| Model | Question it answers | Learns from | Shown in the app as |
|---|---|---|---|
| **1. Outage risk** | "Will **my** home lose power in a storm like this?" | `outage_labels` (which homes lost power in Feb 2025) + area features: pole age, overhead line length, fuse vs recloser, past damage nearby | Risk card: **"High risk · Medium confidence"** + top 3 reasons |
| **2. Expected damage** | "How much will break on **my** circuit?" (poles, wires, transformers…) | `zone_damage_counts` + the same area features | Feeds the restoration simulator |
| **3. Access problems** | "Will crews have trouble reaching the damage?" (backyards, off-road) | `access_labels` (32% of reports had access problems) | Adds extra hours in the simulator |

All three are **trained on the Feb 2025 storm and tested on the Sep 2024 storm**. That held-out test gives the "confidence" level the brief asks for.

### The restoration simulator (not an AI model)

Restoration time is a **calculator**, deliberately. The data has no crew counts or network details, so a trained model couldn't respond when judges change those inputs. The simulator combines:
- expected damage (model 2) and access problems (model 3)
- AEP's labor-hours tables and the repair bundles from the structure drawings (× 4.5 travel/setup multiplier)
- crew count, repair order (critical facilities first), start delay, switching

Judges can change **damage, crews, access or network options** and see the time range move, with a before/after note explaining why.

### Rules (guidance and alerts)

- **Preparation guidance:** a checklist chosen by risk level × expected duration, plus declared needs (medical equipment, accessibility). Safety messages are always labelled, and emergencies → **call 911**.
- **Alerts:** written eligibility rules + four proactive messages (pre-storm, outage confirmed, estimate updated, restored), driven by a simulated storm timeline.

### The chatbot

The chatbot (Amazon Nova 2 Lite on Bedrock) **only explains results from the tools above**. It never invents numbers and never sees raw customer data. It gets the customer's location from the dashboard and answers in plain language with labels: *Model estimate*, *Confirmed*, *Your action*.

### The dashboard

Map (the customer's own pin + shaded circuit area + aggregated damage heat map), risk card, restoration panel with scenario controls, preparation checklist, alerts and storm timeline, and the chat panel. It's built against the mock data in [`mock/`](../../mock/README.md) first, then connected to the real backend.

---

## How it all connects

```
AEP raw data (data/raw)
   │  cleaned on AWS SageMaker  ✅ done
   ▼
Cleaned tables in S3 (15 files: network, damage + labels, poles + lines, labor tables)
   │
   ├─► ML teammate: features per zone → train 3 models → model files in S3 (models/)
   │
   ├─► Backend: restoration simulator + guidance/alert rules + LLM chatbot (tools)
   │        uses the model files + Batch 4 tables (labor, repair bundles, facilities)
   │
   └─► Dashboard: map, risk card, restoration sliders, alerts, chat
              mock data now → real backend later
```

---

## Who does what

| Person | Owns | Status |
|---|---|---|
| **Data owner** | All data cleaning on AWS → then (by default) the backend: simulator, rules, chatbot | Cleaning ✅ · backend next |
| **ML teammate** (Hanshil) | Feature engineering + the 3 models on SageMaker, validation on Sep 2024, model files → S3 | Can start now: data is in S3 |
| **Dashboard teammate** | The whole UI in [`web/`](../../web/) | First version pushed, on mock data |

---

## Current status

| Area | State | Details |
|---|---|---|
| Planning | ✅ | [MVP plan](../02-plan/mvp-plan.md), [scope](scope-and-data-usage.md), [standout features](../02-plan/feature-specs.md) |
| Research | ✅ | [Existing solutions](../03-research/existing-solutions.md), [judging criteria](../05-judging/judging-criteria.md) |
| Data cleaning | ✅ | 15 tables in S3, see [cleaned data notes](../04-data-and-aws/cleaned-data-notes.md) |
| Models | ⏳ | ML teammate |
| Backend + chatbot | ⏳ | Not started |
| Dashboard | 🔄 | `web/` first push, mock data in `mock/` |
| Pivot log | 🔄 | Keep adding to [navigating challenges](../05-judging/navigating-challenges.md) |

---

## AWS setup (facts we keep needing)

| Item | Value |
|---|---|
| Account access | Innovation Sandbox lease → **Login** → role `myisb_IsbUsersPS` |
| Region | **us-east-2 (Ohio)** |
| S3 bucket | `sagemaker-aep-outage-indiansassemble` (`raw/`, `processed/`, later `features/`, `models/`) |
| SageMaker | Domain `QuickSetupDomain-20261024T142267`, one user profile per person, JupyterLab on **ml.t3.medium** |
| Chatbot model | **Amazon Nova 2 Lite** (`us.amazon.nova-2-lite-v1:0`) on Bedrock, through the Converse API. |
| Budget | Plan for **$100** (lease page shows $300, the template name says $100). Cost data shows up about a day late. **Stop spaces when idle.** |

Full service list and costs: [aws-requirements.txt](../04-data-and-aws/aws-requirements.txt).

---

## Glossary

| Term | Meaning |
|---|---|
| **Substation** | Where high-voltage power is stepped down and sent out on circuits |
| **Circuit (feeder)** | One main power line leaving a substation and branching out to a neighbourhood. 110 in our data (`CIR72` etc.), about 1,000 customers each. |
| **Recloser** | A device on the line that resets itself after a brief fault (e.g. a branch touching the line) |
| **Fuse** | Protects a branch. It blows on a fault and a crew must replace it. |
| **Transformer** | Steps voltage down for homes. Usually 1–10 homes per transformer. |
| **Chain** | For one customer, the equipment feeding them in order: transformer → fuses/reclosers → circuit breaker |
| **Zone** | Everything downstream of a customer's first fuse/recloser. If that device trips, the whole zone is out. 6,664 zones, median 6 customers. |
| **ARCOS damage report** | A record of storm damage found by field crews: what broke, where, when, access problems |
| **ILM** | Indirect Labor Multiplier (4.5): converts hands-on repair hours into real crew time (travel, safety briefings, setup) |
| **Held-out storm** | A storm the model didn't train on (Sep 2024), used to test it honestly |
| **Parquet** | The file format of the cleaned tables: fast, small, keeps IDs and data types exact |
