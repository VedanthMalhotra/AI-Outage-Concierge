# How to clean the challenge data on AWS: step-by-step guide

For the **data owner**. Follow it top to bottom. It produces the cleaned tables defined in [mvp-plan.md §4](../02-plan/mvp-plan.md) and shown in [data/sample/](../../data/sample/README.md), in 4 batches, ordered so the ML teammate gets data early.

> The code is written against the field names we inspected in the raw files, but it **hasn't been run end to end yet**. Run each cell, read the printed checks, and fix as you go. Every step says what "looks right" means.

**Time budget:** setup 30 min · Batch 1 ~2.5 h · Batch 2 ~2 h · Batch 3 ~1.5 h · Batch 4 ~1.5 h

---

## Part A: AWS setup (once, ~30 min)

### A1. Create the S3 bucket
1. AWS console → **S3** → **Create bucket**.
2. Name: `sagemaker-aep-outage-<team>`.
   **Tip:** with a name **containing "sagemaker"**, SageMaker's default execution role can usually access it without extra permissions. If you use another name, attach a policy for your bucket to the SageMaker execution role.
3. Same region as everything else. Keep **Block all public access ON**. Default encryption (SSE-S3) ON.
4. Create the folders `raw/`, `processed/`, `features/`, `models/`.
5. Upload the raw files to `raw/`: `Data1.zip`, `Data2.zip`, `matched_upstream.zip`, `Install_Labor_HackOHIO.xlsx`, `structure_drawings.pdf`. Use the console's Upload button, or from your laptop:
   ```bash
   aws s3 cp data/raw/ s3://sagemaker-aep-outage-<team>/raw/ --recursive
   ```

### A2. Create the SageMaker Studio domain
1. Console → **Amazon SageMaker AI** → **Domains** → **Create domain** → **Quick setup** (single user). Takes a few minutes.
2. Add a **user profile** for each teammate (you + ML teammate).
3. In the domain settings, turn on **idle shutdown** for JupyterLab (e.g. 60 min) if your console shows the option. Otherwise, **stop your space manually** whenever you step away. This is the #1 way to save credits.

### A3. Open a JupyterLab space
1. Domain → your user profile → **Open Studio** → **JupyterLab** → **Create JupyterLab space** (name: `data-cleaning`).
2. Instance: **ml.t3.medium** to start. Switch to **ml.m5.xlarge** for Batch 3 (large line files). **CPU only, never GPU.**
3. **Run space** → **Open JupyterLab**.

### A4. Get the code and data into the space
In JupyterLab: **File → New → Terminal**:
```bash
# optional: clone your GitHub repo so your scripts are version-controlled
git clone <your-repo-url> aep && cd aep

mkdir -p ~/aep/raw ~/aep/processed ~/aep/local_only
aws s3 cp s3://sagemaker-aep-outage-<team>/raw/ ~/aep/raw/ --recursive
cd ~/aep/raw
python -m zipfile -e Data1.zip . && python -m zipfile -e Data2.zip . && python -m zipfile -e matched_upstream.zip .
ls          # expect *.shp/*.dbf/*.shx/*.prj files + matched_upstream.txt

pip install geopandas pyogrio pyarrow openpyxl scikit-learn
```

**Folders used below:**
- `~/aep/raw`: unzipped inputs
- `~/aep/processed`: cleaned outputs (uploaded to S3)
- `~/aep/local_only`: internal-only outputs (**never uploaded**)

---

## Part B: Shared helpers (`prep/common.py`)

Create this file once. Every batch imports it.

```python
# prep/common.py
import os, re
import numpy as np
import pandas as pd
import geopandas as gpd

HOME = os.path.expanduser("~/aep")
RAW, OUT, LOCAL = f"{HOME}/raw", f"{HOME}/processed", f"{HOME}/local_only"
UTM = 32617                      # metres; UTM zone 17N covers Roanoke (use for distances/lengths)
NULLS = ["", "Unknown", "UNKNOWN", "N/A", "??", "None"]
BBOX = (36.9, 37.6, -80.35, -79.55)   # lat_min, lat_max, lon_min, lon_max of the study area


def to_circuit(v):
    """'0000072' or 'CIR72' -> 'CIR72'; anything else (e.g. 'TINKER') -> None."""
    s = "" if v is None or (isinstance(v, float) and np.isnan(v)) else str(v).strip()
    if s.isdigit():
        return f"CIR{int(s)}"
    if re.fullmatch(r"CIR\d+", s):
        return f"CIR{int(s[3:])}"
    return None


def as_id(s):
    """Numeric IDs -> text without '.0'. Keeps text IDs (with leading zeros) as they are."""
    if pd.api.types.is_numeric_dtype(s):
        return pd.to_numeric(s, errors="coerce").astype("Int64").astype("string")
    return s.astype("string").str.strip()


def clean_nulls(df):
    for c in df.select_dtypes(include="object").columns:
        df[c] = df[c].astype("string").str.strip().replace(NULLS, pd.NA)
    return df


def read_shp(name):
    gdf = gpd.read_file(f"{RAW}/{name}.shp")
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(4326)            # e.g. facilities are Web Mercator
    return gdf


def add_latlon(gdf):
    gdf["lon"], gdf["lat"] = gdf.geometry.x.round(6), gdf.geometry.y.round(6)
    return gdf


def points(df, crs_out=UTM):
    return gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df.lon, df.lat), crs=4326).to_crs(crs_out)


def save(df, name, batch, local_only=False):
    folder = f"{LOCAL if local_only else OUT}/{batch}"
    os.makedirs(folder, exist_ok=True)
    pd.DataFrame(df).drop(columns="geometry", errors="ignore").to_parquet(f"{folder}/{name}.parquet", index=False)
    print(f"saved {name}: {len(df):,} rows -> {folder}")


def check(df, name, key=None, latlon=True, banned=("address", "road_name", "street_cod", "critical_c")):
    print(f"--- {name}: {len(df):,} rows")
    if key:
        print("  duplicate keys:", df[key].duplicated().sum())
    if latlon and {"lat", "lon"} <= set(df.columns):
        inside = df.lat.between(BBOX[0], BBOX[1]) & df.lon.between(BBOX[2], BBOX[3])
        print("  outside study area:", (~inside).sum())
    leaked = [c for c in banned if c in df.columns]
    print("  PRIVACY OK" if not leaked else f"  !!! REMOVE COLUMNS: {leaked}")
    print("  null %:", (df.isna().mean() * 100).round(1).loc[lambda s: s > 0].to_dict())
```

**First, always inspect a file** before cleaning it:
```python
from prep.common import *
g = read_shp("Customer_Clip"); print(g.crs, len(g)); g.head(3).T
```

---

## Part C: Batch 1 (customers, chains, transformers, devices, areas) ~2.5 h

Goal: `premise`, `chain`, `transformer`, `device`, `zone` → S3. **Upload a one-circuit sample after step C2** so the ML teammate can start.

### C1. Customers → `premise`
```python
from prep.common import *

cust = clean_nulls(add_latlon(read_shp("Customer_Clip")))
premise = pd.DataFrame({
    "premise_id": as_id(cust["premise_nu"]),
    "lat": cust["lat"], "lon": cust["lon"],
    "circuit_id": cust["circuit_id"].map(to_circuit),
    "transformer_loc": cust["aep_xfmr_l"],
    "service_type": cust["kind_of_se"],          # Overhead / Underground / <NA>
    "city": cust["city"].str.title(),
})
# INTERNAL ONLY: Life Support counts per transformer, never premise-level, never uploaded
ls_per_xf = (cust.assign(ls=cust["critical_c"].eq("LS Life Support"))
                 .groupby("aep_xfmr_l")["ls"].sum().rename("life_support_count").reset_index())
check(premise, "premise", key="premise_id")
```
**Looks right:** 117,642 rows, 0 duplicate IDs, a few dozen outside the area at most, PRIVACY OK. About 399 null service types.

### C2. Equipment chains → `chain`
```python
rows = []
with open(f"{RAW}/matched_upstream.txt", encoding="latin1") as f:
    for line in f:
        parts = line.rstrip("\r\n").split("\t")
        for step, item in enumerate(p for p in parts[1:] if p):
            kind, _gid, desc, loc = item.split("*")[:4]
            breaker = kind == "eo_circuit"
            rows.append((parts[0], step, None if breaker else loc,
                         {"Distribution": "Transformer", "Step": "Step Transformer"}.get(desc, desc),
                         to_circuit(loc) if breaker else None))
chain = pd.DataFrame(rows, columns=["premise_id", "step", "device_loc", "device_type", "circuit_id"])
premise["has_chain"] = premise.premise_id.isin(chain.premise_id)
print(len(chain), "chain rows;", (~premise.has_chain).sum(), "premises without a chain")
print(chain.device_type.value_counts())
```
**Looks right:** ~490k rows, ~40 premises without a chain. Types: Fuse, Transformer, Circuit Breaker, Recloser (Hydraulic / Electronic), Step Transformer, Sectionalizer.

**Early sample for ML (do this now):**
```python
s_ids = premise.loc[premise.circuit_id == "CIR72", "premise_id"]
save(premise[premise.premise_id.isin(s_ids)], "premise", "sample_cir72")
save(chain[chain.premise_id.isin(s_ids)], "chain", "sample_cir72")
```
```bash
aws s3 sync ~/aep/processed/sample_cir72 s3://sagemaker-aep-outage-<team>/processed/sample_cir72
```

### C3. Transformers → `transformer`
```python
xf = clean_nulls(add_latlon(read_shp("Transformer_Clip")))
kva_text = xf[["a_phase_sp", "b_phase_sp", "c_phase_sp"]].bfill(axis=1).iloc[:, 0]
transformer = pd.DataFrame({
    "transformer_id": as_id(xf["id"]), "transformer_loc": xf["location_n"],
    "circuit_id": xf["aep_circui"].map(to_circuit), "lat": xf["lat"], "lon": xf["lon"],
    "kva": kva_text.str.extract(r"([\d.]+)\s*kVA")[0].astype(float),
    "mounting": xf["mounting"], "phase": xf["bank_confi"],
    "upstream_loc": xf["upstream_l"], "customers": pd.to_numeric(xf["aep_custom"], errors="coerce"),
})
check(transformer, "transformer", key="transformer_loc")
```
**Looks right:** 26,959 rows, kVA mostly 10–167.

### C4. Fuses, reclosers, switches → `device`
```python
parts = []
for name in ["Fuse_Bank_Clip", "Recloser_Bank_Clip", "Switch_Clip"]:
    g = clean_nulls(add_latlon(read_shp(name)))
    rating = g[[c for c in ["a_phase_sp", "b_phase_sp", "c_phase_sp"] if c in g]].bfill(axis=1).iloc[:, 0]
    parts.append(pd.DataFrame({
        "device_id": as_id(g["id"]), "device_loc": g["location_n"], "device_type": g["device_typ"],
        "circuit_id": g["aep_circui"].map(to_circuit), "lat": g["lat"], "lon": g["lon"],
        "normal_state": g["normal_sta"], "rating": rating, "upstream_loc": g.get("upstream_l"),
        "customers_downstream": pd.to_numeric(g["aep_custom"], errors="coerce"),
        "automated": ~g["esri_defau"].fillna("").str.contains("No Automation") if name != "Fuse_Bank_Clip" else False,
    }))
device = pd.concat(parts, ignore_index=True)
check(device, "device", key="device_loc")
# chain devices should exist in the device/transformer tables
known = set(device.device_loc) | set(transformer.transformer_loc)
dl = chain.device_loc.dropna()
print("chain devices found:", round(dl.isin(known).mean() * 100, 1), "%")
```
**Looks right:** 7,616 + 331 + 900 = 8,847 devices. Chain match around 97% or more.

### C5. Protective-device areas → `zone`
An area ("zone") is everything downstream of a customer's **first fuse / recloser / sectionalizer**.
```python
PROTECTIVE = ["Fuse", "Recloser (Hydraulic)", "Recloser (Electronic)", "Sectionalizer"]
first = (chain[chain.device_type.isin(PROTECTIVE)].sort_values("step")
              .groupby("premise_id").first().reset_index()[["premise_id", "device_loc"]]
              .rename(columns={"device_loc": "zone_id"}))
premise = premise.merge(first, on="premise_id", how="left")
premise["zone_id"] = premise["zone_id"].fillna("BREAKER_" + premise["circuit_id"].fillna("UNKNOWN"))

zone = (premise.groupby("zone_id").agg(customers=("premise_id", "size"), circuit_id=("circuit_id", "first"))
               .reset_index()
               .merge(device[["device_loc", "device_type", "lat", "lon"]], left_on="zone_id", right_on="device_loc", how="left")
               .drop(columns="device_loc"))
# each transformer's zone = the most common zone of its customers (used in Batches 2-3)
xf_zone = (premise.dropna(subset=["transformer_loc"]).groupby("transformer_loc")["zone_id"]
                  .agg(lambda s: s.mode().iat[0]).rename("zone_id").reset_index())
transformer = transformer.merge(xf_zone, on="transformer_loc", how="left")
print(len(zone), "zones; median customers per zone:", zone.customers.median())
```

### C6. Save + upload Batch 1
```python
for df, n in [(premise, "premise"), (chain, "chain"), (transformer, "transformer"), (device, "device"), (zone, "zone")]:
    save(df, n, "batch1")
save(ls_per_xf, "life_support_per_transformer", "batch1", local_only=True)
```
```bash
aws s3 sync ~/aep/processed/batch1 s3://sagemaker-aep-outage-<team>/processed/batch1
```
→ **Tell the ML teammate Batch 1 is in S3.**

---

## Part D: Batch 2 (damage → matching → labels) ~2 h

### D1. Clean damage reports → `damage`
```python
dmg = clean_nulls(read_shp("arcos_prod_damage_09_28_Clip")).dropna(axis=1, how="all")  # drops blank Event/District/Status/crew cols
rt = pd.to_datetime(dmg["Report_Tim"], errors="coerce").dt.normalize()   # date only, so window end dates are included
q = pd.to_numeric(dmg["Media"], errors="coerce").fillna(0).astype(int)
repaired = dmg["Repaired"].eq("Yes")
damage = pd.DataFrame({
    "damage_id": range(len(dmg)),
    "event": np.select([rt.between("2025-02-10", "2025-02-20"), rt.between("2024-09-25", "2024-10-05")],
                       ["feb2025", "sep2024"], "other"),
    "report_date": rt.dt.date,
    "repaired": repaired,
    "repaired_date": pd.to_datetime(dmg["Repaired_D"], errors="coerce").dt.date.where(repaired),  # null if not repaired
    "circuit_id": dmg["Circuit"].map(to_circuit),
    "circuit_raw": dmg["Circuit"],                       # keeps TINKER / PENN FOREST / SERVICE CENTER for fixing
    "substation": dmg["Substation"], "asset_type": dmg["Asset_Type"], "damage_type": dmg["Inform_Wor"],
    "quantity": q.clip(lower=1), "quantity_was_zero": q.eq(0),
    "access_issue": dmg["Access_Iss"].map({"Yes": True, "No": False}),
    "special_equipment": dmg["Special_Eq"],
    "lat": pd.to_numeric(dmg["Latitude"]).round(6), "lon": pd.to_numeric(dmg["Longitude"]).round(6),
})
print(damage.event.value_counts())          # expect feb2025 1254, sep2024 194, other 211
print("non-standard circuits:", damage.circuit_id.isna().sum())   # expect 14
check(damage, "damage", key="damage_id")
```

### D2. Match each damage report to the network
Nearest transformer within 300 m (in metres, so use the UTM projection):
```python
t = points(transformer[["transformer_loc", "circuit_id", "zone_id", "lat", "lon"]]
           .rename(columns={"circuit_id": "xf_circuit", "zone_id": "xf_zone"}))
d = points(damage)
m = gpd.sjoin_nearest(d, t.drop(columns=["lat", "lon"]), how="left", max_distance=300, distance_col="match_dist_m")
m = m[~m.index.duplicated()]                               # ties -> keep one
print("matched:", round(m.transformer_loc.notna().mean() * 100, 1), "%")   # aim for 90%+
# fix non-standard circuit names with the matched transformer's circuit
m["circuit_id"] = m["circuit_id"].fillna(m["xf_circuit"])

LOCAL = ["Transformer", "Step Transformer", "secondary"]   # damage that affects only one transformer
IGNORE = ["Light", "Capacitor Bank"]                      # no customer outage
m["outage_loc"] = np.where(m.asset_type.isin(LOCAL), m.transformer_loc, m.xf_zone)
m.loc[m.asset_type.isin(IGNORE), "outage_loc"] = None
damage = pd.DataFrame(m.drop(columns=["geometry", "index_right"], errors="ignore"))
```
If the match rate is low, look at `match_dist_m` and try 500 m. Log it in [navigating-challenges.md](../05-judging/navigating-challenges.md).

### D3. Labels for the three models
```python
# 1) outage labels: a premise was out if any device on its chain is an outage location in that event
hits = damage.dropna(subset=["outage_loc"]).groupby("event")["outage_loc"].apply(set)
chain_locs = chain.dropna(subset=["device_loc"]).groupby("premise_id")["device_loc"].apply(set)
outage_labels = pd.DataFrame({"premise_id": chain_locs.index})
for ev in ["feb2025", "sep2024", "other"]:
    s = hits.get(ev, set())
    outage_labels[f"out_{ev}"] = [bool(x & s) for x in chain_locs]
print(outage_labels.filter(like="out_").mean().round(3))   # share of customers out per event

# 2) damage counts per zone, by type
CAT = {"Pole": "pole", "primary": "primary_wire", "Transformer": "transformer", "Step Transformer": "transformer",
       "Fuse Bank": "device", "Recloser Bank": "device", "Switch": "device", "secondary": "secondary"}
damage["damage_cat"] = damage["asset_type"].map(CAT)
zone_damage_counts = (damage.dropna(subset=["damage_cat", "xf_zone"])
                      .pivot_table(index=["xf_zone", "event"], columns="damage_cat", values="quantity",
                                   aggfunc="sum", fill_value=0).reset_index().rename(columns={"xf_zone": "zone_id"}))

# 3) access labels (one row per damage report)
access_labels = damage.loc[damage.access_issue.notna(),
                           ["damage_id", "event", "access_issue", "asset_type", "xf_zone", "circuit_id", "lat", "lon"]]
```
**Looks right:** a believable share of customers out in Feb 2025 (not 0%, not 90%), about 32% `access_issue = True`.

### D4. Save + upload Batch 2
```python
for df, n in [(damage, "damage"), (outage_labels, "outage_labels"),
              (zone_damage_counts, "zone_damage_counts"), (access_labels, "access_labels")]:
    save(df, n, "batch2")
```
```bash
aws s3 sync ~/aep/processed/batch2 s3://sagemaker-aep-outage-<team>/processed/batch2
```
→ **Tell the ML teammate the labels are ready.**

---

## Part E: Batch 3 (poles + lines tagged with zones) ~1.5 h
Switch the space to **ml.m5.xlarge** first (stop space → change instance → run).

### E1. Poles → `pole`
```python
p = clean_nulls(add_latlon(read_shp("Pole_Clip")))
year = pd.to_datetime(p["date_insta"], errors="coerce").dt.year
year = year.where(year > 1900)             # 1900-01-01 (79) and 1800 (1) are placeholder dates, not real install years
WOOD = ["Pine", "Wood", "Cedar", "Ponderosa Pine", "Douglas Fir"]
pole = pd.DataFrame({
    "pole_id": as_id(p["id"]), "lat": p["lat"], "lon": p["lon"],
    "install_year": year, "age_years": 2026 - year,
    "material_group": np.where(p["material"].isin(WOOD), "wood", p["material"].str.lower()),
    "height_ft": pd.to_numeric(p["height"].str.extract(r"(\d+)")[0], errors="coerce"),
    "pole_class": p["class"],
})
pole.loc[p["material"].isna(), "material_group"] = None
pz = gpd.sjoin_nearest(points(pole), t[["xf_zone", "geometry"]], how="left", max_distance=500)
pole["zone_id"] = pz[~pz.index.duplicated()]["xf_zone"].values
check(pole, "pole", key="pole_id")   # expect many null install years / heights
```

### E2. Primary + secondary lines → `line`
Inspect the columns first (`read_shp("Primary_ExportFeatures").head(3).T`) to confirm which column holds overhead/underground. In our inspection it looked like `mounting`.
```python
lines = []
for name, level in [("Primary_ExportFeatures", "primary"), ("Secondary_ExportFeatures", "secondary")]:
    g = clean_nulls(read_shp(name)).to_crs(UTM)
    c = g.geometry.centroid
    lines.append(gpd.GeoDataFrame({
        "level": level, "circuit_id": g["circuit_id"].map(to_circuit),
        "mounting": g.get("mounting"), "voltage": g.get("nominal_vo"),
        "length_m": g.geometry.length.round(1),
    }, geometry=c, crs=UTM))
line = pd.concat(lines, ignore_index=True)
lz = gpd.sjoin_nearest(line, t[["xf_zone", "geometry"]], how="left", max_distance=500)
line["zone_id"] = lz[~lz.index.duplicated()]["xf_zone"].values
ll = line.geometry.to_crs(4326)
line["lat"], line["lon"] = ll.y.round(6), ll.x.round(6)
print(line.groupby(["level", "mounting"]).length_m.sum().div(1000).round(0))   # km by level / mounting
```

### E3. Save + upload Batch 3
```python
save(pole, "pole", "batch3"); save(line, "line", "batch3")
```
```bash
aws s3 sync ~/aep/processed/batch3 s3://sagemaker-aep-outage-<team>/processed/batch3
```
→ **Switch the space back to ml.t3.medium.** Tell ML that poles and lines are ready for feature engineering.

---

## Part F: Batch 4 (facilities, labor, repair bundles, priority) ~1.5 h

### F1. Facilities → `facility` (Web Mercator → lat/lon is handled by `read_shp`)
```python
fac = []
for name, typ in [("Hospitals_Medic_Pairwis_Clip", "hospital"), ("Fire_Stations_E_Pairwis_Clip", "fire_station"),
                  ("Ambulance_Servi_Pairwis_Clip", "ambulance")]:
    g = add_latlon(read_shp(name))
    fac.append(pd.DataFrame({"name": g["NAME"], "type": typ, "town": g["CITY"].str.title(), "lat": g["lat"], "lon": g["lon"]}))
facility = pd.concat(fac, ignore_index=True)
facility["is_general_er"] = facility.type.eq("hospital") & ~facility.name.isin(
    ["Catawba Hospital", "Salem Veterans Affairs Medical Center"])
check(facility, "facility")   # expect 52 rows (5 / 37 / 10), all inside the area
```

### F2. Labor workbook → `labor_unit`, `labor_adder`
The workbook's summary blocks are easier to transcribe than to parse. Copy the values once:
```python
labor_unit = pd.DataFrame([
    # part, size_band, install_h, removal_h
    ("pole", "small 25-35ft", 1.942, 0.764), ("pole", "medium 40-55ft", 2.503, 0.927), ("pole", "large 60ft+", 3.368, 1.153),
    ("transformer", "25kVA", 1.188, 0.806), ("transformer", "50kVA", 1.245, 0.891), ("transformer", "100kVA", 1.280, 0.944),
    ("crossarm", None, 0.374, 0.212), ("bracket", None, 0.617, 0.254), ("anchor", None, 0.397, 0.119),
    ("equipment_lead", None, 0.650, 0.206), ("grounding", None, 0.532, 0.153), ("guying", None, 0.367, 0.162),
    ("dead_end", None, 0.108, 0.064), ("insulator", None, 0.049, 0.039), ("pin", None, 0.066, 0.042),
    ("recloser", None, 0.573, 0.525), ("secondary_attachment", None, 0.233, 0.127), ("service", None, 1.693, 0.480),
    ("switch", None, 1.758, 1.010), ("fuse_cutout", None, 0.256, 0.128), ("connector", None, 0.215, 0.045),
], columns=["part", "size_band", "install_h", "removal_h"])
labor_adder = pd.DataFrame([
    ("access_constraint", 0.5), ("confined_property_backyard", 0.5), ("remote_site_offroad", 1.312),
    ("specialized_handling", 0.5), ("site_complexity", 0.5),
], columns=["adder", "hours"])
ILM = 4.5
```
Check the remaining transformer sizes against the workbook's "Labor time material related" sheet, and add them if you need them.

### F3. Repair bundles → `repair_bundle` (from the structure drawings, MVP plan §5.2)
```python
repair_bundle = pd.DataFrame([
    ("Pole", "pole(medium)+crossarm+3 insulator+3 pin+guying+grounding", 5.8),
    ("Transformer", "transformer(25kVA)+fuse_cutout+equipment_lead+grounding", 3.9),
    ("Switch", "switch", 2.8), ("Recloser Bank", "recloser+equipment_lead", 2.0),
    ("secondary", "service+secondary_attachment", 2.5), ("Fuse Bank", "fuse_cutout", 0.4),
    ("primary", "2 dead_end+2 connector+insulator+pin (ASSUMPTION: no conductor hours in workbook)", 1.1),
], columns=["asset_type", "parts", "direct_hours"])
```

### F4. Priority aggregate (**local only, never uploaded**)
```python
f = gpd.sjoin_nearest(points(facility), t[["xf_zone", "geometry"]], how="left")
crit_zones = set(f["xf_zone"].dropna())
ls = ls_per_xf.merge(transformer[["transformer_loc", "zone_id"]], left_on="aep_xfmr_l", right_on="transformer_loc")
device_priority = (ls.groupby("zone_id")["life_support_count"].sum().reset_index()
                     .merge(zone[["zone_id"]], how="right", on="zone_id").fillna({"life_support_count": 0}))
device_priority["serves_critical_facility"] = device_priority.zone_id.isin(crit_zones)
```

### F5. Save Batch 4
```python
for df, n in [(facility, "facility"), (labor_unit, "labor_unit"), (labor_adder, "labor_adder"), (repair_bundle, "repair_bundle")]:
    save(df, n, "batch4")
save(device_priority, "device_priority", "batch4", local_only=True)
```
```bash
aws s3 sync ~/aep/processed/batch4 s3://sagemaker-aep-outage-<team>/processed/batch4
# local_only/ is NOT synced - it holds Life Support aggregates
```

---

## Part G: Done checklist (MVP plan §4.4)

- [ ] Row counts: customers 117,642 · damage 1,659 · poles 107,013 · transformers 26,959 · devices 8,847 · facilities 52
- [ ] Every `check()` printed **PRIVACY OK**. No address / road / street code / Life Support column in `processed/`.
- [ ] Chain device match ≥ ~97%. Damage match rate recorded.
- [ ] Feb 2025 outage share looks believable.
- [ ] `data/processed/README.md` (data dictionary) written for the ML teammate: tables, columns, row counts, known gaps (pole year ~74% missing in sample area, `Media` interpretation, wire-span hours assumption)
- [ ] Space stopped. Instance type back to ml.t3.medium.

## Common problems

| Problem | Fix |
|---|---|
| `AccessDenied` on S3 | Bucket name lacks "sagemaker", or the execution role has no access. Attach an S3 policy for your bucket to the role. |
| `pip install geopandas` fails | Try `pip install pyogrio shapely pyproj geopandas` one at a time, or `conda install -c conda-forge geopandas` in the terminal. |
| IDs lose leading zeros | Use `as_id()`. Never `astype(int)` on premise IDs. |
| `sjoin_nearest` is slow / runs out of memory | Larger instance (ml.m5.xlarge), or process lines one file at a time |
| Columns named differently than expected | Inspect with `.head(3).T` and adjust. Shapefile names are cut off at 10 characters. |
| Kernel dies on secondary lines | Read with `read_shp`, keep only the needed columns immediately, `del` big frames after use |
| Costs creeping up | Billing console. Stop spaces when idle. Check nothing is running under SageMaker → Inference. |
