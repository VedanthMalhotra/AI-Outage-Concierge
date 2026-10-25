# AI Outage Concierge: AEP HackOHI/O 2026

An AI assistant that helps residential Appalachian Power customers in the Roanoke Valley get through a major storm. For an anonymized premise it predicts **whether the home will lose power**, estimates **how long restoration could take**, builds a **personalised before / during / after checklist**, decides **which alerts the customer gets**, and explains all of it in plain language through a chatbot. Every number is a labelled model estimate built from AEP's own data.

> **Live site:** https://d22vd18uidf0yz.cloudfront.net/ (AWS: CloudFront + EC2, details in [hosting.md](docs/04-data-and-aws/hosting.md))
>
> **New here?** Read [docs/01-overview/project-overview.md](docs/01-overview/project-overview.md), then the [docs index](docs/README.md).

## Features

### Pick a home (or none)
- **Premise ID box** and a **demo list of six homes** on six circuits, covering every risk level, overhead and underground (Salem, Roanoke, Boones Mill, Vinton, Cloverdale, Blue Ridge).
- **"No premise ID given"** is the default: the map zooms out to the whole valley, there's no home pin or circuit outline, guidance is general, and the chatbot asks for a premise ID before giving anything personal.
- Switching homes resets the storm walkthrough, the chat and the checklist, and flies the map to the new home.

### Map
- **TomTom 3D map** (vector map with 3D buildings and terrain) when a TomTom key is set; otherwise a deck.gl satellite map with 3D terrain. 2D / 3D toggle, home and whole-area buttons.
- **Predicted-risk heat map:** every ~500 m area coloured by the model's average chance that its homes lose power (Low / Moderate / High / Very High). Areas with fewer than 5 homes are hidden, so no single home can be picked out. Recolours with the storm-strength slider.
- **Your power path:** the equipment chain from the home to the substation, each device coloured by its chance of damage and labelled **T** transformer, **F** fuse, **R** recloser, **B** breaker. The weakest link is circled.
- **Storm walkthrough (Step):** a replay of the real February 2025 damage on the home's own path, with rain on the map, the path turning red during the outage and green when restored, and the four customer messages (pre-storm, outage confirmed, estimate updated, restored).

### Will I lose power?
- Risk band, chance and confidence from the **trained outage-risk model**, with the top reasons in plain words ("many homes share your line, so trouble anywhere along it can reach you"), each backed by real February 2025 damage rates.
- **Storm strength slider** (0.5x to 2x February 2025) with labelled ticks. No weather data was provided, so storm strength is a scenario input.

### How long could restoration take?
- **Restoration simulator:** 200 simulated storms using expected damage from the damage model, AEP labour hours and structure drawings, the indirect labour multiplier (ILM 4.5), crew counts, road access and repair order. Shown as a range (10th to 90th percentile) with the most likely value.
- Scenario controls with labelled ticks: crews (1 to 10), "Can crews get to the damage?" (usual / roads blocked / roads clear), "Crews can reroute power around damage", "Hospitals and emergency services first", "The fuse that feeds your area has blown". Each change explains what moved the estimate.
- **Critical facilities:** a premise at a hospital, fire station or ambulance station restores faster when emergency services go first, with a note explaining why.

### What should I do to prepare?
- **What do you have at home?** The customer ticks their appliances (fridge, freezer, home heat, phone, medical device, sump pump, well pump), then presses **Make my personalised checklist**.
- An **animation shows every input being used** (chance of losing power, outage length, line type, risk reasons, medical needs, critical facility, storm strength, appliances), then the **AI writes a before / during / after checklist** for that household, each step with a one-line reason. Steps for appliances the household doesn't have are filtered out. It updates when the storm, crews or appliances change.
- **Will it last?** For each ticked appliance: how long it keeps working without power against the home's simulated outage lengths ("Likely to run out, 95% chance the outage is longer").
- **Stay safe** list (911, downed lines, generators), always shown. With no premise: a general checklist.
- Ticking **Medical device** declares medical needs (never inferred from data): medical steps first, medical alert escalation, and the chatbot knows.

### Alerts
- Eligibility, channels (text, email, push), timing and escalation from documented rules on the model output, plus the four proactive messages in the storm walkthrough.

### Chatbot ("Your outage concierge")
- Amazon Bedrock (Nova 2 Lite) with tool use: it answers from the model outputs, the home's AEP profile and the dashboard's current settings (storm strength, crews, road access), never from its own guesses.
- Plain-word answers, what-ifs with exact numbers ("with 4 crews, 2 more than the 2 now, about 17 hours"), map explanations, general guidance without a premise, and an instant **"call 911"** reply for emergencies.
- Private per-session memory (cleared on home change or "Clear my data"), no other customers' data, rate limited.

### Responsible AI
- Every number labelled as a model estimate; assumptions and limitations panel; fallback message when a home can't be linked to the network.
- Privacy: only the selected home is shown; heat areas aggregate at least 5 homes; no addresses, no crew data, no exact facility details; sensitive needs only when the customer declares them.

## How good are the predictions?

Trained on the **February 2025** storm and tested on **September 2024**, a storm the model never saw (`modelling/train-model.ipynb`):

| Prediction | AUC, Feb 2025 (trained) | AUC, Sep 2024 (held out) |
|---|---|---|
| Home loses power | 0.80 | 0.70 |
| Damage in a fuse / recloser area | 0.84 | 0.75 |
| Damage at a transformer | 0.69 | 0.59 |

The model ranks where risk is; storm strength sets how much. Restoration times can't be validated (the data has no actual restoration times), so restoration is a transparent simulator built on AEP's labour data.

## Architecture

```
AEP raw data (shapefiles, topology, labour workbook)
  -> cleaned on AWS SageMaker -> S3 processed/ (15 parquet tables)
  -> feature engineering -> S3 features/ (zone, transformer, home-link tables)
  -> backend/ (FastAPI on EC2): risk model, restoration simulator, guidance + alert rules,
     AI checklist and chatbot (Amazon Bedrock)
  -> web/ (TypeScript, Tailwind, TomTom / deck.gl) behind CloudFront (HTTPS)
```

## Run it locally

```powershell
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```

- **Dashboard:** http://localhost:5173/web/index.html · **API docs:** http://127.0.0.1:8000/docs
- **AWS login** (data from S3 and the chatbot): `aws sso login --sso-session osu-sandbox`
- **TomTom map (optional):** put `VITE_TOMTOM_API_KEY=<your key>` in `web/.env` (git-ignored). Without it the satellite map is used.
- Options: `-FrontendOnly`, `-BackendOnly`, `-LocalData <folder>`, `-BackendPort <n>`

## Publish to the live site

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Builds the dashboard, uploads the package to S3 and restarts the EC2 server through SSM (about 2 minutes). Stop / start and teardown steps are in [hosting.md](docs/04-data-and-aws/hosting.md).

## Repo structure

```
AEPHack/
├── backend/          FastAPI service (runs on EC2)
│   └── app/          predict.py (models + simulator), concierge.py (guidance, alerts, timeline),
│                     chat.py (chatbot), ai_checklist.py (AI checklist), profile.py, topology.py, data.py
├── web/              Dashboard (TypeScript, Tailwind, Vite)
│   └── src/          main.ts, prepare.ts (checklist, Will it last?), tomtomMap.ts + map3d.ts
│                     (maps, chosen by mapEngine.ts), api.ts, styles.css
├── ml/               Outage-risk model package (aepml/) and trained artifacts (artifacts/model_a/)
├── modelling/        SageMaker notebooks: cleaning, feature engineering, model training
├── data/             Cleaned parquet tables (processed/), feature tables (features/), small CSV sample
├── mock/             Mock API JSON used while the backend was being built
├── docs/             Overview, plan, research, data + AWS, judging (index: docs/README.md)
├── outputs/pitch/    Pitch deck
├── video-demo/       Presenter mode for the recorded demo
├── dev.ps1           Run backend + dashboard locally
└── deploy.ps1        Publish to the live site
```

## Known limits
- Storm strength is a scenario input (no weather data). Restoration is a simulator, not a validated forecast.
- The chatbot uses Amazon Nova 2 Lite on Amazon Bedrock.
- The priority-location data has hospitals, fire and ambulance stations but no schools.
- Prototype for HackOHI/O 2026, not an official AEP service.
