# Sample cleaned data (circuit CIR72)

A small, **real** extract showing what the cleaned tables will look like (MVP plan §4). It's for the ML and dashboard teammates to start work before the full cleaning is done. The full tables will have **the same columns**.

- **Circuit:** CIR72 (Roanoke area, 1,563 customers, 123 damage reports in the Feb 2025 storm)
- **Privacy:** no addresses, road names or street codes, and **no Life Support flag**
- **Conventions:** coordinates are lat/lon (WGS 84). Circuit IDs look like `CIR72`. IDs are text. Empty cell = missing value (null).

| File | Rows | What it is |
|---|---|---|
| `premise.csv` | 200 (random sample of 1,563) | Customer locations |
| `chain.csv` | 844 | Equipment chain for each sampled premise, from transformer up to the circuit breaker |
| `transformer.csv` | 796 (all on circuit) | Transformers |
| `device.csv` | 273 (all on circuit) | Fuses, reclosers, switches |
| `damage.csv` | 140 (all on circuit) | Damage reports: Feb 2025 = 123, Sep 2024 = 1, other = 16 |
| `facility.csv` | 52 (all) | Hospitals, fire stations, ambulance services |
| `pole.csv` | 400 (sample inside circuit's bounding box) | Poles |

## Columns

**premise.csv**: `premise_id` · `lat` · `lon` · `circuit_id` · `transformer_loc` (joins `transformer.transformer_loc`) · `service_type` (Overhead / Underground / null) · `city` · `has_chain` (false → risk-model fallback)

**chain.csv**: `premise_id` · `step` (0 = transformer, increasing upstream) · `device_loc` (joins `transformer.transformer_loc` or `device.device_loc`; empty for the circuit breaker) · `device_type` (Transformer, Fuse, Recloser (Hydraulic), Recloser (Electronic), Sectionalizer, Step Transformer, Circuit Breaker) · `circuit_id` (set on the breaker row only) · `in_device_table` (whether the device was found in the device tables)

**transformer.csv**: `transformer_id` · `transformer_loc` · `circuit_id` · `lat` · `lon` · `kva` · `mounting` · `phase` · `upstream_loc` (the device feeding it) · `customers`

**device.csv**: `device_id` · `device_loc` · `device_type` · `circuit_id` · `lat` · `lon` · `normal_state` · `rating` · `upstream_loc` · `customers_downstream` · `automated`

**damage.csv**: `damage_id` · `event` (feb2025 / sep2024 / other) · `report_date` · `repaired` · `repaired_date` (null when not repaired) · `circuit_id` · `substation` · `asset_type` · `damage_type` · `quantity` (≥ 1) · `quantity_was_zero` (original `Media` was 0) · `access_issue` · `special_equipment` · `lat` · `lon` · `near_fid` · `near_dist`

**facility.csv**: `facility_id` · `name` · `type` (hospital / fire_station / ambulance) · `town` · `lat` · `lon` · `is_general_er` (false for Catawba Hospital and Salem VA Medical Center)

**pole.csv**: `pole_id` · `lat` · `lon` · `install_year` · `age_years` (as of 2026) · `material_group` (wood / fiberglass / steel / …) · `height_ft` · `pole_class`

## Data findings from building this sample
- **Joins work:** 100% of chain devices (excluding breakers) on these premises were found in the device tables, matched by location number (`*_loc`).
- **Pole install year is missing for 74% of the sampled poles** (296 of 400), and height for 30%. Pole age may be a weak risk factor in this area. Treat it as optional in the models.
- **14 damage reports across the full dataset use non-standard circuit names** (`TINKER`, `PENN FOREST`, `SERVICE CENTER`). Map them to a circuit by location during full cleaning.
