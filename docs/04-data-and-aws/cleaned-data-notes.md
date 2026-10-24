# Cleaned data: notes for the ML teammate

All AEP challenge data, cleaned and linked. **Full dataset, not a sample.**

**Where:** `s3://sagemaker-aep-outage-indiansassemble/processed/` (15 Parquet files)
**Get it (in your JupyterLab terminal):**
```bash
aws s3 sync s3://sagemaker-aep-outage-indiansassemble/processed/ ~/processed/
```
**Load a table:** `pd.read_parquet("~/processed/batch1/premise.parquet")`

**Conventions:** coordinates are lat/lon (WGS 84) · circuit IDs look like `CIR72` · all IDs are text (leading zeros kept) · missing values are real nulls · no addresses, road names or Life Support flags anywhere.

---

## Tables

### Batch 1: network
| Table | Rows | Key | What it is |
|---|---|---|---|
| `premise` | 117,642 | `premise_id` | Every customer: `lat, lon, circuit_id, transformer_loc, service_type` (Overhead / Underground / null), `city, has_chain, zone_id` |
| `chain` | 490,090 | (`premise_id`, `step`) | Equipment feeding each customer, in order: step 0 = transformer → fuses/reclosers → last step = circuit breaker (`circuit_id` set on that row only) |
| `transformer` | 26,950 | `transformer_loc` | `transformer_id, circuit_id, lat, lon, kva, mounting, phase, upstream_loc, customers, zone_id` |
| `device` | 7,790 | `device_loc` | Fuses, reclosers, switches (banks merged): `device_type, circuit_id, lat, lon, normal_state, rating, upstream_loc, customers_downstream, automated, units` |
| `zone` | 6,664 | `zone_id` | Service area behind each customer's first fuse/recloser: `customers, circuit_id, device_type, lat, lon` |

### Batch 2: damage + labels (training targets)
| Table | Rows | What it is |
|---|---|---|
| `damage` | 1,659 | Every damage report: `event` (feb2025 / sep2024 / other), dates, `asset_type, damage_type, quantity, access_issue, special_equipment`, plus the match to the network: `transformer_loc, xf_zone, outage_loc, match_dist_m` |
| `outage_labels` | 117,642 | **Risk-model target.** Per customer: `out_feb2025, out_sep2024, out_other` (True/False), `has_chain` |
| `zone_damage_counts` | 719 | **Expected-damage-model target.** Per (`zone_id`, `event`): damage counts in `pole, primary_wire, transformer, device, secondary` |
| `access_labels` | 1,658 | **Access-model target.** Per damage report: `access_issue` (True/False), `asset_type, xf_zone, circuit_id, lat, lon` |

### Batch 3: feature inputs
| Table | Rows | What it is |
|---|---|---|
| `pole` | 107,013 | `install_year, age_years, material_group, height_ft, pole_class, zone_id, zone_dist_m` |
| `line` | 190,191 | Line segments: `level` (primary / secondary), `circuit_id, mounting, voltage, length_m, zone_id`, midpoint `lat, lon` |

### Batch 4: app / restoration simulator (not needed for the models)
`facility` (52) · `labor_unit` (21) · `labor_adder` (6, includes ILM = 4.5) · `repair_bundle` (7)

---

## Suggested setup for the models
- **Train on Feb 2025, test on Sep 2024** (held-out storm). Use `out_feb2025` / `out_sep2024`, or the matching `event` rows in the other label tables.
- **Join on `zone_id`** to aggregate features: from `pole` (count, mean age, wood share), `line` (overhead km, underground share), `premise` (customers, overhead service share), `zone` / `device` (device type), and damage history from *other* events.
- **Drop the 47 premises with `has_chain = False`** from training. They get the "can't predict" fallback in the app.

## Key numbers and known gaps
| Item | Value |
|---|---|
| Customers out in Feb 2025 / Sep 2024 / other | **18.9% / 3.7% / 6.5%** |
| Damage reports matched to a transformer (≤ 300 m) | **99.2%** (median distance 46 m) |
| Chain devices found in device tables | 97.5% |
| Pole install year known | **only ~50%**, so pole age is a weak or partial feature. Treat it as optional and add a "year known" flag. **80 placeholder years (1900, 1800) were set to unknown** after the first upload. Re-download `pole.parquet` if you have the earlier copy. |
| Poles with a zone | 77.5%. The rest are > 1 km from any customer transformer (not on lines serving our customers). |
| Lines with a zone | 100% |
| Customers with no fuse/recloser above them | 7,041 → grouped as `BREAKER_CIRxx` zones |
| Access issue share | 32.3% |
| `quantity` | From the raw `Media` field; 328 zeros set to 1 (`quantity_was_zero` flag). Interpretation not yet confirmed with mentors. |
| Non-standard circuit names (TINKER, PENN FOREST, SERVICE CENTER) | 14 reports, fixed using the matched transformer's circuit |
| Transformer duplicates | 9 banks → kept the largest unit per location |

## Privacy
Never uploaded: addresses, road names, street codes, the premise-level Life Support flag. The Life Support / critical-facility **priority counts** (`device_priority`, `life_support_per_transformer`) exist only in the data owner's `local_only/` folder and are used only by the app's repair-order logic.
