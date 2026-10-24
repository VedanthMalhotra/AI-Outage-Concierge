"""Shared feature table builder.

Produces three frames, all derivable from the same joins, written to
s3://<bucket>/<prefix>/features/:

  features_links   one row per LINK per EVENT   -> model A (link damage)
  features_zones   one row per ZONE per EVENT   -> model B (damage counts)
  features_access  one row per DAMAGE REPORT    -> model C (access problem)

Design decisions (see docs/ideas/model-targets.md). Each is an editable
constant so they can be flipped without hunting:

  LINK_TYPES            which link rows model A enumerates
  KEEP_UNZONED_XF       keep transformers whose zone_id is null (+ flag)
  XF_DAMAGE_MARKS_ZONE  transformer damage also marks its parent zone positive
  NEGATIVE_SCOPE        which links become negatives ("all" circuits vs active)
  EVENTS                storm events to emit rows for

Grounded in the real join facts probed 2026-10-24:
  - damage.xf_zone  -> 100% maps to zone_id  (clean zone key)
  - damage.transformer_loc -> 100% maps to transformer_loc (clean xf key)
  - damage.outage_loc -> zone ids and device locs (zone ids ARE fuse/recloser locs)
  - breaker links already exist as BREAKER_CIRxx rows in the zone table
  - device.upstream_loc forms the device graph, terminating at the breaker
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import io as data_io

# --------------------------------------------------------------------------
# editable decisions
# --------------------------------------------------------------------------
EVENTS = ["feb2025", "sep2024", "other"]
LINK_TYPES = ("zone", "transformer")        # model A enumerates these
KEEP_UNZONED_XF = True                      # keep transformers with null zone (+ flag)
XF_DAMAGE_MARKS_ZONE = True                 # transformer damage -> parent zone positive too
NEGATIVE_SCOPE = "all"                      # "all" circuits, or "active" (circuits with any damage that event)
OVERHEAD_VALUES = ("Overhead",)             # line.mounting values treated as overhead
OLD_POLE_YEARS = 50

DAMAGE_TYPE_COLS = ["pole", "primary_wire", "transformer", "device", "secondary"]


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _s(series: pd.Series) -> pd.Series:
    """Clean string series: cast to str, map 'nan'/'none'/'<na>' to NA."""
    out = series.astype("string")
    return out.mask(out.str.lower().isin(["nan", "none", "<na>", "nat", ""]))


def _is_overhead(mounting: pd.Series) -> pd.Series:
    return mounting.astype("string").isin(OVERHEAD_VALUES)


# --------------------------------------------------------------------------
# zone-level static features (do not depend on the event)
# --------------------------------------------------------------------------
def build_zone_features(t: dict[str, pd.DataFrame]) -> pd.DataFrame:
    zone = t["zone"].copy()
    zone["zone_id"] = _s(zone["zone_id"])
    line = t["line"].copy()
    pole = t["pole"].copy()
    device = t["device"].copy()
    xf = t["transformer"].copy()
    prem = t["premise"].copy()

    line["zone_id"] = _s(line["zone_id"])
    pole["zone_id"] = _s(pole["zone_id"])
    device["device_loc"] = _s(device["device_loc"])
    xf["zone_id"] = _s(xf["zone_id"])
    prem["zone_id"] = _s(prem["zone_id"])

    line["overhead"] = _is_overhead(line["mounting"])
    line["km"] = line["length_m"].fillna(0) / 1000.0
    line["is_primary"] = line["level"].astype("string") == "primary"
    line["is_secondary"] = line["level"].astype("string") == "secondary"

    # --- exposure from line ---
    def _line_agg(g: pd.DataFrame) -> pd.Series:
        oh_prim = g.loc[g["is_primary"] & g["overhead"], "km"].sum()
        ug_prim = g.loc[g["is_primary"] & ~g["overhead"], "km"].sum()
        oh_sec = g.loc[g["is_secondary"] & g["overhead"], "km"].sum()
        prim_total = g.loc[g["is_primary"], "km"].sum()
        return pd.Series({
            "oh_primary_km": oh_prim,
            "ug_primary_km": ug_prim,
            "oh_secondary_km": oh_sec,
            "primary_km": prim_total,
            "ug_primary_share": (ug_prim / prim_total) if prim_total > 0 else 0.0,
        })

    line_z = line.groupby("zone_id").apply(_line_agg, include_groups=False).reset_index()

    # --- structure from poles ---
    pole["is_wood"] = pole["material_group"].astype("string") == "wood"
    pole["year_known"] = pole["install_year"].notna()
    pole["is_old"] = pole["age_years"] > OLD_POLE_YEARS

    def _pole_agg(g: pd.DataFrame) -> pd.Series:
        n = len(g)
        known = g["year_known"].sum()
        return pd.Series({
            "pole_count": n,
            "pole_age_mean": g.loc[g["year_known"], "age_years"].mean(),
            "pole_year_known_share": (known / n) if n else 0.0,
            "pole_old_share": (g.loc[g["year_known"], "is_old"].mean() if known else np.nan),
            "pole_wood_share": g["is_wood"].mean() if n else np.nan,
            "pole_height_mean": g["height_ft"].astype("float").mean(),
        })

    pole_z = pole.groupby("zone_id").apply(_pole_agg, include_groups=False).reset_index()

    # --- protection / device of the zone ---
    dev_z = device.rename(columns={"device_loc": "zone_id"})[
        ["zone_id", "device_type", "automated", "customers_downstream", "rating"]
    ].drop_duplicates("zone_id")
    dev_z = dev_z.rename(columns={"device_type": "zone_device_type"})

    # --- transformers per zone ---
    xf_per_zone = xf.groupby("zone_id").agg(
        transformers_in_zone=("transformer_loc", "nunique"),
        kva_mean=("kva", "mean"),
    ).reset_index()

    # --- customers per zone (from premise) ---
    cust_z = prem.groupby("zone_id").agg(
        customers_in_zone=("premise_id", "nunique"),
        overhead_service_share=("service_type", lambda s: (s.astype("string") == "Overhead").mean()),
    ).reset_index()

    # base from the zone table itself
    zf = zone[["zone_id", "customers", "circuit_id", "device_type"]].copy()
    zf = zf.rename(columns={"customers": "zone_customers", "device_type": "zone_device_type_src"})
    zf["circuit_id"] = _s(zf["circuit_id"])

    for frame in (line_z, pole_z, dev_z, xf_per_zone, cust_z):
        zf = zf.merge(frame, on="zone_id", how="left")

    # derived ratios
    zf["poles_per_oh_km"] = zf["pole_count"] / zf["oh_primary_km"].replace(0, np.nan)
    zf["customers_per_km"] = zf["customers_in_zone"] / zf["primary_km"].replace(0, np.nan)
    zf["log_customers_downstream"] = np.log1p(zf["customers_downstream"].fillna(0))
    zf["is_recloser"] = zf["zone_device_type"].astype("string").str.contains("Recloser", na=False)
    zf["is_breaker_zone"] = zf["zone_id"].astype("string").str.startswith("BREAKER", na=False)

    # fill count features (missing = 0 exposure/structure), keep means as NaN + flags
    for c in ["oh_primary_km", "ug_primary_km", "oh_secondary_km", "primary_km",
              "ug_primary_share", "pole_count", "transformers_in_zone",
              "customers_in_zone"]:
        if c in zf:
            zf[c] = zf[c].fillna(0)
    return zf


# --------------------------------------------------------------------------
# upstream overhead-km walk via the device graph (device.upstream_loc)
# --------------------------------------------------------------------------
def build_upstream_exposure(t: dict[str, pd.DataFrame], zone_feat: pd.DataFrame) -> pd.DataFrame:
    """For each zone, sum oh_primary_km of every zone upstream to the breaker.

    The device graph: device_loc -> upstream_loc. A zone_id equals a device_loc
    for fuse/recloser zones. We memoize the walk; cycles are guarded against.
    """
    device = t["device"].copy()
    device["device_loc"] = _s(device["device_loc"])
    device["upstream_loc"] = _s(device["upstream_loc"])
    parent = dict(zip(device["device_loc"], device["upstream_loc"]))

    oh_by_zone = dict(zip(zone_feat["zone_id"], zone_feat["oh_primary_km"].fillna(0)))

    depth_cache: dict[str, int] = {}
    up_km_cache: dict[str, float] = {}

    def walk(loc: str) -> tuple[float, int]:
        # returns (overhead km strictly upstream, chain depth of protective devices)
        if loc in up_km_cache:
            return up_km_cache[loc], depth_cache[loc]
        seen = set()
        cur = parent.get(loc)
        total_km = 0.0
        depth = 0
        while cur is not None and cur not in seen:
            seen.add(cur)
            total_km += float(oh_by_zone.get(cur, 0.0))
            if cur in oh_by_zone:  # cur is a protective-device zone
                depth += 1
            cur = parent.get(cur)
        up_km_cache[loc] = total_km
        depth_cache[loc] = depth
        return total_km, depth

    rows = []
    for z in zone_feat["zone_id"]:
        km, depth = walk(z)
        rows.append({"zone_id": z, "upstream_oh_primary_km": km, "chain_depth": depth})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# history feature (leave-one-event-out) per zone
# --------------------------------------------------------------------------
def build_history(t: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """For each (zone, event): count of damage reports in OTHER events in the zone.

    Excludes the event being predicted so it never leaks the label.
    """
    damage = t["damage"].copy()
    damage["xf_zone"] = _s(damage["xf_zone"])
    per = (
        damage.dropna(subset=["xf_zone"])
        .groupby(["xf_zone", "event"]).size()
        .rename("n").reset_index()
    )
    total = per.groupby("xf_zone")["n"].sum().rename("total").reset_index()
    out = []
    for ev in EVENTS:
        this = per[per["event"] == ev][["xf_zone", "n"]].rename(columns={"n": "this_ev"})
        m = total.merge(this, on="xf_zone", how="left")
        m["this_ev"] = m["this_ev"].fillna(0)
        m["hist_other_events"] = m["total"] - m["this_ev"]
        m["event"] = ev
        out.append(m[["xf_zone", "event", "hist_other_events"]].rename(columns={"xf_zone": "zone_id"}))
    return pd.concat(out, ignore_index=True)


# --------------------------------------------------------------------------
# labels for model A
# --------------------------------------------------------------------------
def zone_positive_sets(t: dict[str, pd.DataFrame]) -> dict[str, set]:
    """zone_id positives per event: xf_zone match OR outage_loc == zone_id."""
    damage = t["damage"].copy()
    damage["xf_zone"] = _s(damage["xf_zone"])
    damage["outage_loc"] = _s(damage["outage_loc"])
    out: dict[str, set] = {}
    for ev in EVENTS:
        d = damage[damage["event"] == ev]
        pos = set(d["xf_zone"].dropna()) | set(d["outage_loc"].dropna())
        out[ev] = pos
    return out


def xf_positive_sets(t: dict[str, pd.DataFrame]) -> dict[str, set]:
    """transformer_loc positives per event: damage.transformer_loc OR outage_loc."""
    damage = t["damage"].copy()
    damage["transformer_loc"] = _s(damage["transformer_loc"])
    damage["outage_loc"] = _s(damage["outage_loc"])
    out: dict[str, set] = {}
    for ev in EVENTS:
        d = damage[damage["event"] == ev]
        out[ev] = set(d["transformer_loc"].dropna()) | set(d["outage_loc"].dropna())
    return out


# --------------------------------------------------------------------------
# assemble the three frames
# --------------------------------------------------------------------------
def build_links_frame(t, zone_feat, upstream, history) -> pd.DataFrame:
    zf = zone_feat.merge(upstream, on="zone_id", how="left")
    zone_pos = zone_positive_sets(t)
    xf_pos = xf_positive_sets(t)

    # which circuits were active per event (for NEGATIVE_SCOPE == "active")
    damage = t["damage"].copy()
    damage["circuit_id"] = _s(damage["circuit_id"])
    active_circuits = {ev: set(damage.loc[damage["event"] == ev, "circuit_id"].dropna())
                       for ev in EVENTS}

    frames = []

    # --- zone link rows ---
    if "zone" in LINK_TYPES:
        for ev in EVENTS:
            z = zf.copy()
            z["event"] = ev
            z["link_type"] = "zone"
            z["link_id"] = z["zone_id"]
            z["label_damaged"] = z["zone_id"].isin(zone_pos[ev]).astype(int)
            z["zone_known"] = True
            if NEGATIVE_SCOPE == "active":
                keep = z["label_damaged"].eq(1) | z["circuit_id"].isin(active_circuits[ev])
                z = z[keep]
            frames.append(z)

    # --- transformer link rows (inherit zone features) ---
    if "transformer" in LINK_TYPES:
        xf = t["transformer"].copy()
        xf["transformer_loc"] = _s(xf["transformer_loc"])
        xf["zone_id"] = _s(xf["zone_id"])
        xf["circuit_id"] = _s(xf["circuit_id"])
        if not KEEP_UNZONED_XF:
            xf = xf[xf["zone_id"].notna()]
        base = xf[["transformer_loc", "zone_id", "circuit_id", "kva", "mounting",
                   "phase", "customers"]].copy()
        # inherit zone features
        zfeat = zf.drop(columns=["circuit_id"], errors="ignore")
        base = base.merge(zfeat, on="zone_id", how="left")
        base["zone_known"] = base["zone_id"].notna()
        for ev in EVENTS:
            x = base.copy()
            x["event"] = ev
            x["link_type"] = "transformer"
            x["link_id"] = x["transformer_loc"]
            x["label_damaged"] = x["transformer_loc"].isin(xf_pos[ev]).astype(int)
            if XF_DAMAGE_MARKS_ZONE:
                # (zone positivity already handled on the zone rows; nothing to add here)
                pass
            if NEGATIVE_SCOPE == "active":
                keep = x["label_damaged"].eq(1) | x["circuit_id"].isin(active_circuits[ev])
                x = x[keep]
            frames.append(x)

    links = pd.concat(frames, ignore_index=True)
    links = links.merge(history, on=["zone_id", "event"], how="left")
    links["hist_other_events"] = links["hist_other_events"].fillna(0)
    # stable column order: keys first
    key_cols = ["link_id", "link_type", "zone_id", "circuit_id", "event",
                "label_damaged", "zone_known"]
    other = [c for c in links.columns if c not in key_cols]
    return links[key_cols + other]


def build_zones_frame(t, zone_feat, upstream, history) -> pd.DataFrame:
    zf = zone_feat.merge(upstream, on="zone_id", how="left")
    zdc = t["zone_damage_counts"].copy()
    zdc["zone_id"] = _s(zdc["zone_id"])
    frames = []
    for ev in EVENTS:
        z = zf.copy()
        z["event"] = ev
        counts = zdc[zdc["event"] == ev][["zone_id"] + DAMAGE_TYPE_COLS]
        z = z.merge(counts, on="zone_id", how="left")
        for c in DAMAGE_TYPE_COLS:
            z[c] = z[c].fillna(0).astype(int)
        frames.append(z)
    zones = pd.concat(frames, ignore_index=True)
    zones = zones.merge(history, on=["zone_id", "event"], how="left")
    zones["hist_other_events"] = zones["hist_other_events"].fillna(0)
    key_cols = ["zone_id", "circuit_id", "event"] + DAMAGE_TYPE_COLS
    other = [c for c in zones.columns if c not in key_cols]
    return zones[key_cols + other]


def build_access_frame(t, zone_feat, upstream) -> pd.DataFrame:
    """One row per damage report with access label + a few report + zone features.

    Excludes special_equipment, repaired, repaired_date (leakage), per the doc.
    """
    acc = t["access_labels"].copy()
    acc["xf_zone"] = _s(acc["xf_zone"])
    dmg = t["damage"].copy()
    dmg_small = dmg[["damage_id", "damage_cat", "quantity"]].copy()

    zf = zone_feat.merge(upstream, on="zone_id", how="left")
    zf_small = zf[["zone_id", "oh_primary_km", "upstream_oh_primary_km",
                   "ug_primary_share", "pole_count", "customers_in_zone",
                   "customers_per_km", "circuit_id"]].rename(columns={"zone_id": "xf_zone"})

    out = acc[["damage_id", "event", "access_issue", "asset_type", "xf_zone"]].copy()
    out = out.merge(dmg_small, on="damage_id", how="left")
    out = out.merge(zf_small, on="xf_zone", how="left")
    out["access_issue"] = out["access_issue"].astype(int)
    return out


# --------------------------------------------------------------------------
# entrypoint
# --------------------------------------------------------------------------
def build_all(write: bool = True) -> dict[str, pd.DataFrame]:
    t = data_io.read_all()
    zone_feat = build_zone_features(t)
    upstream = build_upstream_exposure(t, zone_feat)
    history = build_history(t)

    links = build_links_frame(t, zone_feat, upstream, history)
    zones = build_zones_frame(t, zone_feat, upstream, history)
    access = build_access_frame(t, zone_feat, upstream)

    result = {
        "features_links": links,
        "features_zones": zones,
        "features_access": access,
    }
    if write:
        for name, df in result.items():
            uri = data_io.write_feature(df, name)
            print(f"wrote {name}: {len(df):,} rows -> {uri}")
    return result
