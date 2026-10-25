# Technical summary: AEP "AI Outage Concierge" (HackOHI/O 2026)

How the finished build works, current as of submission.

## The challenge
AEP challenge brief: an AI assistant for **residential Appalachian Power customers in the Roanoke Valley (VA)** during major storms. Required (minimum demo):
1. Customer enters or selects an anonymized location (premise ID or map).
2. **Outage risk**: band, confidence, plain-language contributing factors.
3. **Restoration estimate** as a range that changes when a scenario input changes; separate "model estimate" from "confirmed".
4. **Preparation and safety guidance** tailored to risk/duration and self-declared needs (medical equipment); never infer sensitive attributes.
5. **Proactive alerts**: eligibility, timing, escalation, and 4 messages (pre-storm, outage confirmed, estimate updated, restored).
6. **Responsible AI**: privacy (no other customers' data), uncertainty, limitations, fallback when data is missing, emergencies go to 911.
Judged on analytics quality, explainability, customer journey clarity, and responsible-AI controls. No weather data is provided, so storm strength is a user-set slider.

## Team
- **Vedanth (user)**: cleaned all data on AWS SageMaker; backend, chatbot, hosting. **Commits to git himself** (do not commit unless he explicitly asks).
- **Hanshil (hanshil09)**: feature engineering + trained models (`modelling/`, `backend/app/predict.py`, `backend/app/concierge.py`).
- **Aryan (SquidSpore73)**: dashboard (`web/`, especially `web/src/map3d.ts`, storm animation).

## Data (all AEP-provided, cleaned to parquet in S3 `processed/`, features in `features/`)
- 110 circuits (CIR1 to CIR110), ~117,600 homes (premises) with lat/lon, city, service type (overhead ~65k / underground ~52k).
- Equipment chain per home: premise → transformer → fuses/reclosers → breaker (`matched_upstream.txt`). A "zone" = area downstream of the first fuse/recloser.
- Damage records (ARCOS) for storms: **Feb 2025** (big, training) and **Sep 2024** (weaker, held-out test), plus "other".
- Poles, lines, devices, facilities (hospitals/fire/EMS), labor workbook (labor hours per repair, ILM 4.5 multiplier).
- Known data issues: many pole install dates are placeholders (1800s/1900); pole age is often unknown.

## Models (Hanshil)
- **Risk**: logistic models per link (zone risk, transformer risk). Home P(out) = 1 − Π(1 − p_link) over links on the home's path. Severity s scales p: 1 − (1 − p)^s. Bands: Low < 15%, Moderate < 40%, High < 70%, Very High.
- **Damage counts** per zone and type (pole, primary wire, transformer, device, secondary) feed the **restoration simulator**: Monte Carlo over damage × labor hours × ILM 4.5 ÷ crews + repair queue + 6 h start delay → P10/P50/P90 hours.
- `models.joblib` is NOT in S3, so the backend refits from the feature tables at startup (~30 s).
- Held-out results (train Feb 2025 → test Sep 2024), from `modelling/train-model.ipynb`:
  - Home risk AUC 0.80 (Feb) / **0.70 (Sep)**; zone AUC 0.84 / **0.75**; transformer 0.69 / 0.59.
  - Mean predicted 21% vs Sep actual 3.7%: ranking transfers, absolute level doesn't (hence the severity slider).
  - Damage-count correlation on Sep is weak (Spearman ~0.04–0.09), so restoration is a scenario simulator, not a validated forecast. No real restoration times exist in the data.
  - Inconsistency to resolve: `predict.py` hardcodes `HOME_AUC_SEP2024 = 0.715` (app says "72%"), notebook says 0.696.
- Not yet done: baseline comparison (e.g., "overhead line = risky" rule) and a "top 10% riskiest homes captured X% of real Sep 2024 outages" number.

## Architecture
- **Backend**: FastAPI (`backend/app/`). Key files: `main.py` (routes), `predict.py` (models, risk, simulator, `/risk/heat`), `concierge.py` (guidance, alerts, storm timeline, assumptions, circuit outline), `chat.py` (chatbot), `profile.py` (per-home profile for the chatbot), `predictions.py` (chatbot wrapper over predict.py), `topology.py`, `data.py` (S3/local parquet loader).
- Key routes: `/premise/lookup`, `/premise/{id}/power-path`, `/premise/{id}/risk`, `/premise/{id}/restoration-grid`, `/premise/{id}/guidance`, `/alerts`, `/timeline`, `/assumptions`, `/circuits/{id}/outline`, `/risk/heat?severity=`, `/chat` (POST), `/chat/{session_id}` (DELETE).
- **Chatbot**: Amazon Bedrock Converse API, model `us.amazon.nova-2-lite-v1:0` (Nova Pro tested worse). Tool use: `get_outage_risk`, `estimate_restoration`, `get_preparation_guidance`, `check_alerts`. Backend computes facts; the LLM only explains. Private per-session memory (random session id, in memory, 30 min TTL, deleted on "Clear my data"). Grounding rules, temperature 0, exact "I don't have that information" fallback, emergency regex + model check → "This sounds like an emergency. Please call 911 now." Rate limit 20 msgs / 10 min / IP. The dashboard now sends its current sliders (severity, crews, access, switching, prioritize critical) with each message, and tools default to them.
- **Dashboard**: Vite + TypeScript + Tailwind + deck.gl (`web/`). Map: satellite basemap, circuit outline, **predicted-risk heat** (flat ~500 m squares, average model P(out), cells with < 5 homes hidden), home pin, power path colored by link risk, 2D/3D toggle (3D = tilted camera). Panels: risk card, restoration with scenario controls, guidance, alerts, storm replay timeline, chat.
- **Demo dropdown** (six homes, different circuits, picked from model scores): Salem CIR31 overhead Very High ~80% (default, `400797248`); Roanoke CIR14 overhead High ~55% (`823929604`); Boones Mill CIR18 underground High ~50% (`399053172`); Vinton CIR40 overhead Moderate ~28% (`100862103`); Cloverdale CIR73 underground Moderate ~22% (`655649579`); Blue Ridge CIR61 underground Low ~5% (`151197223`).

## Hosting
- Live: **https://d22vd18uidf0yz.cloudfront.net** (CloudFront HTTPS → EC2 t3.small, Amazon Linux 2023, us-east-2, systemd service `aep`, uvicorn on port 80 serving API + built dashboard). EC2 has an IAM role for S3 read + Bedrock; managed through SSM (no SSH).
- Deploy: `git pull`, `aws sso login --sso-session osu-sandbox` if expired, then `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` (builds web, zips, uploads to S3 `deploy/aep-app.zip`, SSM reinstall + restart, health check). Details and teardown in `docs/04-data-and-aws/hosting.md`. If the instance is stopped/started, CloudFront's origin must be updated to the new EC2 DNS name.
- Local dev: `powershell -ExecutionPolicy Bypass -File .\dev.ps1` (backend :8000, Vite :5173, page at `/web/index.html`).

## Current state (uncommitted local changes unless noted)
- Committed: predicted-risk heatmap, deploy script, merge of Hanshil's concierge backend and Aryan's storm animation.
- Not committed / not deployed: six demo homes across circuits; fix so switching homes updates the circuit outline, area label, power-path legend, guidance, alerts and timeline; "Sample data" badge → "Model estimates" and banner wording; chatbot uses dashboard slider settings.

## Open ideas / to-do
- Validation slide/section: baseline comparison, top-10% capture on Sep 2024, and a map toggle "predicted risk vs. actual Sep 2024 outages" (aggregated cells only).
- Reorganize the customer journey into **Before / During / After** cards (message received, estimate at that moment, checklist for that phase, one line on what the AI did); split guidance into prepare-now / while-out / once-back and write "after" tips (food safety, appliances, still-out reporting, service mast damage).
- Storm replay is a replay of real Feb 2025 damage on the home's path (where it exists) through the simulator; timing is simulated. Label every number Model estimate / Real Feb 2025 data / Simulated.
- Fix: predicted-risk heat should be visible in the pre-storm phase of the replay (currently hidden until outage).
- Header says "Ohio Power Company" but the data is Appalachian Power.
- No audit log of chatbot answers yet (brief mentions it).
- Delete AWS resources after judging (steps in hosting.md).
