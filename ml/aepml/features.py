"""Shared feature table for Model A: one row per (link, event).

A *link* is a node on a home's power path. Two kinds carry outage risk:

  * ``zone``        - a fuse / recloser area (the device that feeds a set of
                      transformers). Zone damage knocks out everyone behind it.
  * ``transformer`` - a single transformer. Transformer-level damage knocks out
                      only the homes on that transformer.

The chain table lists, per premise and step, the ``device_loc`` of each node
from the transformer (step 0) up to the circuit breaker. We turn the universe of
chain nodes into links, attach features (exposure, structure, protection,
equipment, history), and label each link as damaged-or-not in each event from
``damage.outage_loc``.

Features deliberately avoid raw lat/lon (which would memorise a single storm's
footprint, docs/02-plan/model-targets.md section 3). History features are
leave-one-event-out to avoid leaking the label.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .io import Tables, _haversine_m

EVENTS = ("feb2025", "sep2024", "other")

# device_type -> numeric "cannot self-reset" / depth weighting, and a readable
# protection label used later for plain-language reasons.
_RECLOSER_TYPES = {"Recloser (Hydraulic)", "Recloser (Electronic)", "Sectionalizer"}
_FUSE_TYPES = {"Fuse"}


# --------------------------------------------------------------------------- #
# Link universe + labels
# --------------------------------------------------------------------------- #
def _link_universe(t: Tables) -> pd.DataFrame:
    """Every distinct link that appears on at least one chain.

    Returns columns: link_loc, link_kind ('zone'|'transformer'), device_type,
    circuit_id.
    """
    chain = t.chain.dropna(subset=["device_loc"]).copy()

    # A node is a transformer if step 0 / device_type Transformer, else a zone
    # (fuse / recloser / switch area). Breakers have empty device_loc (dropped).
    is_xf = chain["device_type"].eq("Transformer") | chain["step"].eq(0)
    chain["link_kind"] = np.where(is_xf, "transformer", "zone")

    links = (chain.groupby("device_loc", as_index=False)
             .agg(link_kind=("link_kind", "first"),
                  device_type=("device_type", "first")))
    links = links.rename(columns={"device_loc": "link_loc"})

    # Circuit id: a chain carries it only on the breaker row, so look it up from
    # the premise table via any premise that uses the link.
    chain_nodes = t.chain.dropna(subset=["device_loc"])[["premise_id", "device_loc"]]
    prem_circuit = (chain_nodes
                    .merge(t.premise[["premise_id", "circuit_id"]], on="premise_id", how="left")
                    .groupby("device_loc")["circuit_id"]
                    .agg(lambda s: s.dropna().iloc[0] if s.notna().any() else pd.NA))
    links = links.merge(prem_circuit.rename("circuit_id"),
                        left_on="link_loc", right_index=True, how="left")
    return links


def _damaged_locs_by_event(t: Tables) -> dict[str, set]:
    """outage_loc sets per event. A link is 'damaged' in an event iff it is one
    of these locations (this is exactly the outage_labels logic, lifted to the
    link instead of the premise)."""
    dmg = t.damage.dropna(subset=["outage_loc"])
    return {ev: set(dmg.loc[dmg["event"].eq(ev), "outage_loc"].dropna())
            for ev in EVENTS}


# --------------------------------------------------------------------------- #
# Feature blocks
# --------------------------------------------------------------------------- #
def _transformer_features(t: Tables) -> pd.DataFrame:
    """Per-transformer equipment + customer features, keyed by transformer_loc."""
    x = t.transformer.copy()
    x["kva"] = pd.to_numeric(x.get("kva"), errors="coerce")
    x["customers"] = pd.to_numeric(x.get("customers"), errors="coerce").fillna(0)
    x["is_pad_mounted"] = x.get("mounting", pd.Series(index=x.index)).eq("Pad").astype(float)
    x["is_underground_mount"] = (
        x.get("mounting", pd.Series(index=x.index)).eq("Underground").astype(float)
    )
    phase = x.get("phase", pd.Series(index=x.index)).astype("string")
    x["is_three_phase"] = phase.str.contains("Three", case=False, na=False).astype(float)
    return x[["transformer_loc", "zone_id", "kva", "customers",
              "is_pad_mounted", "is_underground_mount", "is_three_phase"]]


def _device_features(t: Tables) -> pd.DataFrame:
    """Per-device protection/topology features, keyed by device_loc."""
    d = t.device.copy()
    d["customers_downstream"] = pd.to_numeric(
        d.get("customers_downstream"), errors="coerce").fillna(0)
    d["is_recloser"] = d["device_type"].isin(_RECLOSER_TYPES).astype(float)
    d["is_fuse"] = d["device_type"].isin(_FUSE_TYPES).astype(float)
    automated = d.get("automated")
    if automated is not None:
        d["is_automated"] = (automated.astype("string").str.lower().eq("true")).astype(float)
    else:
        d["is_automated"] = 0.0
    return d[["device_loc", "customers_downstream", "is_recloser", "is_fuse",
              "is_automated"]].rename(columns={"device_loc": "link_loc"})


def _zone_customer_counts(t: Tables) -> pd.DataFrame:
    """Customers and transformers per zone (zone = transformer.zone_id)."""
    xf = t.transformer.copy()
    xf["customers"] = pd.to_numeric(xf.get("customers"), errors="coerce").fillna(0)
    g = (xf.dropna(subset=["zone_id"]).groupby("zone_id")
         .agg(zone_customers=("customers", "sum"),
              zone_transformers=("transformer_loc", "nunique"))
         .reset_index().rename(columns={"zone_id": "link_loc"}))
    return g


def _overhead_share_by_zone(t: Tables) -> pd.DataFrame:
    """Overhead service share per zone, a proxy for exposure when the ``line``
    table is unavailable (the sample has no line table). Processed runs should
    replace this with overhead-km exposure (section 3, Exposure)."""
    prem = t.premise.merge(
        t.transformer[["transformer_loc", "zone_id"]], on="transformer_loc", how="left")
    prem["overhead"] = prem.get("service_type", pd.Series(index=prem.index)).eq("Overhead").astype(float)
    g = (prem.dropna(subset=["zone_id"]).groupby("zone_id")["overhead"].mean()
         .reset_index().rename(columns={"zone_id": "link_loc", "overhead": "overhead_service_share"}))
    return g


def _pole_features_by_zone(t: Tables) -> pd.DataFrame:
    """Structure condition per zone from poles. The sample has no zone_id on
    poles, so we assign each pole to the nearest transformer's zone within
    500 m (cleaning guide E1)."""
    pole = t.pole.copy()
    if "zone_id" not in pole.columns:
        xf = t.transformer.dropna(subset=["lat", "lon", "zone_id"]).reset_index(drop=True)
        if xf.empty or pole.empty:
            return pd.DataFrame(columns=["link_loc", "pole_count", "pole_mean_age",
                                         "pole_share_old", "pole_wood_share"])
        xlat, xlon = xf["lat"].to_numpy(float), xf["lon"].to_numpy(float)
        zones = xf["zone_id"].to_numpy(object)
        assigned = []
        for lat, lon in zip(pole["lat"].to_numpy(float), pole["lon"].to_numpy(float)):
            if not np.isfinite(lat) or not np.isfinite(lon):
                assigned.append(pd.NA)
                continue
            dist = _haversine_m(lat, lon, xlat, xlon)
            j = int(np.argmin(dist))
            assigned.append(zones[j] if dist[j] <= 500.0 else pd.NA)
        pole["zone_id"] = pd.array(assigned, dtype="string")

    pole["age_years"] = pd.to_numeric(pole.get("age_years"), errors="coerce")
    pole["is_old"] = (pole["age_years"] > 50).astype(float)
    pole["is_wood"] = pole.get("material_group", pd.Series(index=pole.index)).eq("wood").astype(float)
    g = (pole.dropna(subset=["zone_id"]).groupby("zone_id")
         .agg(pole_count=("pole_id", "nunique"),
              pole_mean_age=("age_years", "mean"),
              pole_share_old=("is_old", "mean"),
              pole_wood_share=("is_wood", "mean"))
         .reset_index().rename(columns={"zone_id": "link_loc"}))
    return g


def _history_features(t: Tables) -> pd.DataFrame:
    """Leave-one-event-out damage history per (link, event).

    For each event we count damage reports whose outage_loc is this link in the
    *other* events only, so we never see the event we are predicting. Expected
    to be weak (section 1), but included honestly.
    """
    dmg = t.damage.dropna(subset=["outage_loc"])
    counts = (dmg.groupby(["outage_loc", "event"]).size()
              .unstack("event").reindex(columns=EVENTS).fillna(0))
    rows = []
    total = counts.sum(axis=1)
    for ev in EVENTS:
        other = total - counts.get(ev, 0)
        rows.append(pd.DataFrame({
            "link_loc": counts.index.astype("string"),
            "event": ev,
            "hist_damage_other_events": other.to_numpy(float),
        }))
    return pd.concat(rows, ignore_index=True)


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #
def build_link_frame(t: Tables) -> pd.DataFrame:
    """One row per (link, event) with features and the damage label.

    Columns of interest:
        link_loc, link_kind, event, circuit_id, y_damaged (0/1), plus features.
    """
    links = _link_universe(t)
    xf_feat = _transformer_features(t)
    dev_feat = _device_features(t)
    zone_cust = _zone_customer_counts(t)
    oh_share = _overhead_share_by_zone(t)
    pole_feat = _pole_features_by_zone(t)

    # Transformer links get transformer features; zone links get zone features.
    links = links.merge(
        xf_feat.rename(columns={"transformer_loc": "link_loc"}),
        on="link_loc", how="left")
    links = links.merge(dev_feat, on="link_loc", how="left")
    links = links.merge(zone_cust, on="link_loc", how="left")
    links = links.merge(oh_share, on="link_loc", how="left")
    links = links.merge(pole_feat, on="link_loc", how="left")

    # For a zone link, "customers behind it" is zone_customers (or device
    # customers_downstream); for a transformer link it's its own customers.
    links["customers_behind"] = np.where(
        links["link_kind"].eq("transformer"),
        links["customers"].fillna(0),
        links[["zone_customers", "customers_downstream"]].max(axis=1).fillna(0),
    )

    # Cross with the three events, then attach history + labels.
    frame = links.loc[links.index.repeat(len(EVENTS))].copy()
    frame["event"] = list(EVENTS) * len(links)
    frame = frame.merge(_history_features(t), on=["link_loc", "event"], how="left")

    damaged = _damaged_locs_by_event(t)
    frame["y_damaged"] = [
        int(loc in damaged.get(ev, set())) if pd.notna(loc) else 0
        for loc, ev in zip(frame["link_loc"], frame["event"])
    ]

    # Numeric feature fill + flags for "known" structure data.
    frame["pole_age_known"] = frame["pole_mean_age"].notna().astype(float)
    fill_zero = ["kva", "customers", "customers_downstream", "customers_behind",
                 "zone_customers", "zone_transformers", "overhead_service_share",
                 "pole_count", "pole_share_old", "pole_wood_share",
                 "hist_damage_other_events", "is_pad_mounted",
                 "is_underground_mount", "is_three_phase", "is_recloser",
                 "is_fuse", "is_automated"]
    for c in fill_zero:
        if c in frame.columns:
            frame[c] = pd.to_numeric(frame[c], errors="coerce").fillna(0.0)
    frame["pole_mean_age"] = pd.to_numeric(frame["pole_mean_age"], errors="coerce").fillna(0.0)

    # log1p on heavy-tailed counts (customers).
    frame["log_customers_behind"] = np.log1p(frame["customers_behind"])

    frame = frame.reset_index(drop=True)
    return frame


# Feature columns used by Model A (order is the coefficient order).
FEATURE_COLUMNS = [
    "overhead_service_share",
    "log_customers_behind",
    "is_recloser",
    "is_fuse",
    "is_automated",
    "is_pad_mounted",
    "is_three_phase",
    "pole_mean_age",
    "pole_share_old",
    "pole_wood_share",
    "pole_age_known",
    "zone_transformers",
    "hist_damage_other_events",
]

# Plain-language labels for the top-factor reasons (A-to-home card).
FEATURE_LABELS = {
    "overhead_service_share": ("Overhead power line",
        "This part of your line is mostly overhead, which is more exposed to wind, ice and falling trees."),
    "log_customers_behind": ("Large shared segment",
        "Many homes share this segment, so a single fault here affects a wide area."),
    "is_recloser": ("Recloser on your line",
        "This segment is protected by a recloser, which retries after a temporary fault."),
    "is_fuse": ("Fuse on your branch",
        "Your branch is protected by a fuse, which can't reset itself after a fault."),
    "is_automated": ("Automated protection",
        "This segment has automated switching that can isolate faults."),
    "is_pad_mounted": ("Pad-mounted transformer",
        "Your transformer is pad-mounted rather than pole-mounted."),
    "is_three_phase": ("Three-phase equipment",
        "Three-phase segments tend to carry more load and equipment."),
    "pole_mean_age": ("Older poles nearby",
        "Poles on this segment are older on average, which can mean more storm damage."),
    "pole_share_old": ("Many poles over 50 years",
        "A large share of poles on this segment are over 50 years old."),
    "pole_wood_share": ("Mostly wood poles",
        "Wood poles are more likely to fail in a severe storm than steel or fiberglass."),
    "pole_age_known": ("Pole-age data coverage",
        "How much of the pole-age data is known for this segment."),
    "zone_transformers": ("Large protection zone",
        "This zone feeds many transformers, so a zone fault reaches many homes."),
    "hist_damage_other_events": ("Storm damage here before",
        "This segment was damaged in other storms in the record."),
}


def build_home_links(t: Tables, frame: pd.DataFrame, event: str) -> pd.DataFrame:
    """Map each premise to the Model-A link rows on its chain for one event.

    Returns one row per (premise_id, link_loc) carrying the link's feature row
    index into ``frame`` so risk.py can read p_link per home.
    """
    chain = t.chain.dropna(subset=["device_loc"])[["premise_id", "device_loc", "step", "device_type"]]
    links_ev = frame[frame["event"].eq(event)].copy()
    merged = chain.merge(
        links_ev, left_on="device_loc", right_on="link_loc", how="inner")
    return merged
