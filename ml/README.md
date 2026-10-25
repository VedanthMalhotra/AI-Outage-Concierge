# aepml — the Power Path model (Model A)

Implements the "powerlines idea" from
[`docs/ideas/model-targets.md`](../docs/ideas/model-targets.md): outage risk
lives on the **links of the power path**, not at the house. We model the
probability that each network link is damaged in a storm, then combine the links
on a home's chain into a per-home outage probability.

```
P(out) = 1 − Π(1 − p_link)   over the links on the home's chain
```

This gives the per-home risk card **and** the per-link "Your Power Path" scores
from a single, explainable model.

## What's here

| Module | Role |
|---|---|
| `aepml/io.py` | Load the cleaned tables. Works on the `data/sample` CSVs (default, offline) or the processed parquet tables. Derives `outage_loc` / `xf_zone` when the sample lacks them. |
| `aepml/features.py` | Build the shared **link frame**: one row per (link, event) with exposure / structure / protection / equipment / leave-one-event-out history features, plus the damage label. Also maps each home to its chain's link rows. |
| `aepml/model_a.py` | `ModelA`: logistic regression over the link features with an **event intercept**. A severity knob (0.5 / 1.0 / 1.5 / 2.0) scales the storm strength. |
| `aepml/risk.py` | A→ derivation: combine a home's link probabilities, assign a band / confidence / top factors in the dashboard's output contract (`mock/api/risk*.json`). |
| `aepml/train.py` | Fit, validate, and write the artifacts. |

## Run

The virtualenv in `ml/.venv` already has pandas, numpy, scikit-learn, scipy,
joblib and pyarrow.

```powershell
# Sample data (single circuit CIR72, offline)
.\.venv\Scripts\python.exe -m aepml.train

# Full processed tables
.\.venv\Scripts\python.exe -m aepml.train --base s3://sagemaker-aep-outage-indiansassemble/processed --fmt parquet
```

### Artifacts (`ml/artifacts/model_a/`)

| File | Contents |
|---|---|
| `model.joblib` | The fitted `ModelA` (scaler + logistic regression + event offsets). |
| `metrics.json` | Positive rate, 5-fold CV grouped by `circuit_id`, leave-one-event-out backtest, and the naive "overhead-only" baseline AUC to beat. |
| `features.json` | Feature columns, base rate, event offsets, and plain-language factor labels. |
| `coefficients.csv` | Coefficient table (for plain-language reasons). |
| `power_path.json` | Per-link `p_damage` + homes sharing + one-line reason — the "Your Power Path" feed. |
| `risk_sample.json` | A→ home risk cards for a few premises (matches `mock/api/risk.json`). |

## Using it from code

```python
import joblib
from aepml import load_tables, build_link_frame, home_risk

tables = load_tables()                     # or load_tables("s3://.../processed", "parquet")
frame  = build_link_frame(tables)
model  = joblib.load("artifacts/model_a/model.joblib")

card = home_risk(model, tables, frame, premise_id="893916132",
                 event="feb2025", severity=1.0)
print(card.to_dict())   # probability, band, confidence, top_factors, fallback
```

## Notes on the sample results

The sample is a single circuit (CIR72), so numbers are illustrative, not the
real backtest:

- **Severity knob is live:** the same home moves Moderate → High → Very High as
  severity goes 0.5 → 1.0 → 1.5.
- The event offsets (`feb2025` = 0, `sep2024` ≈ −2.6, `other` ≈ −1.8) are
  data-driven severity presets, as the proposal intended — no guessed
  multipliers.
- The cross-storm backtest is honest and humbling (section 1 of the proposal):
  storms hit different places, so Feb→Sep transfer is modest. On the full data
  compare Model A against the direct-transformer baseline and the overhead-only
  rule reported in `metrics.json`.

## Not yet built (next in the proposal's build order)

Model B (expected damage counts), Model C (access problem), and the restoration
simulator (D). Model A + the A→ derivation here are steps 1–2.
