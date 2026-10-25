"""A-to-home outage risk: combine the Model-A link probabilities on a home's
chain into a single per-home probability, then package it as the risk card the
dashboard expects (mock/api/risk*.json).

    P(out) = 1 - prod(1 - p_link)   over the links on the home's chain.

Because the links are a serial path (any one failing cuts the home), this is the
natural combination and needs no extra model. The home's top factors are the
feature contributions of its single riskiest link, translated to plain language.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any
import numpy as np
import pandas as pd

from .features import FEATURE_LABELS
from .model_a import ModelA

# Band thresholds from the output contract (model-targets section 2).
_BANDS = [
    (0.15, "Low"),
    (0.40, "Moderate"),
    (0.70, "High"),
    (1.01, "Very High"),
]


def band_for(p: float | None) -> str | None:
    if p is None or (isinstance(p, float) and np.isnan(p)):
        return None
    for hi, name in _BANDS:
        if p < hi:
            return name
    return "Very High"


@dataclass
class RiskResult:
    premise_id: str
    storm_severity: float
    probability: float | None
    band: str | None
    confidence: str
    confidence_reason: str | None
    top_factors: list[dict[str, Any]] = field(default_factory=list)
    label: str = "Model estimate"
    fallback: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_FALLBACK_NO_LINK = {
    "reason": "missing_network_link",
    "message": ("We can't give a reliable outage estimate for your location "
                "because we couldn't link it to the power network. Here is "
                "general storm guidance instead."),
}


def _top_factors(model: ModelA, home_links: pd.DataFrame, k: int = 3) -> list[dict[str, Any]]:
    """Top raising reasons from the home's riskiest link."""
    if home_links.empty:
        return []
    # Riskiest link = highest p_link already computed on the rows.
    riskiest = home_links.loc[home_links["p_link"].idxmax()]
    contrib = model.contributions(riskiest)

    factors = []
    for key, val in sorted(contrib.items(), key=lambda kv: abs(kv[1]), reverse=True):
        if key not in FEATURE_LABELS or val == 0.0:
            continue
        label, detail = FEATURE_LABELS[key]
        factors.append({
            "key": key,
            "label": label,
            "detail": detail,
            "direction": "raises" if val > 0 else "lowers",
            "weight": round(abs(val), 3),
        })
        if len(factors) >= k:
            break
    return factors


def _confidence(home_links: pd.DataFrame) -> tuple[str, str]:
    """Simple coverage-based confidence. More known links + pole data = higher."""
    n_links = len(home_links)
    pole_known = home_links["pole_age_known"].mean() if n_links else 0.0
    if n_links >= 3 and pole_known >= 0.5:
        return ("Medium",
                "Good data coverage for your area; the model was tested on one "
                "held-out storm (Sep 2024).")
    if n_links >= 2:
        return ("Medium",
                "We linked your home to the power network; some structure data "
                "(e.g. pole age) is incomplete.")
    return ("Low",
            "Limited network detail for your location, so treat this estimate "
            "as rough.")


def home_risk(model: ModelA, tables, frame: pd.DataFrame, premise_id: str,
              event: str = "feb2025", severity: float = 1.0) -> RiskResult:
    """Risk card for one premise and severity. ``frame`` is the full link frame
    (features.build_link_frame)."""
    from .features import build_home_links

    prem = tables.premise.loc[tables.premise["premise_id"].eq(str(premise_id))]
    has_chain = bool(prem["has_chain"].iloc[0]) if len(prem) else False

    home_links = build_home_links(tables, frame, event)
    home_links = home_links[home_links["premise_id"].eq(str(premise_id))].copy()

    if home_links.empty or not has_chain:
        return RiskResult(
            premise_id=str(premise_id), storm_severity=severity,
            probability=None, band=None, confidence="Low",
            confidence_reason=None, top_factors=[],
            fallback=_FALLBACK_NO_LINK,
        )

    home_links["p_link"] = model.predict_proba(home_links, event=event, severity=severity)
    p_out = float(1.0 - np.prod(1.0 - home_links["p_link"].to_numpy()))

    conf, reason = _confidence(home_links)
    return RiskResult(
        premise_id=str(premise_id), storm_severity=severity,
        probability=round(p_out, 4), band=band_for(p_out),
        confidence=conf, confidence_reason=reason,
        top_factors=_top_factors(model, home_links),
        fallback=None,
    )


def risk_by_severity(model: ModelA, tables, frame: pd.DataFrame, premise_id: str,
                     event: str = "feb2025",
                     severities=(0.5, 1.0, 1.5, 2.0)) -> list[dict[str, Any]]:
    """Risk card at each severity stop (mock/api/risk_by_severity.json shape)."""
    return [home_risk(model, tables, frame, premise_id, event=event, severity=s).to_dict()
            for s in severities]
