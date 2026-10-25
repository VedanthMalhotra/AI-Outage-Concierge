"""Prediction layer: outage risk and restoration time for a premise.

This is the ONE place the trained models plug in. The chat tools (and later the
dashboard endpoints) call these functions and never need to change.

Today: both functions return the sample model output in ../mock/api, labelled
source="sample model output".

To connect the trained models (ML teammate), deliver to S3:
    models/risk/model.joblib      scikit-learn estimator with predict_proba()
    models/risk/features.json     ordered list of input column names (from features/zone_features)
    models/risk/metrics.json      {"test_event": "sep2024", "auc": ..., "confidence": "Medium"}
    models/damage/...             expected damage counts per zone (same layout)
    models/access/...             probability of access problems per zone (same layout)
then replace the bodies below: look up the premise's zone_id, build the feature
row in features.json order, scale by storm severity, and return the SAME keys.
Restoration becomes the simulator: expected damage x labor hours (labor_unit,
repair_bundle) x ILM 4.5 / crews, plus repair order and start delay.
"""
from __future__ import annotations

import json
from pathlib import Path

MOCK_DIR = Path(__file__).resolve().parents[2] / "mock" / "api"
SEVERITIES = [0.5, 1.0, 1.5, 2.0]
SOURCE = "sample model output"


def _mock(name: str) -> dict:
    return json.loads((MOCK_DIR / name).read_text(encoding="utf-8"))


def _nearest(value: float, options: list[float]) -> float:
    return min(options, key=lambda o: abs(o - value))


def _reasons_from_profile(premise_id: str) -> list[str]:
    """Plain-language risk factors taken from this home's real data (not the sample file)."""
    from .profile import customer_profile  # local import: profile loads data lazily
    p = customer_profile(premise_id) or {}
    reasons = []
    if p.get("service_type") == "Overhead":
        reasons.append("Your home is fed by an overhead line, which is more exposed to wind, ice and falling trees.")
    elif p.get("service_type") == "Underground":
        reasons.append("Your home is fed by an underground line, which is less exposed to wind and falling trees.")
    feb = (p.get("zone") or {}).get("past_damage_by_storm", {}).get("feb2025")
    if feb:
        parts = ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in feb.items())
        reasons.append(f"In the February 2025 storm, your zone had damage reports for: {parts}.")
    if (p.get("outage_history") or {}).get("lost_power_feb2025_storm"):
        reasons.append("Your home lost power in the February 2025 storm.")
    first = (p.get("power_path") or {}).get("first_protective_device")
    if first == "Fuse":
        reasons.append("The first device protecting your branch is a fuse, which can't reset itself after a temporary fault.")
    elif first and first.startswith("Recloser"):
        reasons.append("Your branch is protected by a recloser, which can reset itself after brief faults.")
    oh_km = (p.get("area_factors") or {}).get("primary_overhead_km")
    if oh_km:
        reasons.append(f"Your zone has about {oh_km} km of overhead primary line.")
    return reasons[:4]


def predict_risk(premise_id: str, storm_severity: float = 1.0) -> dict:
    """Risk band, probability, confidence and top reasons for a storm of this severity."""
    sev = _nearest(float(storm_severity), SEVERITIES)
    r = _mock("risk_by_severity.json")[f"{sev:.1f}"]
    try:
        reasons = _reasons_from_profile(premise_id) or [f["detail"] for f in r["top_factors"]]
    except Exception:
        reasons = [f["detail"] for f in r["top_factors"]]
    return {
        "storm_severity": sev, "risk_band": r["band"], "probability": r["probability"],
        "confidence": r["confidence"], "top_reasons": reasons,
        "label": "Model estimate",
        "source": "probability: sample model output; reasons: this home's AEP data",
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
    grid = _mock("restoration_grid.json")["results"]

    def p50(**change) -> float:
        w = want | change
        return next(r for r in grid if all(r[k] == v for k, v in w.items()))["p50"]

    row = next(r for r in grid if all(r[k] == v for k, v in want.items()))
    base = row["p50"]
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
        "likely_range_hours": [row["p10"], row["p90"]], "most_likely_hours": base,
        "what_moves_it": moves,
        "what_this_includes": "repair work for expected storm damage on your circuit, divided among the crews, "
                              "plus a 6-hour start delay for crews to begin after the storm passes",
        "label": "Model estimate", "source": SOURCE,
    }
