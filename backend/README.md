# AEP Outage Concierge — Data API (backend)

A read-only FastAPI service that serves the **cleaned** AEP outage datasets
(the `processed/batch{1..4}/*.parquet` files) from Amazon S3 through API calls.

```
s3://sagemaker-aep-outage-indiansassemble/processed/
  batch1/  premise, chain, transformer, device, zone
  batch2/  damage, outage_labels, zone_damage_counts, access_labels
  batch3/  pole, line
  batch4/  facility, labor_unit, labor_adder, repair_bundle
```

The service loads each parquet table into memory on first use (cached after
that), joins them where useful (e.g. the per-premise equipment "power path"),
and returns clean JSON. It never returns street addresses or per-premise
life-support flags; customer and facility figures are aggregates.

## Prerequisites

- An active AWS SSO session for the `default` profile. If it has expired:
  ```powershell
  aws sso login --sso-session osu-sandbox
  ```
- [`uv`](https://docs.astral.sh/uv/) installed (already set up in this repo).

## Run

From the `backend/` directory:

```powershell
uv run uvicorn app.main:app --reload --port 8000
```

Then open the interactive docs at <http://127.0.0.1:8000/docs>.

Quick checks:

```powershell
# which source + how many tables are loaded
curl http://127.0.0.1:8000/health

# eagerly load everything and get row counts (proves S3 access works)
curl -X POST http://127.0.0.1:8000/admin/preload

# list tables and their columns
curl http://127.0.0.1:8000/catalog
```

## Configuration

Copy `.env.example` to `.env` to override defaults. Key settings:

| Variable | Default | Meaning |
|---|---|---|
| `AEP_S3_BUCKET` | `sagemaker-aep-outage-indiansassemble` | source bucket |
| `AEP_S3_PREFIX` | `processed` | prefix holding the batches |
| `AWS_PROFILE` | `default` | profile used for S3 (SSO) |
| `AWS_REGION` | `us-east-2` | region |
| `AEP_LOCAL_DATA_DIR` | _unset_ | read parquet from a local dir instead of S3 |
| `AEP_CORS_ORIGINS` | `*` | allowed CORS origins |

To work offline, download the data once and point at it:

```powershell
aws s3 cp s3://sagemaker-aep-outage-indiansassemble/processed/ ./_data --recursive --profile default
$env:AEP_LOCAL_DATA_DIR = (Resolve-Path ./_data)
uv run uvicorn app.main:app --port 8000
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | service + source status |
| GET | `/catalog` | tables, columns, row counts |
| POST | `/admin/preload` | load all tables, return row counts |
| GET | `/premise/lookup?id=` or `?lat=&lon=` | find a premise (by id or nearest) |
| GET | `/premise/{id}/power-path` | ordered equipment chain feeding the premise, enriched |
| GET | `/premise/{id}/outage-history` | per-event outage labels |
| GET | `/circuits` | list circuit ids |
| GET | `/circuits/{id}/summary` | counts + damage by event for a circuit |
| GET | `/devices?circuit_id=&device_type=` | protective devices (fuse/recloser/switch) |
| GET | `/zones/{id}` | zone (protective-device area) detail |
| GET | `/zones/{id}/damage?event=` | damage counts by type for a zone |
| GET | `/damage?circuit_id=&event=&zone_id=` | damage records (paged) |
| GET | `/damage/heat?event=&circuit_id=` | aggregated ~1 km damage heat cells |
| GET | `/facilities?type=` | hospitals / fire / ambulance (aggregate) |
| GET | `/reference/repair-bundles` | damage-type → parts/hours |
| GET | `/reference/labor-units` | labor hours per part/size band |
| GET | `/reference/labor-adders` | access / special-equipment adders |

## Notes

- Data is read-only; there are no write endpoints.
- Risk scores and restoration estimates are **not** in these tables — they come
  from the analytics/model layer (MVP plan §5). This API provides the clean
  inputs those models and the dashboard consume.
