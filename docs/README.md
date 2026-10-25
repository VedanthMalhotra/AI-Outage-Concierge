# Docs index

Everything we've written for the AI Outage Concierge, in reading order. New to the project? Read **01 → Project overview** first.

| # | Folder | Doc | What it's for | Read it when… |
|---|---|---|---|---|
| 01 | **Overview** | [Project overview](01-overview/project-overview.md) | What we're building, how the parts connect, who does what, current status, AWS facts, glossary | **Start here** |
| | | [Technical summary](01-overview/technical-summary.md) | How the finished build works: models, simulator, chatbot, hosting | You need the current technical picture fast |
| | | [Scope and data usage](01-overview/scope-and-data-usage.md) | Scope statement for judges + which AEP data feeds each requirement | You need to explain *why this data / this scope* |
| 02 | **Plan** | [MVP plan](02-plan/mvp-plan.md) | Full build plan: architecture, models, simulator, alert rules, chatbot, API, UI, build schedule, demo script | You're building any part of the app |
| | | [Standout ideas](02-plan/standout-ideas.md) | Ideas that go beyond the brief, and which rubric criteria they target | Deciding what extra to build |
| | | [Feature specs](02-plan/feature-specs.md) | Specs for the chosen extras: Power Path, Time That Matters, Text Concierge | Building those features |
| | | [Model targets](02-plan/model-targets.md) ([PDF](02-plan/model-targets.pdf)) · [Model targets and features](02-plan/model-targets-and-features.md) | What the ML predicts and which features feed it | Working on `ml/` or the notebooks |
| 03 | **Research** | [Existing solutions](03-research/existing-solutions.md) | Analysis of current outage tools, gaps we fill, sources | Pitch prep (Innovation, Impact) |
| 04 | **Data & AWS** | [AWS data-cleaning guide](04-data-and-aws/aws-data-cleaning-guide.md) | Step-by-step cleaning on SageMaker (the code we ran) | Re-running or changing the cleaning |
| | | [Cleaned data notes](04-data-and-aws/cleaned-data-notes.md) | The 15 cleaned tables: columns, row counts, labels, known gaps | **ML teammate**, or anyone using the data |
| | | [Hosting on AWS](04-data-and-aws/hosting.md) | The live site, every AWS resource created, how to update, stop and delete it | Updating the hosted site or cleaning up after judging |
| | | [AWS requirements](04-data-and-aws/aws-requirements.txt) | Every AWS service we use, owners, costs, day-1 checklist | Setting up AWS or checking the budget |
| 05 | **Judging** | [Judging criteria](05-judging/judging-criteria.md) | The HackOHI/O rubric (6 criteria × 5 points) and how to score well | Pitch prep, checking we cover everything |
| | | [Navigating challenges](05-judging/navigating-challenges.md) | Pivot log: what didn't work and how we changed course | **Add an entry every time something fails or changes** |
| — | **Reference** | [Challenge brief (.docx)](reference/HackOHIO_2026_AI_Outage_Concierge_Challenge.docx) · [Structure drawings (.pdf)](reference/structure_drawings.pdf) | The official AEP challenge material | Checking a requirement |

## READMEs elsewhere in the repo

| Where | What |
|---|---|
| [`data/README.md`](../data/README.md) | Raw data inventory and how to extract it |
| [`data/sample/README.md`](../data/sample/README.md) | Small real sample (circuit CIR72) in the cleaned format |
| [`mock/README.md`](../mock/README.md) | Mock API JSON for the dashboard, and which file maps to which panel |
| [`backend/README.md`](../backend/README.md) | FastAPI backend: endpoints, models, how to run |
| [`web/README.md`](../web/README.md) | Dashboard build and config |
| [`ml/README.md`](../ml/README.md) | Outage-risk model package and training |
| [`video-demo/README.md`](../video-demo/README.md) | Presenter mode for the recorded demo |

## Conventions
- **Numbered folders** sort in reading order on GitHub.
- **Add new docs** to the matching folder and add a row to the table above.
- **Never commit** cleaned data with personal info, AWS keys or GitHub tokens. Cleaned data lives in S3.
