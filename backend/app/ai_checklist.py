"""Personalised before / during / after checklist written by the chatbot's model (Amazon Nova on
Bedrock) from one home's model outputs: risk band and reasons, the restoration range for the
current scenario, line type, declared medical equipment and critical-facility status.

The model only rewrites and prioritises from these facts (no new numbers, services or
contacts). Any failure (model down, bad JSON) returns None and the dashboard keeps its
rule-based checklist.
"""
from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from typing import Optional

from . import predict, predictions
from . import topology as topo
from .chat import _client
from .config import get_settings
from .data import get_store

log = logging.getLogger("aep.ai_checklist")

PROMPT = """You write a short storm checklist for ONE home, using only the FACTS below.
Return JSON only, no other text:
{"before": [{"text": "...", "why": "..."}], "during": [...], "after": [...]}
Rules:
- before: 5 to 6 items. during: 4 to 5 items. after: 4 items.
- "text": one action, plain words, at most 14 words, starts with a verb.
- "why": at most 12 words, tied to a fact about THIS home (its chance of losing power, how long
  it could last, its line type, its reasons, medical equipment, critical facility). Use only numbers
  that appear in the FACTS, rounded (e.g. "about 24 hours", "about 80%").
- Put the most important items for this home first. Use BOTH risk band and restoration time:
  low risk + short outage gets a light plan; high/very-high risk or a long upper estimate gets
  extra precautions. Fewer crews means a longer queue, so call that out when it affects the plan.
  Size water, food and backup-power items to the upper estimate, not a guess.
- Always include electrical safety: stay 30 feet from downed lines (during), generators outdoors only
  (during), plug appliances back in one at a time (after).
- If medical_equipment is true, put the medical device battery and backup plan first in "before" and
  a "switch to battery, leave early if it won't last" step in "during".
- appliances_at_home lists what THIS household has, how long each keeps working without power and
  the chance the outage outlasts it. Give each appliance that is likely or might run out a concrete
  step (e.g. sump pump: move valuables off the basement floor; well pump: fill jugs and the bathtub;
  fridge: cooler with ice for milk, meat and medicines; freezer: keep it shut; phone: power bank;
  home heat: plan a warm place). Skip appliances the household doesn't have.
- Every "why" must explain why THAT step helps (cause and effect), not just repeat a random fact.
  Bad: "Fill bathtub" / "Line is overhead". Good: "Fill jugs and the bathtub" / "Well pump stops, so no
  running water for about 24 hours".
- City water keeps flowing in a power outage. Only suggest filling the bathtub or storing extra water
  for flushing/washing when a well water pump is in appliances_at_home. Drinking water for the outage
  length is fine for anyone.
- No phone numbers, websites, apps, AEP processes or promises. No markdown."""

# what each appliance keeps working for without power (hours); food times are USDA guidance
APPLIANCE_HOURS = {"fridge": ("fridge", 4), "freezer": ("freezer (full)", 48), "heat": ("home heat", 23),
                   "phone": ("phone battery", 12), "medical": ("medical device battery", 8),
                   "sump": ("sump pump (no battery backup)", 0), "well": ("well water pump", 0)}


def _facts(premise_id: str, severity: float, crews: int, medical: bool,
           appliances: tuple[str, ...] = (), access: str = "auto",
           switching_available: bool = True, prioritize_critical: bool = True,
           failed_upstream_device: str | None = None) -> Optional[dict]:
    risk = predictions.predict_risk(premise_id, severity)
    if "error" in risk:
        return None
    sim = predict.simulate(premise_id, crews=crews, storm_severity=severity,
                           access=access, switching_available=switching_available,
                           prioritize_critical=prioritize_critical,
                           failed_upstream_device=failed_upstream_device)
    p = topo.find_premise(get_store(), premise_id) or {}
    fac = predict.critical_facility(premise_id)
    runs = sim.get("runs") or []
    at_home = []
    for key in appliances:
        if key in APPLIANCE_HOURS:
            name, hrs = APPLIANCE_HOURS[key]
            longer = 1.0 if hrs <= 0 else (sum(r > hrs for r in runs) / len(runs) if runs else 0.0)
            at_home.append({"appliance": name, "keeps_working_hours": hrs,
                            "chance_outage_lasts_longer": f"about {round(longer * 100)}%"})
    return {
        "chance_of_losing_power": f"about {round(risk['probability'] * 100)}% ({risk['risk_band']})",
        "reasons": risk.get("reasons_in_plain_words", []),
        "risk_band": risk["risk_band"],
        "risk_probability": round(risk["probability"], 3),
        "if_power_goes_out_it_could_last": f"most likely about {round(sim['p50'])} hours, "
                                           f"could be {round(sim['p10'])} to {round(sim['p90'])} hours",
        "line_to_the_house": p.get("service_type") or "unknown",
        "medical_equipment": medical,
        "critical_facility": fac["label"] if fac else None,
        "storm": f"{severity}x the February 2025 storm",
        "crews_on_the_circuit": crews,
        "road_access": access,
        "switching_available": switching_available,
        "critical_facilities_first": prioritize_critical,
        "appliances_at_home": at_home or "not given",
    }


def _clean(items, n_max: int) -> list[dict]:
    out = []
    for it in items if isinstance(items, list) else []:
        if isinstance(it, dict) and str(it.get("text", "")).strip():
            text, why = str(it["text"]).strip()[:140], str(it.get("why", "")).strip()[:120]
            out.append({"text": text[:1].upper() + text[1:], "why": why[:1].upper() + why[1:]})
    return out[:n_max]


@lru_cache(maxsize=256)
def checklist(premise_id: str, severity: float = 1.0, crews: int = 2, medical: bool = False,
              appliances: tuple[str, ...] = (), access: str = "auto",
              switching_available: bool = True, prioritize_critical: bool = True,
              failed_upstream_device: str | None = None) -> Optional[dict]:
    """{"before": [...], "during": [...], "after": [...], "source": ...} or None.
    appliances: sorted tuple of keys (fridge, freezer, heat, phone, medical, sump, well)."""
    facts = _facts(premise_id, severity, crews, medical, appliances, access,
                   switching_available, prioritize_critical, failed_upstream_device)
    if facts is None:
        return None
    try:
        resp = _client().converse(
            modelId=get_settings().aep_chat_model_id,
            system=[{"text": PROMPT}],
            messages=[{"role": "user", "content": [{"text": "FACTS:\n" + json.dumps(facts)}]}],
            inferenceConfig={"maxTokens": 900, "temperature": 0},
        )
        text = " ".join(b.get("text", "") for b in resp["output"]["message"]["content"])
        data = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        result = {"before": _clean(data.get("before"), 6), "during": _clean(data.get("during"), 5),
                  "after": _clean(data.get("after"), 5)}
        # the model sometimes adds steps for appliances the household doesn't have: drop them
        # (bathtub water is only needed with a well pump; basement steps only with a sump pump)
        drop = ([] if "well" in appliances else [r"bath ?tub", r"well"]) + \
               ([] if "sump" in appliances else [r"basement", r"sump"])
        if drop:
            pat = re.compile("|".join(drop), re.I)
            result = {ph: [it for it in items if not pat.search(it["text"])] for ph, items in result.items()}
        if not all(result.values()):
            return None
        src = "Written by our AI from this home's risk factors" + (" and your appliances" if appliances else "")
        return result | {"source": src + " (model estimates)"}
    except Exception as exc:  # model down / bad JSON: the dashboard keeps its rule-based list
        log.warning("AI checklist failed for this premise: %s", exc)
        return None
