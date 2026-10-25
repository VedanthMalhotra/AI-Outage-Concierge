"""Customer profile: everything the cleaned data says about ONE premise.

Built once when a chat session is bound to a premise and handed to the model as
context, so the assistant can answer questions about the customer's own home
directly. Only this premise's facts and area-level aggregates are included:
no addresses, no other customers, no per-premise life-support flags, no crew data.

Sources: the cleaned tables in processed/ (via the DataStore) plus, when
available, the zone feature table in features/ (area risk factors).
"""
from __future__ import annotations

import io
import logging
import threading
from pathlib import Path
from typing import Optional

import pandas as pd

from . import topology as topo
from .config import get_settings
from .data import get_store

log = logging.getLogger("aep.profile")
settings = get_settings()

_features: dict[str, Optional[pd.DataFrame]] = {}
_flock = threading.Lock()

ZONE_FACTOR_FIELDS = [
    "customers", "is_recloser", "breaker_only", "primary_overhead_km", "primary_underground_km",
    "secondary_overhead_km", "secondary_underground_km", "poles", "pole_age_known",
    "pole_age_mean", "pole_wood_share", "pole_height_mean", "transformers", "oh_transformer_share",
]


def _feature_table(name: str) -> Optional[pd.DataFrame]:
    """features/<name>.parquet from S3 (or a local features/ folder), cached; None if unavailable."""
    with _flock:
        if name not in _features:
            try:
                store = get_store()
                if store.using_local:
                    base = Path(settings.aep_local_data_dir)
                    path = next((p for p in (base / "features" / f"{name}.parquet",
                                             base.parent / "features" / f"{name}.parquet") if p.exists()), None)
                    df = pd.read_parquet(path) if path else None
                else:
                    s3 = store._boto_session().client("s3")
                    obj = s3.get_object(Bucket=settings.aep_s3_bucket, Key=f"features/{name}.parquet")
                    df = pd.read_parquet(io.BytesIO(obj["Body"].read()))
                _features[name] = df
            except Exception as exc:  # features are optional extras
                log.warning("feature table %s unavailable: %s", name, exc)
                _features[name] = None
        return _features[name]


def _r(v, nd=2):
    v = topo._clean(v)
    return round(v, nd) if isinstance(v, float) else v


def customer_profile(premise_id: str) -> Optional[dict]:
    store = get_store()
    p = topo.find_premise(store, premise_id)
    if not p:
        return None

    hist = topo.outage_history(store, premise_id) or {}
    profile: dict = {
        "premise_id": p["premise_id"],
        "town": p.get("city"),
        "circuit_id": p.get("circuit_id"),
        "service_type": p.get("service_type"),
        "data_coverage": topo.data_coverage(p),
        "outage_history": {
            "lost_power_feb2025_storm": hist.get("out_feb2025"),
            "lost_power_sep2024_storm": hist.get("out_sep2024"),
            "lost_power_other_events": hist.get("out_other"),
        },
    }

    # transformer serving the home (size, mounting, how many homes share it)
    tr = store.get("transformer")
    trow = tr[tr["transformer_loc"].astype(str) == str(p.get("transformer_loc"))]
    if not trow.empty:
        t = trow.iloc[0]
        profile["transformer"] = {"size_kva": _r(t.get("kva")), "mounting": topo._clean(t.get("mounting")),
                                  "homes_on_it": _r(t.get("customers"))}

    # equipment path from the home to the substation (types only, no device ids)
    pp = topo.power_path(store, premise_id)
    if pp:
        links = pp["links"]
        profile["power_path"] = {
            "equipment_from_home_to_substation": [l["device_type"] for l in links],
            "protective_devices": sum(1 for l in links if str(l["device_type"]).startswith(("Fuse", "Recloser", "Sectionalizer"))),
            "first_protective_device": next((l["device_type"] for l in links
                                             if str(l["device_type"]).startswith(("Fuse", "Recloser", "Sectionalizer"))), None),
        }

    # the protective-device zone the home belongs to
    zone_id = p.get("zone_id")
    if zone_id:
        z = topo.get_zone(store, zone_id) or {}
        profile["zone"] = {"homes_in_zone": _r(z.get("customers")), "protected_by": z.get("device_type") or "circuit breaker"}
        zd = topo.zone_damage(store, zone_id, None)
        if zd:  # damage counts by type, per past storm, in the home's zone
            profile["zone"]["past_damage_by_storm"] = {
                r["event"]: {k: r[k] for k in ("pole", "primary_wire", "transformer", "device", "secondary") if r.get(k)}
                for r in zd
            }

    # area risk factors from the feature table (if present)
    zf = _feature_table("zone_features")
    if zone_id and zf is not None:
        zf_idx = zf if zf.index.name == "zone_id" else zf.set_index("zone_id") if "zone_id" in zf.columns else None
        if zf_idx is not None and zone_id in zf_idx.index:
            row = zf_idx.loc[zone_id]
            factors = {f: _r(row.get(f)) for f in ZONE_FACTOR_FIELDS if f in row.index}
            # pole age is only meaningful when most install dates are known and real
            age, known = factors.get("pole_age_mean"), factors.get("pole_age_known") or 0
            if age is None or known < 0.5 or age > 100:
                factors["pole_age_mean"] = None
                factors["pole_age_note"] = "Pole ages are mostly unrecorded in this area."
            profile["area_factors"] = factors

    # circuit-wide storm history
    cs = topo.circuit_summary(store, p["circuit_id"])
    profile["circuit_history"] = {"homes_on_circuit": cs["premises"], "damage_reports_feb2025": cs["damage_feb2025"],
                                  "damage_reports_sep2024": cs["damage_sep2024"], "damage_reports_other": cs["damage_other"]}
    profile["source"] = "cleaned AEP data (network today + past storms)"
    return profile
