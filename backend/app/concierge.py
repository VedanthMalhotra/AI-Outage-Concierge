"""Customer-facing rules built on the model output: preparation guidance, alert
eligibility, the storm-replay timeline, the assumptions list and the circuit outline.

Every number comes from predict.py (risk, restoration) or the cleaned tables (real
Feb 2025 damage on the home's own path). The rules themselves (MVP plan 5.3 / 5.4)
are challenge assumptions, not AEP policy, and say so.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

from . import predict
from . import topology as topo
from .data import get_store

SAFETY = [
    {"level": "emergency", "text": "Medical emergency or someone hurt: call 911 now."},
    {"level": "safety", "text": "Stay at least 30 feet from downed lines, including the line to your house. Report them to AEP."},
    {"level": "safety", "text": "Run generators outdoors only, far from windows. Carbon monoxide can kill."},
    {"level": "safety", "text": "Never refuel a running generator."},
]

ASSUMPTIONS = [
    "Outage risk: logistic-regression models of damage to each fuse/recloser area and transformer on your "
    "power path, trained on the Feb 2025 storm and tested on Sep 2024 (ranks homes correctly about 72% of the time).",
    "Storm severity is a scenario input (no weather data). 1.0 = like Feb 2025; it scales the damage rate.",
    "Restoration: 200 simulated storms using expected damage from the damage-count model, AEP labor-workbook "
    "hours and structure drawings, a 3.5-5.5 travel/setup multiplier (workbook: 4.5) and a 6 h start delay.",
    "Each repair has a 32% chance of an access problem (+0.5 h): the historical rate, since the access model "
    "was close to chance on the held-out storm.",
    "Crews work critical facilities first (when on), then repairs serving more homes, then your line.",
    "Repair hours for re-stringing a wire span are approximate (not in the workbook).",
    "Damage quantity (Media field) read as a count; zeros treated as 1 (unconfirmed with AEP).",
    "Storm replay uses the real Feb 2025 damage reports on your own power path.",
    "Alert and guidance rules are challenge assumptions, not AEP policy.",
    "Your location and any needs you share are used only for this session.",
]


def _bucket(hours: float) -> str:
    return "lt4h" if hours < 4 else "4-24h" if hours <= 24 else "gt24h"


@lru_cache(maxsize=256)
def _outlook(premise_id: str) -> Optional[dict]:
    """Risk and default restoration for a Feb-2025-like storm, or None without a chain."""
    risk = predict.home_risk(premise_id, 1.0)
    if risk["fallback"]:
        return None
    rest = predict.simulate(premise_id)
    return {"risk": risk, "rest": rest}


def general_guidance() -> dict:
    """Storm guidance for anyone, when no home is selected (no personal estimates). Nothing here
    depends on an outage length, since there is none to base it on: no freezer or fridge times,
    no water amounts, no 'if it lasts' plans."""
    return {
        "note": "General guidance. Without a premise ID we can't estimate this home's outage chance or length, "
                "so don't give food, freezer or water amounts or outage durations.",
        "safety": [x["text"] for x in SAFETY],
        "before_the_storm": ["Charge phones, power banks and laptops", "Have flashlights and spare batteries ready (no candles)",
                             "Know where your main breaker is"],
        "while_the_power_is_out": ["Stay at least 30 ft from downed lines and damaged poles, and report them",
                                   "Run a generator outdoors only, far from windows",
                                   "Unplug sensitive electronics; leave one light on so you know when power is back"],
        "after_power_is_back": ["Plug appliances back in one at a time", "If neighbours are back on but you're not, report it",
                                "Downed lines can still be live: keep away and report them"],
        "sources": "Electrical safety basics; MVP plan guidance rules",
    }


# ---------------------------------------------------------------------------
# guidance (MVP plan 5.3): risk band x expected duration, plus modifiers
# ---------------------------------------------------------------------------

def guidance(premise_id: str) -> dict:
    p = topo.find_premise(get_store(), premise_id) or {}
    o = _outlook(premise_id)
    band = o["risk"]["band"] if o else "Unknown"
    hours = o["rest"]["p50"] if o else 24.0
    bucket = _bucket(hours)
    high = band in ("High", "Very High")

    checklist = ["Charge phones, power banks and laptops before the storm.",
                 "Have flashlights and spare batteries ready (no candles)."]
    if bucket != "lt4h":
        checklist += ["Store 1 gallon of water per person per day for 3 days.",
                      "Stock food that needs no cooking or refrigeration.",
                      "Check you have enough of any medicines."]
    if bucket == "gt24h":
        checklist += ["Plan where you could stay if the outage lasts more than a day.",
                      "Fill your car's tank."]
    if high:
        checklist.append("Unplug sensitive electronics before the storm.")
        if bucket != "lt4h":
            checklist += ["Keep the fridge and freezer closed; food stays cold about 4 hours (fridge) and 48 hours (full freezer).",
                          "Get some cash; card readers may be down.",
                          "Arrange a check-in with a neighbour."]
    if p.get("service_type") == "Overhead":
        checklist.append("Your home has an overhead service line: stay clear of it if it comes down.")

    base = {"risk_band": band, "duration_bucket": bucket, "expected_hours": hours,
            "safety": SAFETY, "checklist": checklist, "label": "Your action",
            "based_on": "your outage risk and most likely restoration time (model estimates)"}
    medical_items = ["Check the battery backup of any medical equipment and charge it fully.",
                     "Contact your equipment supplier about backup power.",
                     f"Plan where to go if power is out longer than your battery lasts (most likely outage: about {hours:.0f} h)."]
    return {"variants": {
        "no-needs": base | {"declared_needs": [], "escalation": None},
        "medical": base | {"declared_needs": ["medical_equipment"], "checklist": medical_items + checklist,
                           "escalation": "Medical escalation is on: you get earlier notice and a phone-call option."},
    }}


# ---------------------------------------------------------------------------
# alerts (MVP plan 5.4)
# ---------------------------------------------------------------------------

def alerts(premise_id: str) -> dict:
    o = _outlook(premise_id)
    band = o["risk"]["band"] if o else None
    conf = o["risk"]["confidence"] if o else "Low"
    p90 = o["rest"]["p90"] if o else None
    elevated = band in ("Moderate", "High", "Very High")
    high = band in ("High", "Very High")
    a1 = {"id": "A1", "name": "Pre-storm alert", "met": elevated,
          "why": f"Your risk is {band} ({'at least' if elevated else 'below'} Moderate)." if band else "No risk estimate for your location."}
    if elevated:
        a1 |= {"channels": ["sms", "email"] + (["push"] if high else []), "timing": ["T-24h"] + (["T-6h"] if high else [])}
    rules = [
        {"id": "A0", "name": "Basic outage alerts", "met": True, "why": "Everyone in the service area can opt in."},
        a1,
        {"id": "A2", "name": "Outage confirmed", "met": None, "why": "Sent if damage is confirmed on your line."},
        {"id": "A3", "name": "Estimate updated", "met": None, "why": "Sent if the estimate moves by more than 2 hours."},
        {"id": "A4", "name": "Restored", "met": None, "why": "Sent when the last repair on your line is done."},
    ]
    low_conf = [] if conf != "Low" else [{"id": "E2", "name": "Low confidence", "why": "We can't estimate your location reliably.",
                                          "actions": ["Message says we'll update you as crews assess damage", "Route to human review"]}]
    medical_esc = []
    if high or (p90 is not None and p90 > 4):
        why = (f"Declared medical equipment and risk {band}." if high
               else f"Declared medical equipment and the outage could last over 4 hours (up to {p90:.0f} h).")
        medical_esc = [{"id": "E1", "name": "Medical escalation", "why": why,
                        "actions": ["Notice at T-48h", "Phone call option", "Flag for human follow-up"]}]
    note = "Alert rules are challenge assumptions, not AEP policy."
    return {"variants": {
        "no-needs": {"eligible": True, "rules": rules, "escalations": low_conf, "note": note},
        "medical": {"eligible": True, "rules": rules, "escalations": medical_esc + low_conf, "note": note},
    }}


# ---------------------------------------------------------------------------
# storm replay timeline: model estimates + the real Feb 2025 damage on this path
# ---------------------------------------------------------------------------

def _replay_damage(premise_id: str) -> dict[str, float]:
    """Feb 2025 damage reports that hit this home's own path (cleaned damage table)."""
    links = set(predict._path(premise_id) or [])
    d = get_store().get("damage")
    d = d[(d.event == "feb2025") & d.outage_loc.isin(links)]
    return d.groupby("damage_cat").quantity.sum().to_dict()


def timeline(premise_id: str) -> dict:
    o = _outlook(premise_id)
    if not o:
        return {"premise_id": str(premise_id), "steps": []}
    risk, rest = o["risk"], o["rest"]
    real = _replay_damage(premise_id)
    if real:
        found = {k: v for k, v in real.items() if v}
        source = "Confirmed (Feb 2025 replay)"
    else:  # this path wasn't damaged in Feb 2025: show the model's most likely damage instead
        likely = max(rest["expected_damage_on_your_path"], key=rest["expected_damage_on_your_path"].get)
        found = {likely: 1}
        source = "Simulated (model's most likely damage)"
    names = {"pole": ("broken pole", "broken poles"), "primary_wire": ("downed wire span", "downed wire spans"),
             "transformer": ("damaged transformer", "damaged transformers"), "device": ("blown fuse or recloser", "blown fuses or reclosers"),
             "secondary": ("damaged service line", "damaged service lines")}
    what = ", ".join(f"{int(v)} {names[k][v > 1]}" for k, v in found.items())
    after = predict.simulate(premise_id, known_damage=found)
    r = lambda x, lbl="Model estimate": {"p10": x["p10"], "p50": x["p50"], "p90": x["p90"], "label": lbl}
    band = risk["band"].upper()
    # three steps: before / during / after. "During" carries two messages: outage confirmed,
    # then the estimate updated after damage assessment.
    pre_storm = {"type": "pre_storm", "channel": ["sms", "push"],
                 "text": f"AEP: A strong storm may affect your area tomorrow. Your outage risk is {band}. If you lose power, "
                         f"restoration may take {rest['p10']:.0f}-{rest['p90']:.0f} hrs (estimate). Charge devices tonight. Stay away from downed lines."}
    confirmed = {"type": "outage_confirmed", "channel": ["sms", "push"],
                 "text": "AEP: We've confirmed an outage affecting your home. Crews are assessing damage and we'll update you."}
    # sent after damage assessment, so the customer hears what was found and the new range
    updated = {
        "type": "estimate_updated", "channel": ["sms"],
        "text": f"AEP: Updated estimate: power likely back in {after['p10']:.0f}-{after['p90']:.0f} hrs "
                f"(was {rest['p10']:.0f}-{rest['p90']:.0f}). Crews found {what} on your line."}
    restored = {"type": "restored", "channel": ["sms", "push"],
                "text": "AEP: Power should now be restored at your home. Still out? Reply OUT."}
    steps = [
        {"t": "T-24h", "title": "Before the storm: strong storm expected tomorrow", "phase": "pre_storm", "confirmed_event": None,
         "risk": {"probability": risk["probability"], "band": risk["band"]}, "restoration": r(rest),
         "message": pre_storm, "messages": [pre_storm]},
        {"t": "T+6h", "title": "During the storm: your power is out", "phase": "outage",
         "confirmed_event": {"text": f"Found on your line: {what}", "label": source}, "risk": None, "restoration": r(after),
         "message": confirmed, "messages": [confirmed, updated]},
        {"t": f"T+{after['p50']:.0f}h", "title": "After the storm: power restored", "phase": "restored",
         "confirmed_event": {"text": "Repairs on your line complete", "label": "Simulated"}, "risk": None, "restoration": None,
         "message": restored, "messages": [restored]},
    ]
    return {"premise_id": str(premise_id), "replay_source": source, "steps": steps}


# ---------------------------------------------------------------------------
# circuit outline: convex hull of the circuit's homes (an area, never points)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=128)
def circuit_outline(circuit_id: str) -> dict:
    p = get_store().get("premise")
    pts = sorted(set(map(tuple, p.loc[p.circuit_id == circuit_id, ["lon", "lat"]].round(5).dropna().values)))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    hull = []
    for seq in (pts, pts[::-1]):  # Andrew's monotone chain
        half = []
        for q in seq:
            while len(half) >= 2 and cross(half[-2], half[-1], q) <= 0:
                half.pop()
            half.append(q)
        hull += half[:-1]
    ring = [list(q) for q in hull] + [list(hull[0])] if hull else []
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"circuit_id": circuit_id, "customers": int((p.circuit_id == circuit_id).sum())},
        "geometry": {"type": "Polygon", "coordinates": [ring]}}]}
