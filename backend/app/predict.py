"""Model layer: outage risk (per home and per link) and the restoration simulator.

Loads the trained models (models.joblib from modelling/train-model.ipynb) and the
feature tables (build_features.py output) once, scores every link up front, then:

  home_risk(premise, severity)      risk card: probability, band, confidence, top reasons
  link_risk(premise)                risk for each link on the Power Path
  restoration_grid(premise)         P10/P50/P90 hours for every dashboard scenario
                                    (Monte Carlo over damage counts, labor hours, ILM)

Storm severity scales the damage *rate*: a link with Feb-2025 probability p has
probability 1 - (1 - p)^s at severity s, and expected damage counts scale by s.
The models know *where* risk is (tested on the held-out Sep 2024 storm); how strong
the storm is stays a scenario input.
"""
from __future__ import annotations

import io
import itertools
import logging
import threading
from functools import lru_cache
from pathlib import Path
from typing import Optional

import joblib
import numpy as np
import pandas as pd

from . import topology as topo
from .config import get_settings
from .data import get_store

log = logging.getLogger("aep.predict")

SEVERITIES = [0.5, 1.0, 1.5, 2.0]
DAMAGE_TYPES = ["pole", "primary_wire", "transformer", "device", "secondary"]
# held-out Sep 2024 results from train-model.ipynb (metrics.json), shown to users
HOME_AUC_SEP2024 = 0.715
ACCESS_BASE_RATE = 0.32  # access model ~ chance on Sep 2024 (AUC 0.58), so the base rate is used
N_RUNS = 200

_lock = threading.Lock()


# ---------------------------------------------------------------------------
# loading
# ---------------------------------------------------------------------------

def _read(rel: str) -> bytes:
    """Read features/... or models/... from the local data folder or S3."""
    s = get_settings()
    if s.aep_local_data_dir:
        # local layout: data/processed (cleaned), data/features, data/models
        return (Path(s.aep_local_data_dir).parent / rel).read_bytes()
    obj = get_store()._boto_session().client("s3").get_object(Bucket=s.aep_s3_bucket, Key=rel)
    return obj["Body"].read()


ZONE_X = ["customers", "is_recloser", "breaker_only", "primary_overhead_km", "primary_underground_km",
          "secondary_overhead_km", "secondary_underground_km", "customers_per_km", "poles", "poles_per_oh_km",
          "pole_wood_share", "pole_height_mean", "transformers", "oh_transformer_share", "depth", "history_damage"]
XF_X = ["xf_customers", "xf_overhead", "xf_kva", "xf_phase_known", "xf_single_phase", "secondary_oh_km_per_xf",
        "customers_per_km", "pole_wood_share", "history_damage"]
LOG = {"customers", "primary_overhead_km", "primary_underground_km", "secondary_overhead_km",
       "secondary_underground_km", "customers_per_km", "poles", "poles_per_oh_km", "transformers",
       "history_damage", "xf_customers", "xf_kva"}


def _fit(zones: pd.DataFrame, xfs: pd.DataFrame) -> dict:
    """Same recipe as modelling/train-model.ipynb, on Feb 2025. Used only when models.joblib
    can't be loaded (missing, or saved with a different scikit-learn version)."""
    from sklearn.compose import ColumnTransformer
    from sklearn.linear_model import LogisticRegression, PoissonRegressor
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import FunctionTransformer, StandardScaler

    def pipe(cols, model):
        pre = ColumnTransformer([("log", FunctionTransformer(np.log1p, feature_names_out="one-to-one"),
                                  [c for c in cols if c in LOG])], remainder="passthrough",
                                verbose_feature_names_out=False)
        return make_pipeline(pre, StandardScaler(), model).set_output(transform="pandas")

    return {
        "zone_risk": pipe(ZONE_X, LogisticRegression(max_iter=2000)).fit(zones[ZONE_X], zones.damaged_feb2025),
        "xf_risk": pipe(XF_X, LogisticRegression(max_iter=2000)).fit(xfs[XF_X], xfs.damaged_feb2025),
        "damage": {t: pipe(ZONE_X, PoissonRegressor(alpha=1e-3, max_iter=2000)).fit(zones[ZONE_X], zones[f"n_{t}_feb2025"])
                   for t in DAMAGE_TYPES},
    }


class Engine:
    def __init__(self) -> None:
        self.zones = pd.read_parquet(io.BytesIO(_read("features/zone_features.parquet")))
        self.xfs = pd.read_parquet(io.BytesIO(_read("features/transformer_features.parquet")))
        try:
            bundle = joblib.load(io.BytesIO(_read(get_settings().aep_model_key)))
            self.models, self.cols = bundle["models"], bundle["features"]
            self.models["zone_risk"].predict_proba(self.zones[self.cols["zone"]].head(1))
            self.source = "models.joblib"
        except Exception as exc:  # noqa: BLE001 - any load problem: refit from the features
            log.warning("models.joblib unusable (%s); fitting from the feature tables instead", exc)
            self.models, self.cols = _fit(self.zones, self.xfs), {"zone": ZONE_X, "xf": XF_X}
            self.source = "fitted at startup"
        links = pd.read_parquet(io.BytesIO(_read("features/home_links.parquet")))
        self.link_df = links
        self.links = {k: list(v) for k, v in links.groupby("premise_id").link}
        self.downstream = links.groupby("link").premise_id.nunique()  # homes behind each link

        p_zone = pd.Series(self.models["zone_risk"].predict_proba(self.zones[self.cols["zone"]])[:, 1], self.zones.index)
        p_xf = pd.Series(self.models["xf_risk"].predict_proba(self.xfs[self.cols["xf"]])[:, 1], self.xfs.index)
        # 246 fuses share a location id with a transformer: keep the higher risk
        self.p_link = pd.concat([p_zone, p_xf]).groupby(level=0).max()

        # explanation inputs: standardized zone features x coefficients
        pipe = self.models["zone_risk"]
        scaled = pipe[:-1].transform(self.zones[self.cols["zone"]])
        self.zone_contrib = scaled * pipe[-1].coef_[0]

        # expected Feb-2025-like damage per zone and type
        self.damage = pd.DataFrame(
            {t: self.models["damage"][t].predict(self.zones[self.cols["zone"]]) for t in DAMAGE_TYPES},
            index=self.zones.index)
        log.info("models loaded: %d zones, %d transformers, %d homes", len(self.zones), len(self.xfs), len(self.links))


_engine: Optional[Engine] = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        with _lock:
            if _engine is None:
                _engine = Engine()
    return _engine


# ---------------------------------------------------------------------------
# outage risk
# ---------------------------------------------------------------------------

def band(p: float) -> str:
    return "Low" if p < 0.15 else "Moderate" if p < 0.40 else "High" if p < 0.70 else "Very High"


def _scale(p, severity: float):
    return 1 - (1 - np.clip(p, 0, 0.999)) ** severity


def _round10(n: float) -> int:
    return max(10, int(round(n / 10.0)) * 10)


# plain-language reasons: shown for features that raise this home's risk, phrased by
# whether the value is above average (positive coefficient) or below (negative coefficient)
HIGH = {
    "primary_overhead_km": ("Long overhead lines", lambda v: f"About {v:.1f} km of overhead power line serves your area. Every stretch is open to wind, ice and falling branches, so more line means more places a storm can break it."),
    "secondary_overhead_km": ("Overhead wires", lambda v: f"About {v:.1f} km of overhead wire runs to the homes on your line. Branches and ice can bring these wires down."),
    "poles": ("Many poles", lambda v: f"Your line runs on about {int(v)} poles. Wind or a falling tree can snap any one of them, and one broken pole cuts power to every home past it."),
    "poles_per_oh_km": ("Many poles", lambda v: f"Your line has many poles close together (about {v:.0f} per km), so there are more points a storm can damage."),
    "pole_wood_share": ("Wood poles", lambda v: f"{v:.0%} of the poles on your line are wood, which can crack or rot and is more likely to break in high wind."),
    "pole_height_mean": ("Tall poles", lambda v: f"The poles on your line are tall (about {v:.0f} ft). Taller poles catch more wind and reach into more tree branches."),
    "customers": ("Shared line", lambda v: f"About {_round10(v)} homes share the safety switch that protects your line. It serves a longer stretch of line, so damage anywhere along it can trip the switch and cut your power."),
    "transformers": ("Lots of equipment", lambda v: f"Your line feeds {int(v)} transformers (the boxes that bring power down to homes). Each one, with its pole and wires, is another thing a storm can break, and one failure can trip the whole line."),
    "oh_transformer_share": ("Equipment on poles", lambda v: f"{v:.0%} of the equipment on your line sits up on poles, where wind, ice and branches can hit it."),
    "depth": ("Far from the substation", lambda v: f"Power reaches you through {int(v) + 1} protected sections in a row. Damage in any of them can cut you off, not just damage near your home."),
    "history_damage": ("Storm damage before", lambda v: f"Your line had {int(v)} damage report(s) in earlier storms, which suggests it's exposed to trees or wind."),
    "breaker_only": ("No local safety switch", lambda v: "No local safety switch protects your line, so a fault anywhere on the main line trips power for everyone on it, including you."),
    "is_recloser": ("Part of a bigger section", lambda v: "Your home is on a larger section protected by one automatic switch. A larger section covers more line, so more damage can trip it and take you out with it."),
}
LOW = {
    "primary_underground_km": ("Few buried lines", lambda v: "Almost none of the power line near you is underground, so all of it is open to wind and falling trees."),
    "secondary_underground_km": ("Few buried wires", lambda v: "Almost none of the wire serving your line is underground, so it's open to branches and ice."),
    "customers_per_km": ("Rural area", lambda v: f"Homes near you are spread out (about {v:.0f} per km of line). Long lines through open and wooded land face more trees and wind for every home they serve."),
    "is_recloser": ("Basic safety switch", lambda v: "Your line is protected by a fuse. A fuse can't reset itself, so even a brief fault, like a branch brushing the line, leaves you out until a crew replaces it."),
    "pole_height_mean": ("Shorter poles", lambda v: f"The poles on your line average about {v:.0f} ft."),
    "customers": ("Small line", lambda v: f"Only about {_round10(v)} homes share the safety switch that protects your line, so one fault on it affects your home directly."),
}


# reasons a home's risk is LOW: features that pull its risk down, phrased the same two ways
LOWERS_BELOW = {  # positive coefficient, value below average
    "primary_overhead_km": ("Short overhead lines", lambda v: f"Only a short stretch of overhead power line (about {v:.1f} km) serves your area, so there's less line for wind and trees to hit."),
    "secondary_overhead_km": ("Little overhead wire", lambda v: "Little overhead wire runs to the homes on your line, so there are fewer wires for branches to bring down."),
    "poles": ("Few poles", lambda v: f"Your line runs on only about {int(v)} poles, so there are fewer that a storm can break."),
    "transformers": ("Little equipment", lambda v: "Your line feeds only a little equipment, so there's less that can fail and trip the line."),
    "oh_transformer_share": ("Equipment on the ground", lambda v: "Most equipment on your line sits on the ground, away from wind and falling branches."),
    "customers": ("Small line", lambda v: f"Only about {_round10(v)} homes share the safety switch that protects your line, so it covers a short stretch with little to go wrong."),
    "pole_wood_share": ("Sturdier poles", lambda v: f"Only {v:.0%} of the poles on your line are wood; the rest stand up better to wind."),
    "depth": ("Close to the substation", lambda v: "Power reaches you through few sections, so there's less line between you and the substation where damage could cut you off."),
    "is_recloser": ("Own safety switch", lambda v: "Your line has its own fuse, so a fault on a neighbouring line gets cut off there instead of reaching you."),
}
LOWERS_ABOVE = {  # negative coefficient, value above average
    "primary_underground_km": ("Buried power line", lambda v: f"Much of the power line near you (about {v:.1f} km) is underground, where wind, ice and falling trees can't reach it."),
    "secondary_underground_km": ("Buried wires", lambda v: "Much of the wire serving your line is underground, where branches and ice can't reach it."),
    "customers_per_km": ("Homes close together", lambda v: "Homes near you are close together, so the lines between them are short and pass fewer trees."),
    "is_recloser": ("Automatic safety switch", lambda v: "An automatic switch protects your line. It can reset itself after a brief fault, like a branch brushing the line, instead of leaving you out."),
}


# what each feature is called in the storm-history sentence ("areas with ...")
EVIDENCE_PHRASE = {
    "primary_overhead_km": lambda v, more: f"{'at least' if more else 'at most'} {v:.1f} km of overhead line",
    "secondary_overhead_km": lambda v, more: f"{'at least' if more else 'at most'} {v:.1f} km of overhead wire",
    "poles": lambda v, more: f"{int(v)} or {'more' if more else 'fewer'} poles",
    "poles_per_oh_km": lambda v, more: "poles this close together" if more else "poles this spread out",
    "pole_wood_share": lambda v, more: f"{'at least' if more else 'at most'} {v:.0%} wood poles",
    "pole_height_mean": lambda v, more: f"poles {'this tall or taller' if more else 'this short or shorter'}",
    "customers": lambda v, more: f"{'this many or more' if more else 'this few or fewer'} homes on one safety switch",
    "transformers": lambda v, more: f"{int(v)} or {'more' if more else 'fewer'} transformers",
    "oh_transformer_share": lambda v, more: f"{'at least' if more else 'at most'} {v:.0%} of equipment on poles",
    "depth": lambda v, more: f"{int(v) + 1} or {'more' if more else 'fewer'} protected sections to the substation",
    "history_damage": lambda v, more: "damage in earlier storms" if more else "no damage in earlier storms",
    "breaker_only": lambda v, more: "no local safety switch" if v else "a local safety switch",
    "is_recloser": lambda v, more: "an automatic switch (recloser)" if v else "a fuse",
    "primary_underground_km": lambda v, more: f"{'at least' if more else 'at most'} {v:.1f} km of underground line",
    "secondary_underground_km": lambda v, more: f"{'at least' if more else 'at most'} {v:.1f} km of underground wire",
    "customers_per_km": lambda v, more: f"homes {'this close together or closer' if more else 'this spread out or more'}",
}
MIN_AREAS = 50  # compare against at least this many areas so the rate isn't noise


def feb2025_evidence(key: str, value: float) -> Optional[str]:
    """How often areas like this one were damaged in the Feb 2025 storm, from the real damage
    labels: areas at or beyond this home's value (same side of the median) vs all areas."""
    z = engine().zones
    if key not in z or key not in EVIDENCE_PHRASE:
        return None
    col, hit = z[key], z["damaged_feb2025"]
    if set(col.dropna().unique()) <= {0, 1}:          # yes/no feature: same value
        group = hit[col == value]
        more = bool(value)
    else:
        more = value >= col.median()
        group = hit[col >= value] if more else hit[col <= value]
        if len(group) < MIN_AREAS:                     # widen to the MIN_AREAS nearest that side
            order = col.sort_values(ascending=not more)
            group = hit[order.index[:MIN_AREAS]]
            value = float(col[order.index[MIN_AREAS - 1]])  # describe the widened group honestly
    if len(group) < MIN_AREAS:
        return None
    ratio = group.mean() / hit.mean()
    like = EVIDENCE_PHRASE[key](value, more)
    if ratio >= 1.2:
        return f"In the February 2025 storm, areas with {like} were damaged {ratio:.1f}× as often as the average area."
    if ratio <= 0.8:
        return f"In the February 2025 storm, areas with {like} were damaged {(1 - ratio):.0%} less often than the average area."
    return None


def _path(premise_id: str) -> Optional[list[str]]:
    return engine().links.get(str(premise_id))


def link_risk(premise_id: str, severity: float = 1.0) -> dict[str, dict]:
    """Risk per link on the home's path: {link_id: {probability, band, kind, confidence}}."""
    e = engine()
    out = {}
    for link in _path(premise_id) or []:
        p = float(_scale(e.p_link.get(link, 0.0), severity))
        kind = "transformer" if link in e.xfs.index and link not in e.zones.index else "zone"
        out[link] = {"probability": round(p, 4), "band": band(p), "kind": kind,
                     "confidence": "Low" if kind == "transformer" else "Medium"}
    return out


def home_risk(premise_id: str, severity: float = 1.0) -> dict:
    """Risk card for one home, in the shape of mock/api/risk.json."""
    e = engine()
    p = topo.find_premise(get_store(), premise_id)
    path = _path(premise_id)
    base = {"premise_id": str(premise_id), "storm_severity": severity, "label": "Model estimate"}
    if not p or not p.get("has_chain") or not path:
        return base | {
            "probability": None, "band": None, "confidence": "Low", "top_factors": [],
            "fallback": {"reason": "missing_network_link", "message": (
                "We can't give a reliable outage estimate for your location because we couldn't "
                "link it to the power network. Here is general storm guidance instead.")}}

    lr = link_risk(premise_id, severity)
    prob = 1 - np.prod([1 - v["probability"] for v in lr.values()])

    # reasons come from the riskiest fuse/recloser area on the path
    zone_links = [l for l in path if l in e.zones.index]
    factors = []
    if zone_links:
        weakest = max(zone_links, key=lambda l: e.p_link.get(l, 0))
        c = e.zone_contrib.loc[weakest]
        coef = pd.Series(e.models["zone_risk"][-1].coef_[0], index=c.index)
        # a low-risk home is explained by what keeps its risk down; otherwise by what raises it
        low = prob < 0.15
        ranked = c[c < 0].sort_values() if low else c[c > 0].sort_values(ascending=False)
        for key in ranked.index:
            if low:
                table = LOWERS_BELOW if coef[key] > 0 else LOWERS_ABOVE
            else:
                table = HIGH if coef[key] > 0 else LOW
            if key in table and len(factors) < 3:
                label, detail = table[key]
                v = float(e.zones.at[weakest, key])
                evidence = feb2025_evidence(key, v)
                factors.append({"key": key, "label": label, "detail": detail(v), "evidence": evidence,
                                "direction": "lowers" if low else "raises", "weight": round(float(c[key]), 2)})

    coverage = topo.data_coverage(p)
    return base | {
        "probability": round(float(prob), 3), "band": band(prob),
        "confidence": "Medium" if coverage == "good" else "Low",
        "confidence_reason": (
            f"Trained on the Feb 2025 storm and tested on Sep 2024, a storm it never saw: it ranked "
            f"homes correctly about {HOME_AUC_SEP2024:.0%} of the time. Storm strength is a scenario input."),
        "top_factors": factors, "fallback": None,
    }


def link_detail(link: Optional[str], severity: float = 1.0) -> Optional[dict]:
    """{p_damage, band, reason} for one Power Path link (zone or transformer), or None if unscored.
    Covers every link on all 110 circuits; used by risk_model.py for the map's Power Path."""
    e = engine()
    if link is None or link not in e.p_link.index:
        return None
    p = float(_scale(e.p_link[link], severity))
    reason = None
    if link in e.zones.index:
        c = e.zone_contrib.loc[link]
        coef = pd.Series(e.models["zone_risk"][-1].coef_[0], index=c.index)
        for key in c[c > 0].sort_values(ascending=False).index:
            table = HIGH if coef[key] > 0 else LOW
            if key in table:
                reason = table[key][1](float(e.zones.at[link, key]))
                break
    else:
        x = e.xfs.loc[link]
        reason = ("A pole-mounted transformer, exposed to wind and falling limbs." if x.xf_overhead
                  else "A ground-level (pad-mounted) transformer, sheltered from wind.")
    return {"p_damage": round(p, 4), "band": band(p), "reason": reason}


def risk_by_severity(premise_id: str) -> dict[str, dict]:
    return {f"{s:.1f}": home_risk(premise_id, s) for s in SEVERITIES}


@lru_cache
def risk_heat(severity: float = 1.0, cell_deg: float = 0.005, min_homes: int = 5) -> dict:
    """Map heat of predicted outage risk: every home's P(out) (same formula as home_risk),
    averaged over ~500 m cells. Cells with fewer than `min_homes` homes are dropped, so no
    single home can be picked out."""
    e = engine()
    df = e.link_df[["premise_id", "link"]].copy()
    p = _scale(df["link"].map(e.p_link).fillna(0.0).to_numpy(), severity)
    df["log_keep"] = np.log1p(-p)  # P(out) = 1 - prod(1 - p_link) = 1 - exp(sum log(1 - p_link))
    home_p = 1 - np.exp(df.groupby("premise_id")["log_keep"].sum())
    home_p.index = home_p.index.astype(str)

    prem = get_store().get("premise")[["premise_id", "lat", "lon"]].dropna()
    prem = prem.assign(premise_id=prem["premise_id"].astype(str))
    prem = prem[prem["premise_id"].isin(home_p.index)]
    prem = prem.assign(p=prem["premise_id"].map(home_p),
                       cy=np.floor(prem["lat"] / cell_deg), cx=np.floor(prem["lon"] / cell_deg))
    g = prem.groupby(["cy", "cx"])["p"].agg(["mean", "size"])
    g = g[g["size"] >= min_homes]
    cells = [{"lat": round((cy + 0.5) * cell_deg, 5), "lon": round((cx + 0.5) * cell_deg, 5),
              "probability": round(float(r["mean"]), 3), "band": band(float(r["mean"])),
              "homes": _round10(float(r["size"]))}
             for (cy, cx), r in g.iterrows()]
    return {"storm_severity": severity, "cell_size_deg": cell_deg, "min_homes": min_homes,
            "label": "Model estimate",
            "note": f"Average predicted chance of losing power per ~500 m area; areas with fewer than "
                    f"{min_homes} homes are hidden.",
            "cells": cells}


# ---------------------------------------------------------------------------
# restoration simulator
# ---------------------------------------------------------------------------

@lru_cache
def _bundle_hours() -> dict[str, float]:
    rb = get_store().get("repair_bundle").set_index("asset_type").direct_hours
    # device damage is mostly fuses (76% of Feb 2025 device reports), then reclosers and switches
    device = 0.76 * rb["Fuse Bank"] + 0.18 * rb["Recloser Bank"] + 0.06 * rb["Switch"]
    return {"pole": rb["Pole"], "primary_wire": rb["primary"], "transformer": rb["Transformer"],
            "device": float(device), "secondary": rb["secondary"], "fuse": rb["Fuse Bank"]}


@lru_cache
def _adders() -> tuple[float, float]:
    a = get_store().get("labor_adder").set_index("adder").hours
    return float(a["access_constraint"]), float(a["indirect_labor_multiplier_ILM"])


@lru_cache(maxsize=256)
def _damage_inputs(premise_id: str) -> dict:
    """Expected Feb-2025-like damage that decides this home's restoration:
      own    its own fuse/recloser area (transformer and secondary only on its own transformer)
      up     the other areas on its path, between it and the substation
      ahead  repairs in its feeder section that serve more homes, so crews do them first
      crit   repairs in areas feeding hospitals, fire and EMS on its circuit
    """
    e = engine()
    p = topo.find_premise(get_store(), premise_id)
    own_zone = p.get("zone_id")
    zones_on_path = [l for l in _path(premise_id) or [] if l in e.zones.index]
    upstream = [z for z in zones_on_path if z != own_zone]
    d = e.damage

    own = d.loc[[own_zone]].sum() if own_zone in d.index else d.iloc[:0].sum()
    n_xf = max(1.0, float(e.zones.at[own_zone, "transformers"])) if own_zone in e.zones.index else 1.0
    own[["transformer", "secondary"]] /= n_xf
    up = d.loc[upstream].sum()
    up[["transformer", "secondary"]] = 0  # transformer damage elsewhere doesn't cut this home

    # feeder section = everything behind the most upstream fuse/recloser on the path
    top = max(zones_on_path, key=lambda z: e.downstream.get(z, 0)) if zones_on_path else own_zone
    behind = e.link_df.premise_id[e.link_df.link == top]
    section = set(get_store().get("premise").set_index("premise_id").zone_id.reindex(behind).dropna())
    mine = e.downstream.get(own_zone, 0)
    ahead_zones = [z for z in section - set(zones_on_path) if z in d.index and e.downstream.get(z, 0) > mine]
    circuit = e.zones.index[e.zones.circuit_id == p["circuit_id"]]
    facility_zones = set(get_store().get("facility").zone_id.dropna())
    crit_zones = [z for z in circuit if z in facility_zones and z not in zones_on_path]
    return {"own": own[DAMAGE_TYPES].values, "up": up[DAMAGE_TYPES].values,
            "ahead": d.loc[ahead_zones].sum()[DAMAGE_TYPES].values,
            "crit": d.loc[crit_zones].sum()[DAMAGE_TYPES].values,
            "circuit": d.loc[circuit].sum()[DAMAGE_TYPES].values}


def simulate(premise_id: str, crews: int = 2, storm_severity: float = 1.0, access: str = "auto",
             switching_available: bool = True, failed_upstream_device: Optional[str] = None,
             prioritize_critical: bool = True, start_delay_h: float = 6.0, seed: int = 0,
             known_damage: Optional[dict[str, float]] = None) -> dict:
    """Monte Carlo restoration time for a home, given that it loses power. Hours, P10/P50/P90.
    known_damage ({type: count} on the home's own line, e.g. from damage assessment) replaces
    the model's draws for the home's line; work ahead is still drawn from the model.

    Crews work in priority order (MVP plan 5.2): critical facilities first (when on), then
    repairs serving more homes, then this home's own line. Time = start delay + work ahead
    shared across crews + the home's own repairs (in parallel up to the number of jobs)."""
    rng = np.random.default_rng(seed)  # same seed for every scenario: differences come only from inputs
    inp = _damage_inputs(str(premise_id))
    h = _bundle_hours()
    hours = np.array([h[t] for t in DAMAGE_TYPES])
    access_h, _ = _adders()
    p_access = {"auto": ACCESS_BASE_RATE, "on": 1.0, "off": 0.0}[access]
    n, k = N_RUNS, len(DAMAGE_TYPES)

    ilm = rng.uniform(3.5, 5.5, n)              # travel / non-productive multiplier (workbook: 4.5)
    jitter = rng.uniform(0.7, 1.3, (n, k))      # +-30% on hands-on hours
    delay = start_delay_h * rng.uniform(0.5, 1.5, n)

    def draw(lam):
        return rng.poisson(lam * storm_severity, (n, k)).astype(float)

    own, up, ahead, crit = draw(inp["own"]), draw(inp["up"]), draw(inp["ahead"]), draw(inp["crit"])

    # "if you lose power": runs with no damage on the path get one job on the home's branch
    w = inp["own"] + inp["up"]
    w = w / w.sum() if w.sum() > 0 else np.full(k, 1 / k)
    none = (own.sum(1) + up.sum(1)) == 0
    own[none, rng.choice(k, none.sum(), p=w)] += 1
    if known_damage is not None:
        own = np.tile([float(known_damage.get(t, 0)) for t in DAMAGE_TYPES], (n, 1))
        up = np.zeros((n, k))

    def crew_hours(counts):
        acc = rng.binomial(counts.sum(1).astype(int), p_access) * access_h
        return ((counts * hours * jitter).sum(1) + acc) * ilm

    h_own, h_up = crew_hours(own), crew_hours(up)
    if failed_upstream_device:  # the fuse feeding the home must be replaced too
        h_own = h_own + h["fuse"] * ilm
    # switching isolates upstream damage: the home waits only for its own branch (+1 h to switch)
    h_path = h_own + (np.where(h_up > 0, 1.0, 0.0) if switching_available else h_up)
    n_path = own.sum(1) + (0 if switching_available else up.sum(1))
    h_ahead = crew_hours(ahead) + (crew_hours(crit) if prioritize_critical else 0)
    t = delay + h_ahead / crews + h_path / np.clip(np.minimum(crews, n_path), 1, None)
    p10, p50, p90 = np.percentile(t, [10, 50, 90])
    sev = storm_severity
    return {"p10": round(float(p10), 1), "p50": round(float(p50), 1), "p90": round(float(p90), 1),
            "runs": np.round(np.sort(t), 1).tolist(),  # every simulated outage length, for "Time That Matters"
            "expected_damage_on_your_path": {t: round(float(v), 2) for t, v in zip(DAMAGE_TYPES, (inp["own"] + inp["up"]) * sev)},
            "expected_damage_ahead": {t: round(float(v), 2) for t, v in zip(DAMAGE_TYPES, (inp["ahead"] + inp["crit"]) * sev)},
            "expected_damage_on_circuit": {t: round(float(v), 1) for t, v in zip(DAMAGE_TYPES, inp["circuit"] * sev)}}


@lru_cache(maxsize=64)
def restoration_grid(premise_id: str) -> dict:
    """Every dashboard scenario (crews 1-10 x severity x access x switching x failed fuse x
    critical-first), in the shape of mock/api/restoration_grid.json, plus drivers and jobs."""
    rows = []
    for crews, sev, acc, sw, failed, crit in itertools.product(
            range(1, 11), SEVERITIES, ["auto", "on", "off"], [True, False], [None, "fuse"], [True, False]):
        r = simulate(premise_id, crews, sev, acc, sw, failed, crit)
        rows.append({"crews": crews, "storm_severity": sev, "access": acc, "switching_available": sw,
                     "failed_upstream_device": failed, "prioritize_critical": crit,
                     "p10": r["p10"], "p50": r["p50"], "p90": r["p90"]})

    def p50(**kw):
        sc = dict(crews=2, storm_severity=1.0, access="auto", switching_available=True,
                  failed_upstream_device=None, prioritize_critical=True) | kw
        return next(r["p50"] for r in rows if all(r[k] == v for k, v in sc.items()))

    base = simulate(premise_id)
    d_crews, d_fuse, d_sev = p50(crews=6) - p50(), p50(failed_upstream_device="fuse") - p50(), p50(storm_severity=1.5) - p50()
    drivers = sorted([
        {"text": f"Crews: going from 2 to 6 crews changes the most likely time by about {d_crews:+.0f} h", "impact_h": round(d_crews, 1)},
        {"text": f"A failed fuse on your line adds about {d_fuse:.0f} h", "impact_h": round(d_fuse, 1)},
        {"text": f"A stronger storm (1.5x) adds about {d_sev:.0f} h", "impact_h": round(d_sev, 1)},
    ], key=lambda d: -abs(d["impact_h"]))
    drivers = [d for d in drivers if abs(d["impact_h"]) >= 0.5] or [
        {"text": "Your line needs few repairs, so crews and storm strength barely change the estimate", "impact_h": 0.0}]

    h, (_, ilm) = _bundle_hours(), _adders()
    inp = _damage_inputs(str(premise_id))

    def hrs(v):
        return round(float(sum(v[i] * h[t] for i, t in enumerate(DAMAGE_TYPES)) * ilm), 1)

    path_d = base["expected_damage_on_your_path"]
    likely = ", ".join(t.replace("_", " ") for t in sorted(path_d, key=path_d.get, reverse=True)[:2])
    jobs = [
        {"order": 1, "what": f"Repairs feeding hospitals, fire and EMS on your circuit (~{sum(inp['crit']):.1f} items expected)",
         "crew_hours": hrs(inp["crit"]), "status": "expected"},
        {"order": 2, "what": f"Repairs upstream that serve more homes than yours (~{sum(inp['ahead']):.1f} items expected)",
         "crew_hours": hrs(inp["ahead"]), "status": "expected"},
        {"order": 3, "what": f"Repairs on your own line (most likely: {likely})",
         "crew_hours": hrs(inp["own"] + inp["up"]), "status": "expected", "on_your_line": True},
    ]
    return {"premise_id": str(premise_id), "start_delay_h": 6, "results": rows, "drivers": drivers,
            "jobs_ahead_of_you": jobs, "label": "Model estimate", "confidence": "Medium",
            "assumptions": [
                "Expected damage comes from the damage-count model trained on Feb 2025, scaled by storm severity.",
                "Repair hours from the AEP labor workbook and structure drawings, times a 3.5-5.5 travel/setup multiplier (workbook: 4.5).",
                f"Each repair has a {ACCESS_BASE_RATE:.0%} chance of an access problem (+0.5 h) unless access is forced on or off.",
                "Work starts about 6 h after the storm peak. Range = 10th to 90th percentile of 200 simulations."]}
