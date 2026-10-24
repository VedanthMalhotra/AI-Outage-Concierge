"""Domain logic over the cleaned tables.

Pure pandas helpers used by the API layer. Each function takes the DataStore
and returns plain dicts/lists ready for Pydantic. Privacy rules (no address,
no life-support, aggregate-only facility counts) are enforced here by simply
never selecting those columns.
"""
from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
import pandas as pd

from .data import DataStore


# --------------------------------------------------------------------------
# small coercion helpers (parquet nulls -> clean JSON)
# --------------------------------------------------------------------------

def _clean(v: Any) -> Any:
    """Convert numpy/pandas NA and non-finite floats to None/py-native."""
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(v, (np.bool_,)):
        return bool(v)
    try:
        if pd.isna(v):
            return None
    except (ValueError, TypeError):
        pass
    s = str(v)
    if s.lower() in ("nan", "nat", "none", "<na>"):
        return None
    return v


def _row_to_dict(row: pd.Series, fields: list[str]) -> dict[str, Any]:
    return {f: _clean(row.get(f)) for f in fields}


# --------------------------------------------------------------------------
# premise
# --------------------------------------------------------------------------

PREMISE_FIELDS = [
    "premise_id", "lat", "lon", "circuit_id", "transformer_loc",
    "service_type", "city", "has_chain", "zone_id",
]


def find_premise(store: DataStore, premise_id: str) -> Optional[dict]:
    df = store.get("premise")
    hit = df[df["premise_id"].astype(str) == str(premise_id)]
    if hit.empty:
        return None
    return _row_to_dict(hit.iloc[0], PREMISE_FIELDS)


def outage_history(store: DataStore, premise_id: str) -> Optional[dict]:
    df = store.get("outage_labels")
    hit = df[df["premise_id"].astype(str) == str(premise_id)]
    if hit.empty:
        return None
    r = hit.iloc[0]
    return {
        "out_feb2025": bool(r["out_feb2025"]),
        "out_sep2024": bool(r["out_sep2024"]),
        "out_other": bool(r["out_other"]),
    }


def nearest_premise(store: DataStore, lat: float, lon: float) -> Optional[dict]:
    df = store.get("premise")
    # simple equirectangular distance; fine at county scale
    dlat = np.radians(df["lat"] - lat)
    dlon = np.radians(df["lon"] - lon) * math.cos(math.radians(lat))
    d2 = dlat * dlat + dlon * dlon
    idx = d2.idxmin()
    return _row_to_dict(df.loc[idx], PREMISE_FIELDS)


def data_coverage(premise: dict) -> str:
    if not premise.get("has_chain"):
        return "none"
    if premise.get("zone_id") is None:
        return "partial"
    return "good"


# --------------------------------------------------------------------------
# power path (the chain) enriched with device detail
# --------------------------------------------------------------------------

def power_path(store: DataStore, premise_id: str) -> Optional[dict]:
    chain = store.get("chain")
    rows = chain[chain["premise_id"].astype(str) == str(premise_id)].copy()
    if rows.empty:
        return None
    rows = rows.sort_values("step")

    devices = store.get("device").set_index("device_loc")
    transformers = store.get("transformer").set_index("transformer_loc")

    links: list[dict] = []
    circuit_id = None
    for _, r in rows.iterrows():
        loc = _clean(r.get("device_loc"))
        link: dict = {
            "step": int(r["step"]),
            "device_loc": loc,
            "device_type": str(r["device_type"]),
            "circuit_id": _clean(r.get("circuit_id")),
        }
        # enrich from device, then transformer
        if loc is not None and loc in devices.index:
            d = devices.loc[loc]
            if isinstance(d, pd.DataFrame):
                d = d.iloc[0]
            link.update({
                "lat": _clean(d.get("lat")),
                "lon": _clean(d.get("lon")),
                "customers_downstream": _clean(d.get("customers_downstream")),
                "rating": _clean(d.get("rating")),
                "automated": _clean(d.get("automated")),
                "circuit_id": link["circuit_id"] or _clean(d.get("circuit_id")),
            })
        elif loc is not None and loc in transformers.index:
            t = transformers.loc[loc]
            if isinstance(t, pd.DataFrame):
                t = t.iloc[0]
            link.update({
                "lat": _clean(t.get("lat")),
                "lon": _clean(t.get("lon")),
                "customers_downstream": _clean(t.get("customers")),
                "circuit_id": link["circuit_id"] or _clean(t.get("circuit_id")),
            })
        if circuit_id is None and link.get("circuit_id"):
            circuit_id = link["circuit_id"]
        links.append(link)

    # fall back to premise circuit if the chain rows had none
    if circuit_id is None:
        p = find_premise(store, premise_id)
        circuit_id = p["circuit_id"] if p else "unknown"

    return {
        "premise_id": str(premise_id),
        "circuit_id": circuit_id,
        "links": links,
        "note": (
            "Ordered equipment path feeding this premise: step 0 is the "
            "transformer, ascending steps move upstream toward the substation. "
            "Customer counts are aggregates; no other customers are identified."
        ),
    }


# --------------------------------------------------------------------------
# devices / zones / circuit
# --------------------------------------------------------------------------

DEVICE_FIELDS = [
    "device_id", "device_loc", "device_type", "circuit_id", "lat", "lon",
    "normal_state", "rating", "upstream_loc", "customers_downstream", "automated",
]
ZONE_FIELDS = ["zone_id", "customers", "circuit_id", "device_type", "lat", "lon"]


def list_devices(store: DataStore, circuit_id: Optional[str], device_type: Optional[str],
                 limit: int, offset: int) -> list[dict]:
    df = store.get("device")
    if circuit_id:
        df = df[df["circuit_id"].astype(str) == str(circuit_id)]
    if device_type:
        df = df[df["device_type"].astype(str).str.lower() == device_type.lower()]
    df = df.iloc[offset: offset + limit]
    return [_row_to_dict(r, DEVICE_FIELDS) for _, r in df.iterrows()]


def get_zone(store: DataStore, zone_id: str) -> Optional[dict]:
    df = store.get("zone")
    hit = df[df["zone_id"].astype(str) == str(zone_id)]
    if hit.empty:
        return None
    return _row_to_dict(hit.iloc[0], ZONE_FIELDS)


def zone_damage(store: DataStore, zone_id: str, event: Optional[str]) -> list[dict]:
    df = store.get("zone_damage_counts")
    df = df[df["zone_id"].astype(str) == str(zone_id)]
    if event:
        df = df[df["event"].astype(str) == event]
    fields = ["zone_id", "event", "device", "pole", "primary_wire", "secondary", "transformer"]
    return [_row_to_dict(r, fields) for _, r in df.iterrows()]


def list_circuits(store: DataStore) -> list[str]:
    s = store.get("premise")["circuit_id"].dropna().astype(str).unique().tolist()
    return sorted(s)


def circuit_summary(store: DataStore, circuit_id: str) -> dict:
    prem = store.get("premise")
    tr = store.get("transformer")
    dev = store.get("device")
    zone = store.get("zone")
    dmg = store.get("damage")

    cid = str(circuit_id)

    def _count(df: pd.DataFrame) -> int:
        return int((df["circuit_id"].astype(str) == cid).sum())

    dmg_c = dmg[dmg["circuit_id"].astype(str) == cid]
    return {
        "circuit_id": cid,
        "premises": _count(prem),
        "transformers": _count(tr),
        "devices": _count(dev),
        "zones": _count(zone),
        "damage_feb2025": int((dmg_c["event"] == "feb2025").sum()),
        "damage_sep2024": int((dmg_c["event"] == "sep2024").sum()),
        "damage_other": int((dmg_c["event"] == "other").sum()),
    }


# --------------------------------------------------------------------------
# damage
# --------------------------------------------------------------------------

DAMAGE_FIELDS = [
    "damage_id", "event", "report_date", "repaired", "repaired_date",
    "circuit_id", "asset_type", "damage_type", "damage_cat", "quantity",
    "access_issue", "lat", "lon", "xf_zone", "outage_loc",
]


def _norm_access(v: Any) -> Optional[bool]:
    v = _clean(v)
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in ("yes", "true", "1"):
        return True
    if s in ("no", "false", "0"):
        return False
    return None


def list_damage(store: DataStore, circuit_id: Optional[str], event: Optional[str],
                zone_id: Optional[str], limit: int, offset: int) -> list[dict]:
    df = store.get("damage")
    if circuit_id:
        df = df[df["circuit_id"].astype(str) == str(circuit_id)]
    if event:
        df = df[df["event"].astype(str) == event]
    if zone_id:
        df = df[df["xf_zone"].astype(str) == str(zone_id)]
    df = df.iloc[offset: offset + limit]
    out = []
    for _, r in df.iterrows():
        d = _row_to_dict(r, DAMAGE_FIELDS)
        d["report_date"] = None if d["report_date"] is None else str(d["report_date"])[:10]
        d["repaired_date"] = None if d["repaired_date"] is None else str(d["repaired_date"])[:10]
        d["access_issue"] = _norm_access(r.get("access_issue"))
        out.append(d)
    return out


def damage_heat(store: DataStore, event: Optional[str], circuit_id: Optional[str],
                cell_deg: float = 0.01) -> list[dict]:
    """Aggregate damage points into ~1 km grid cells (privacy-safe heat layer)."""
    df = store.get("damage")
    if event:
        df = df[df["event"].astype(str) == event]
    if circuit_id:
        df = df[df["circuit_id"].astype(str) == str(circuit_id)]
    if df.empty:
        return []
    g = df.copy()
    g["cell_lat"] = (g["lat"] / cell_deg).round() * cell_deg
    g["cell_lon"] = (g["lon"] / cell_deg).round() * cell_deg
    agg = g.groupby(["cell_lat", "cell_lon"]).size().reset_index(name="count")
    return [
        {"lat": round(float(r["cell_lat"]), 5),
         "lon": round(float(r["cell_lon"]), 5),
         "count": int(r["count"])}
        for _, r in agg.iterrows()
    ]


# --------------------------------------------------------------------------
# facilities (aggregate; names/towns are public safety info, no customers)
# --------------------------------------------------------------------------

FACILITY_FIELDS = ["name", "type", "town", "lat", "lon", "is_general_er", "zone_id"]


def list_facilities(store: DataStore, ftype: Optional[str]) -> list[dict]:
    df = store.get("facility")
    if ftype:
        df = df[df["type"].astype(str).str.lower() == ftype.lower()]
    return [_row_to_dict(r, FACILITY_FIELDS) for _, r in df.iterrows()]


# --------------------------------------------------------------------------
# labor / repair reference
# --------------------------------------------------------------------------

def repair_bundles(store: DataStore) -> list[dict]:
    df = store.get("repair_bundle")
    return [_row_to_dict(r, ["asset_type", "parts", "direct_hours"]) for _, r in df.iterrows()]


def labor_units(store: DataStore) -> list[dict]:
    df = store.get("labor_unit")
    return [_row_to_dict(r, ["part", "size_band", "install_h", "removal_h"]) for _, r in df.iterrows()]


def labor_adders(store: DataStore) -> list[dict]:
    df = store.get("labor_adder")
    return [_row_to_dict(r, ["adder", "hours"]) for _, r in df.iterrows()]
