# AI Outage Concierge: AEP HackOHI/O 2026

An AI-powered assistant that helps residential customers in the Roanoke Valley (Appalachian Power) get through a major storm. It predicts **whether their home will lose power**, estimates **how long restoration could take**, tells them **what to do to prepare**, and sends **proactive alerts**. A chatbot explains it all in plain language.

> **New here? Read [docs/01-overview/project-overview.md](docs/01-overview/project-overview.md) first**, then the [docs index](docs/README.md).

## Status

| Area | State |
|---|---|
| Planning and research | ✅ done |
| Data cleaning (AWS SageMaker) | ✅ done: 15 tables in S3 |
| AI models (risk, expected damage, access) | ⏳ in progress |
| Backend: restoration simulator, rules, chatbot | ⏳ next |
| Dashboard (`web/`) | 🔄 first version on mock data |

## Repo map

```
docs/                 all project docs (see docs/README.md for the reading order)
  01-overview/        project overview, scope and data usage
  02-plan/            MVP plan, standout ideas, feature specs
  03-research/        existing solutions analysis
  04-data-and-aws/    AWS cleaning guide, cleaned data notes, AWS requirements
  05-judging/         judging rubric, pivot log (navigating challenges)
  reference/          official challenge brief and structure drawings
data/                 raw AEP data (data/raw) + a small cleaned sample (data/sample)
mock/                 mock API JSON the dashboard uses until the backend exists
web/                  the dashboard (HTML / JS / CSS)
```

## Quick links
- **Building the app:** [MVP plan](docs/02-plan/mvp-plan.md)
- **Using the cleaned data:** [Cleaned data notes](docs/04-data-and-aws/cleaned-data-notes.md)
- **Dashboard data formats:** [mock/README.md](mock/README.md)
- **Pitch prep:** [Judging criteria](docs/05-judging/judging-criteria.md) · [Existing solutions](docs/03-research/existing-solutions.md) · [Navigating challenges](docs/05-judging/navigating-challenges.md)
- **Challenge brief:** [docs/reference/](docs/reference/)
