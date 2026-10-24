# AEP Outage Concierge — ML (feature engineering + models)

Builds the shared feature table and (later) trains models A, B, C described in
[../docs/ideas/model-targets.md](../docs/ideas/model-targets.md). Reads the
cleaned tables from `s3://sagemaker-aep-outage-indiansassemble/processed/` and
writes feature frames back under `processed/features/`. Nothing is cached to
disk unless you opt into a local directory.

This runs identically **here** (local, via the `default` SSO profile) or in
**SageMaker JupyterLab** (unset `AWS_PROFILE` to use the execution role).

## This step: the shared feature table

Three frames, all from the same joins:

| Frame | Grain | Feeds | Label |
|---|---|---|---|
| `features_links` | one row per **link** (zone + transformer) per **event** | model A (link damage) | `label_damaged` 0/1 |
| `features_zones` | one row per **zone** per **event** | model B (damage counts) | `pole, primary_wire, transformer, device, secondary` counts |
| `features_access` | one row per **damage report** | model C (access problem) | `access_issue` 0/1 |

Output: `s3://.../processed/features/features_{links,zones,access}.parquet`.

### Run

```powershell
# from ml/  (refresh SSO first if expired: aws sso login --sso-session osu-sandbox)
uv run python build_features.py            # build + write to S3
uv run python build_features.py --dry-run  # build in memory, print shapes, no write
```

### Modeling decisions (editable constants in `aepml/features.py`)

| Constant | Default | Meaning |
|---|---|---|
| `EVENTS` | feb2025, sep2024, other | events to emit rows for |
| `LINK_TYPES` | zone, transformer | which link rows model A enumerates |
| `KEEP_UNZONED_XF` | True | keep transformers with null zone (+ `zone_known` flag) |
| `XF_DAMAGE_MARKS_ZONE` | True | transformer damage also marks its parent zone positive |
| `NEGATIVE_SCOPE` | all | negatives from all circuits (vs only circuits active that event) |
| `OLD_POLE_YEARS` | 50 | threshold for `pole_old_share` |

### Key join facts (probed 2026-10-24, real data)

- `damage.xf_zone` maps 100% to `zone_id` — the clean zone key.
- `damage.transformer_loc` maps 100% to `transformer_loc` — the clean transformer key.
- `damage.outage_loc` lands on zone ids and device locs (zone ids *are* fuse/recloser device locs).
- Breaker links already exist as `BREAKER_CIRxx` rows in the `zone` table.
- `device.upstream_loc` forms the device graph; the walk terminates at the breaker.

## Next steps (not in this step)

Model A (link damage) + A→ per-home derivation, model B (Poisson counts),
model C (access logistic). Validation: train Feb 2025, test Sep 2024, group CV
by `circuit_id`.
