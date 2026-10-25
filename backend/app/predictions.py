"""Prediction layer: outage risk and restoration time for a premise.

This is the ONE place the trained models plug in. The chat tools (and later the
dashboard endpoints) call these functions and never need to change.

Both functions now call the trained models in predict.py (risk per home from the
link-damage models; restoration from the Monte Carlo simulator over the damage-count
model and AEP labor hours), so the chat and the dashboard show the same numbers.
"""
from __future__ import annotations

from . import predict

SEVERITIES = [0.5, 1.0, 1.5, 2.0]


def _nearest(value: float, options: list[float]) -> float:
    return min(options, key=lambda o: abs(o - value))


def predict_risk(premise_id: str, storm_severity: float = 1.0) -> dict:
    """Risk band, probability, confidence and top reasons for a storm of this severity."""
    sev = _nearest(float(storm_severity), SEVERITIES)
    r = predict.home_risk(premise_id, sev)
    if r["fallback"]:
        return {"error": r["fallback"]["message"], "label": "Model estimate"}
    return {
        "storm_severity": sev, "risk_band": r["band"], "probability": r["probability"],
        "confidence": r["confidence"], "confidence_reason": r["confidence_reason"],
        "top_reasons": [(f["evidence"] + " " if f.get("evidence") else "") + f["detail"] for f in r["top_factors"]],
        "label": "Model estimate", "source": "trained outage-risk model (Feb 2025, tested on Sep 2024)",
    }


def simulate_restoration(premise_id: str, crews: int = 2, storm_severity: float = 1.0, access: str = "auto",
                         switching_available: bool = True, prioritize_critical: bool = True) -> dict:
    """Likely restoration range in hours for a scenario (the sliders)."""
    want = {
        "crews": max(1, min(10, int(crews))),
        "storm_severity": _nearest(float(storm_severity), SEVERITIES),
        "access": access if access in ("auto", "on", "off") else "auto",
        "switching_available": bool(switching_available),
        "failed_upstream_device": None,
        "prioritize_critical": bool(prioritize_critical),
    }
    if not predict.home_risk(premise_id)["probability"]:
        return {"error": "No equipment chain is recorded for this location, so there is no personal restoration estimate."}
    row = predict.simulate(premise_id, **want)

    def p50(**change) -> float:
        return predict.simulate(premise_id, **(want | change))["p50"]

    # "what moves it": the same scenario recalculated with one input changed (real numbers to explain with)
    moves = []
    if want["crews"] < 10:
        more = min(10, want["crews"] + 2)
        moves.append({"change": f"{more} crews instead of {want['crews']}", "most_likely_hours": p50(crews=more)})
    if want["access"] != "on":
        moves.append({"change": "road access problems at every repair", "most_likely_hours": p50(access="on")})
    if want["switching_available"]:
        moves.append({"change": "no switching to reroute power", "most_likely_hours": p50(switching_available=False)})
    if want["storm_severity"] < 2.0:
        worse = SEVERITIES[SEVERITIES.index(want["storm_severity"]) + 1]
        moves.append({"change": f"a stronger storm ({worse}x February 2025)", "most_likely_hours": p50(storm_severity=worse)})
    return want | {
        "likely_range_hours": [row["p10"], row["p90"]], "most_likely_hours": row["p50"],
        "what_moves_it": moves,
        "expected_damage_on_your_line": row["expected_damage_on_your_path"],
        "what_this_includes": "if your home loses power: repairs on your own line plus repairs crews do first "
                              "(critical facilities, then branches serving more homes), shared among the crews, "
                              "plus a start delay of about 6 hours after the storm passes",
        "label": "Model estimate", "source": "restoration simulator (AEP labor hours x damage model)",
    }
