# Existing solutions: analysis for the AI Outage Concierge

Purpose: evidence for the **Innovation** criterion in [JUDGING_CRITERIA.md](../05-judging/judging-criteria.md) (research accepted solutions, find their strengths and weaknesses, then explore a better alternative). It also feeds **Impact** (research-backed justification) and **Breadth** (domains we draw on).

Researched 2026-10-24 from public sources (linked at the end). Vendor claims are as reported by the vendor and were not independently tested.

## The problem in one line

Before and during a storm, a residential customer wants to know: *Will I lose power? For how long? What should I do? Will I be told?* Today, no single tool answers all four for a specific home, ahead of time, with reasons.

## Why it matters (Impact evidence)

- Sustained power interruptions cost US customers about **$44 billion a year** (LBNL, 2018, in 2015 dollars).
- **Communication accounts for 54%** of customer satisfaction during outages (McKinsey, via T&D World). Customers who were "very satisfied" with their utility fell 11 points since 2018.
- Underestimating restoration time hurts satisfaction more than a modest overestimate (Exelon research, 2025). Customers treat an ETR as a promise even though utilities call it an estimate.
- A refrigerator keeps food safe for about 4 hours and a full freezer about 48 hours (Ready.gov), so the *duration range* decides which preparation steps matter.

## The accepted solutions

### 1. Utility outage maps, "My Outage" pages and outage alerts (incl. AEP / Appalachian Power)

What it is: a public map of current outages, a per-account outage status page with ETR and cause, and opt-in text/email alerts sent when an outage is reported, then as cause and ETR are known.

| Strengths | Weaknesses |
| --- | --- |
| Official and trusted; already deployed to every AEP customer | **Reactive:** says nothing until the power is already out |
| Real-time status from the outage management system | ETR is usually **one time stamp**, often "assessing" for hours in big storms, with no range or reason |
| Simple channels (text, email, app) | No explanation of *why* it will take that long, or what could change it |
| | Same message for everyone; no tailoring for medical or accessibility needs beyond separate programs |
| | Maps often overload during major events |

### 2. Data-driven restoration estimates (for example Exelon's ETR model)

What it is: machine-learning models that predict customer-specific ETRs from historical and live outage data. Exelon's Longitudinal Tabular Transformer re-estimates as updates arrive and improved a customer-satisfaction-weighted metric by about **19%** over existing methods across 34,000 storm outages.

| Strengths | Weaknesses |
| --- | --- |
| Measurably more accurate than manual estimates | Internal tool; the customer still sees one number |
| Updates over time; uses asymmetric, customer-informed error metric | Only works **after** an outage exists in the system |
| Uses SHAP/attention for internal explainability | Needs rich live OMS data; does not expose the physical drivers (damage type, labor, dependencies) |
| | The paper notes most utilities still rely on **manual** ETR assessment |

### 3. Storm outage prediction for operators (UConn/Eversource OPM, E Source Storm Outage Insight, Urbint/Itron Storm Impact, DTN)

What it is: models that combine weather forecasts, vegetation and infrastructure data to predict how many outages a storm will cause, so utilities can pre-stage crews and request mutual aid. The UConn model serves about 1.8 million customers with a 3 to 5 day useful window; E Source reports a 20% accuracy gain three days out.

| Strengths | Weaknesses |
| --- | --- |
| Days of lead time; proven operational value | **Operator-facing:** customers never see the output |
| Strong weather and vegetation science | Predicts **counts per town or region**, not risk for a given home |
| Validated over many storms | Does not use circuit topology to say *which* customers share a failure point |
| | Ice storms and extreme winds are weak spots (UConn excludes ice storms from its accuracy claim) |

### 4. Grid-resilience planning AI (for example Rhizome)

What it is: AI that combines equipment, maintenance, historical weather and GIS data to rank resilience investments (undergrounding, vegetation, hardening) at roughly kilometer resolution.

| Strengths | Weaknesses |
| --- | --- |
| Asset-level risk from GIS, close to our data | Long-term **planning** tool, not storm-event guidance |
| Helps prevent outages, not just respond | No customer experience, restoration estimate or communication |

### 5. AI customer-service agents for utilities (Capacity at SECO Energy, Talkdesk, Omilia, Teneo)

What it is: chat and voice bots that verify the caller, look up the outage, report status and take reports. SECO Energy reports the virtual agent handles 32% of calls and cut cost per call by 66%.

| Strengths | Weaknesses |
| --- | --- |
| Handles call surges during storms | Only **relays** what the outage system already knows; no prediction |
| 24/7, multichannel | Generic answers; little personal preparation advice |
| Proven cost savings | Generative bots risk inventing numbers if not grounded in tools |
| | Rarely explain uncertainty or what would change the estimate |

### 6. Third-party outage trackers (PowerOutage.us)

What it is: aggregates outage counts from 900+ utility feeds at county, city and state level, with history.

| Strengths | Weaknesses |
| --- | --- |
| National coverage; stays up when utility maps fail | County-level counts only; after the fact; no ETR or advice |

### 7. Priority-customer programs (for example PG&E Medical Baseline)

What it is: enrolled customers with medical needs get extra alerts (repeated calls, texts, doorbell rings) before planned shutoffs.

| Strengths | Weaknesses |
| --- | --- |
| Recognizes that some customers face life-safety risk | Mostly tied to **planned** shutoffs, not storm risk |
| Escalation until the customer acknowledges | Requires prior enrollment; guidance is not tailored to the expected duration |

### 8. Public preparedness guidance (Ready.gov / FEMA, Red Cross)

| Strengths | Weaknesses |
| --- | --- |
| Authoritative, safety-tested advice (food timing, generator CO safety, medical devices) | One-size-fits-all; not tied to *your* risk or *your* likely outage length |

### 9. Academic outage models (for example Arora & Ceferino, NYU, 2023)

Statistical and ML models (negative binomial GLM, GAM, random forest) of hurricane outages across 1,910 US cities.

| Strengths | Weaknesses |
| --- | --- |
| Rigorous uncertainty quantification | City-level; overpredicted outages in about 20% of cities; weak at extreme winds; no duration |

## Gaps the AI Outage Concierge can fill

Each gap is something none of the solutions above does for a residential customer.

1. **Personal risk before the outage.** Premise-level risk band using the customer's own upstream chain (transformer, fuse, recloser), nearby asset condition and past damage. Operator tools predict counts by region; customer tools say nothing until the lights go out.
2. **Restoration as an explained range, not a single promise.** Build it bottom-up from damage type × STORMS labor hours × travel/nonproductive multiplier × upstream dependencies and step restoration. Customers see *why* (for example "a pole upstream of you takes about 6 crew-hours") and what would move it. Bias toward slight overestimates, since research shows under-promising hurts trust.
3. **"What if" controls.** Let the customer (and judges) change crews, storm severity or access and watch the range update. No current customer tool exposes this.
4. **Guidance keyed to duration and declared needs.** Combine Ready.gov thresholds (4 h fridge, 48 h freezer, generator safety) with the predicted range and any declared medical or accessibility need, without inferring sensitive attributes.
5. **Proactive, pre-storm alerts with escalation rules.** Move alerts earlier than "outage reported," and borrow Medical Baseline-style escalation for declared needs.
6. **A grounded AI assistant.** The chatbot can only call our analytics tools, so it cannot invent numbers or leak data. This answers the main weakness of generic utility bots.
7. **Responsible-AI by design.** Confidence levels, labeled "model estimate" vs "confirmed", a clear fallback when data is missing, and privacy filters.

## Contrarian views to present to judges (Innovation, 5 pts)

| Accepted norm | Our challenge |
| --- | --- |
| Customers get an ETR after the outage | Customers get a risk and duration range *before* the storm |
| ETR is a single time | ETR is a range with named drivers, and it is updatable |
| Outage prediction is for operators | The same physics and network data can serve customers directly |
| Utility chatbots read out status | The assistant reasons over damage, labor and topology, and explains |
| Preparation advice is generic | Advice depends on *your* risk, *your* likely duration and *your* declared needs |

## How each criterion uses this research

- **Innovation:** present the tables above and the contrarian views; show one alternative we tried and why it was better (log it in the challenges log).
- **Curiosity:** questions this raised, for the questions log: "Can topology replace missing weather data?", "Is a range more trusted than a time?", "Which damage types dominate restoration time?"
- **Communication:** a slide comparing our journey with today's AEP outage journey.
- **Breadth:** domains combined: power engineering, GIS, graph analysis, statistics/ML, LLMs, crisis communication and behavioral research, public-health preparedness, accessibility, privacy.
- **Impact:** cite the LBNL cost and McKinsey 54% figure; feasibility argument: uses only data AEP already has, and plugs into existing alert channels.
- **Navigating challenges:** note limits found here (no weather data, ice storms are hard, single-number ETRs backfire) and how we designed around them.

## Sources

- AEP Ohio individual outage information (2013): https://crawfordcountynow.com/local/individual-outage-information-now-available-online-for-aep-customers/
- Appalachian Power outage alerts (2015): https://www.wsls.com/news/2015/03/04/appalachian-power-introduces-new-outage-alerts-system
- Exelon, *Predicting ETRs Using Longitudinal Tabular Transformers* (2025): https://arxiv.org/pdf/2505.00225v1
- Exelon customer-specific ETR session: https://www.utilityanalyticsweek.com/2023/session/1564289/505-exelon's-predictive-algorithm-generates-customer-specific-outage-detection-estimates-improving-speed-and-availability-of-etr
- UConn / Eversource Outage Prediction Model: https://www.eversource.uconn.edu/storm-outage-forecasting/did-you-know
- E Source Storm Outage Insight case study: https://www.esource.com/case-study/utility-improves-storm-outage-prediction-accuracy-20
- Itron (Urbint) resiliency solutions: https://na.itron.com/what-we-offer/resiliency-solutions-overview
- Rhizome (Tech Brew, 2025): https://www.techbrew.com/stories/2025/05/21/rhizome-grid-resilience-startup
- AI outage management examples incl. SECO Energy: https://capacity.com/?p=33278
- Communication drives 54% of outage satisfaction: https://www.marketscale.com/industries/energy/communication-drives-54-of-customer-satisfaction-during-power-outages
- Enhancing outage communications: https://www.renewableenergyworld.com/power-grid/outage-management/enhancing-outage-communications-part-2/
- PowerOutage.us: https://poweroutage.us/about
- PG&E Medical Baseline: https://www.pge.com/en/account/billing-and-assistance/financial-assistance/medical-baseline-program.html
- Ready.gov power outage tips: https://www.cpp.edu/em/documents/power-outage-safety-tips-readygov-pdf.pdf
- LBNL, cost of sustained interruptions (2018): https://emp.lbl.gov/publications/improving-estimated-cost-sustained
- Arora & Ceferino, NHESS (2023): https://nhess.copernicus.org/articles/23/1665/2023/nhess-23-1665-2023.html
