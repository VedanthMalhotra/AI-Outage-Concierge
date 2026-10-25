"""Chat endpoint: Amazon Nova (Bedrock Converse API) answering from our own tools.

Privacy model
-------------
* Each browser session gets a random, unguessable session id (token_urlsafe).
  An unknown or expired id just starts a new empty session, so one user can
  never read another user's conversation.
* A session is bound to the premise the user selected on the dashboard. Tools
  take NO premise argument from the model: they always use the session's own
  premise, so the model can't be talked into looking up someone else's home.
* Conversations live only in this process's memory, expire after inactivity
  and are wiped by DELETE /chat/{session_id} (the dashboard's "Clear my data").
  Nothing is written to disk or logged.

Numbers the model states must come from tool results. Risk, restoration,
guidance and alerts still come from the sample model output in ../mock/api
until the trained models are wired in; network and history facts come from
the cleaned S3 tables.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import topology as topo
from .config import get_settings
from .data import get_store

log = logging.getLogger("aep.chat")
router = APIRouter(tags=["chat"])
settings = get_settings()

MOCK_DIR = Path(__file__).resolve().parents[2] / "mock" / "api"
MAX_TOOL_ROUNDS = 4
MAX_SESSIONS = 500

SYSTEM_PROMPT = """You are the AEP Outage Concierge, a friendly assistant for residential \
Appalachian Power customers in the Roanoke Valley preparing for or living through a storm outage.

Grounding (most important):
- Only say what the tool results in this conversation say, plus what the user told you. \
Do not add facts, advice, services, promises or steps from your own knowledge.
- Never promise anything the tool results do not state: no crew priority, no visits, no phone \
numbers, no websites, no account or profile changes, no timelines. Describe alerts, escalations, \
guidance and estimates using only the wording the tools give.
- Never mention websites, apps, phone numbers, offices, customer service, how crews work or \
decide priorities, or any other AEP process, unless a tool result states it.
- If the tools do not provide the answer, reply exactly: "I don't have that information. I can \
help with your outage risk, restoration time, how to prepare, and alerts." Add nothing else.
- Only state numbers (risk, hours, counts) that appear in a tool result. Never estimate them yourself.

Emergencies:
- If the user describes any emergency or danger to anyone (health problem, injury, fire, smoke, \
gas, a downed or fallen line, pole or tree, being trapped or under something, a crash, or \
anything urgent), reply only: "This sounds like an emergency. Please call 911 now." \
Add nothing else, do not ask for their location, do not call tools.

Style:
- Plain, warm language at about an 8th-grade reading level. Keep answers short: 2 to 4 \
sentences, or a short bulleted list for checklists.
- No headings, no tables, no markdown symbols except **bold** for one or two key numbers.
- Label estimates, for example "This is a model estimate, not a confirmed outage."

Tools and memory:
- Use the tools whenever the user asks about their risk, restoration time, preparation, alerts, \
their area or their power line. Call a tool again with new inputs for "what if" questions.
- Remember what this user told you earlier in this conversation (for example that they use \
medical equipment) and use it. Repeating the user's OWN information back to them when they ask \
is fine.
- Never reveal or discuss OTHER customers, street addresses, life-support information about \
anyone else, crew details or exact locations of sensitive facilities. Politely decline instead.
- If the tools report that no location is selected, say exactly: "Please enter your premise ID, \
or you can also select your area on the map." You cannot select a location yourself.
- Stay on storm and power-outage topics. For anything else, briefly say what you can help with.
- Do not output your reasoning, only the answer for the customer."""

EMERGENCY_RE = re.compile(
    r"\b(emergency|911|chest pains?|can'?t breathe|cannot breathe|not breathing|trouble breathing|"
    r"choking|unconscious|passed out|fainted|heart attack|stroke|seizure|overdose|allergic reaction|"
    r"bleeding|hurt|injured|injury|dying|suicid\w*|"
    r"oxygen (machine |tank |concentrator )?(stopped|failed|ran out|is out|not working)|"
    r"downed (power )?lines?|power lines? (is |are )?down|lines? down|sparking|electrocut\w*|shocked|"
    r"fire|smoke|carbon monoxide|smell gas|gas leak|trapped|stuck|pinned|crushed|"
    r"under (a |the )?(pole|tree|car|wire|line)|"
    r"(pole|tree|wire|line|branch)s? (fell|fallen|falling|landed|came down|crashed|is down|are down)|"
    r"fell on (me|my|him|her|them|us|someone)|on (top of )?my (car|house|roof)|"
    r"(car|vehicle) (accident|crash)|crash(ed)? into|flood(ing|ed)?)\b",
    re.I,
)
# the model is told to answer emergencies with exactly this sentence; used to tag its replies too
EMERGENCY_MARK = "please call 911"
EMERGENCY_REPLY = "This sounds like an emergency. Please call 911 now."
THINKING_RE = re.compile(r"<thinking>.*?</thinking>", re.S | re.I)


# ---------------------------------------------------------------------------
# sessions (in memory only)
# ---------------------------------------------------------------------------

@dataclass
class Session:
    premise_id: Optional[str] = None
    messages: list[dict] = field(default_factory=list)
    last_seen: float = field(default_factory=time.time)


_sessions: dict[str, Session] = {}
_lock = threading.Lock()


def _prune(now: float) -> None:
    ttl = settings.aep_chat_session_ttl_min * 60
    for sid in [s for s, v in _sessions.items() if now - v.last_seen > ttl]:
        del _sessions[sid]
    while len(_sessions) > MAX_SESSIONS:  # drop the oldest if memory cap is hit
        del _sessions[min(_sessions, key=lambda s: _sessions[s].last_seen)]


def _get_session(session_id: Optional[str]) -> tuple[str, Session]:
    now = time.time()
    with _lock:
        _prune(now)
        if session_id and session_id in _sessions:
            s = _sessions[session_id]
        else:
            session_id = secrets.token_urlsafe(24)
            s = _sessions[session_id] = Session()
        s.last_seen = now
        return session_id, s


def _trim(messages: list[dict]) -> list[dict]:
    """Keep the most recent messages, starting on a plain user turn (never on a tool result)."""
    msgs = messages[-settings.aep_chat_max_messages:]
    while msgs and not (msgs[0]["role"] == "user" and "text" in msgs[0]["content"][0]):
        msgs = msgs[1:]
    return msgs


# ---------------------------------------------------------------------------
# tools (read-only; always scoped to the session's own premise)
# ---------------------------------------------------------------------------

def _mock(name: str) -> dict:
    return json.loads((MOCK_DIR / name).read_text(encoding="utf-8"))


def _nearest(value: float, options: list[float]) -> float:
    return min(options, key=lambda o: abs(o - value))


def _tool_area(s: Session, _: dict) -> dict:
    p = topo.find_premise(get_store(), s.premise_id)
    hist = topo.outage_history(get_store(), s.premise_id) or {}
    return {
        "circuit_id": p.get("circuit_id"), "town": p.get("city"),
        "service_type": p.get("service_type"), "has_equipment_chain": p.get("has_chain"),
        "data_coverage": topo.data_coverage(p),
        "lost_power_in_feb2025_storm": hist.get("out_feb2025"),
        "lost_power_in_sep2024_storm": hist.get("out_sep2024"),
        "source": "cleaned AEP data",
    }


def _tool_power_path(s: Session, _: dict) -> dict:
    pp = topo.power_path(get_store(), s.premise_id)
    if not pp:
        return {"error": "No equipment chain is recorded for this location."}
    links = pp.get("links") or pp.get("path") or []
    return {
        "equipment_from_home_to_substation": [l.get("device_type") for l in links],
        "protective_devices": sum(1 for l in links if str(l.get("device_type", "")).startswith(("Fuse", "Recloser"))),
        "source": "cleaned AEP data",
    }


def _tool_circuit_history(s: Session, _: dict) -> dict:
    p = topo.find_premise(get_store(), s.premise_id)
    summ = topo.circuit_summary(get_store(), p["circuit_id"])
    return {k: summ[k] for k in ("circuit_id", "premises", "damage_feb2025", "damage_sep2024", "damage_other")} | {
        "source": "cleaned AEP data (damage report counts)"}


def _tool_risk(s: Session, args: dict) -> dict:
    sev = _nearest(float(args.get("storm_severity", 1.0)), [0.5, 1.0, 1.5, 2.0])
    r = _mock("risk_by_severity.json")[f"{sev:.1f}"]
    return {
        "storm_severity": sev, "risk_band": r["band"], "probability": r["probability"],
        "confidence": r["confidence"], "top_reasons": [f["detail"] for f in r["top_factors"]],
        "label": "Model estimate", "source": "sample model output",
    }


def _tool_restoration(s: Session, args: dict) -> dict:
    want = {
        "crews": max(1, min(10, int(args.get("crews", 2)))),
        "storm_severity": _nearest(float(args.get("storm_severity", 1.0)), [0.5, 1.0, 1.5, 2.0]),
        "access": args.get("access", "auto") if args.get("access") in ("auto", "on", "off") else "auto",
        "switching_available": bool(args.get("switching_available", True)),
        "failed_upstream_device": None,
        "prioritize_critical": bool(args.get("prioritize_critical", True)),
    }
    row = next(r for r in _mock("restoration_grid.json")["results"]
               if all(r[k] == v for k, v in want.items()))
    return want | {"likely_range_hours": [row["p10"], row["p90"]], "most_likely_hours": row["p50"],
                   "label": "Model estimate", "source": "sample model output"}


def _tool_guidance(s: Session, args: dict) -> dict:
    key = "high_4-24h_medical" if args.get("medical_equipment") else "high_4-24h_no-needs"
    g = _mock("guidance.json")["variants"][key]
    return {"safety": [x["text"] for x in g["safety"]], "checklist": g["checklist"],
            "escalation": g.get("escalation"), "label": "Your action"}


def _tool_alerts(s: Session, args: dict) -> dict:
    a = _mock("alerts.json")["variants"]["medical" if args.get("medical_equipment") else "no-needs"]
    return {"eligible": a["eligible"],
            "rules": [{"name": r["name"], "applies": r["met"], "why": r["why"]} for r in a["rules"]],
            "escalations": a["escalations"], "note": "Alert rules are challenge assumptions, not AEP policy."}


TOOLS: dict[str, tuple[Any, str, dict]] = {
    "get_my_area": (_tool_area, "The customer's circuit, town, service type (overhead/underground) and whether they lost power in past storms.", {}),
    "get_power_path": (_tool_power_path, "The equipment feeding the customer's home, from their transformer up to the substation.", {}),
    "get_circuit_damage_history": (_tool_circuit_history, "How many damage reports the customer's circuit had in past storms.", {}),
    "get_outage_risk": (_tool_risk, "The customer's outage risk band, probability, confidence and top reasons for a storm severity.", {
        "storm_severity": {"type": "number", "description": "0.5 minor, 1.0 like Feb 2025 (default), 1.5 severe, 2.0 extreme"}}),
    "estimate_restoration": (_tool_restoration, "Likely restoration time range in hours for a scenario. Use for 'how long' and 'what if' questions.", {
        "crews": {"type": "integer", "description": "crews on the circuit, 1-10 (default 2)"},
        "storm_severity": {"type": "number", "description": "0.5, 1.0 (default), 1.5 or 2.0"},
        "access": {"type": "string", "enum": ["auto", "on", "off"], "description": "road access problems: auto (model), on, off"},
        "switching_available": {"type": "boolean"},
        "prioritize_critical": {"type": "boolean"}}),
    "get_preparation_guidance": (_tool_guidance, "Safety messages and a preparation checklist.", {
        "medical_equipment": {"type": "boolean", "description": "true only if the customer said they use medical equipment"}}),
    "check_alerts": (_tool_alerts, "Whether the customer qualifies for outage alerts, which ones, and escalations.", {
        "medical_equipment": {"type": "boolean", "description": "true only if the customer said they use medical equipment"}}),
}
TOOL_CONFIG = {"tools": [
    {"toolSpec": {"name": n, "description": d,
                  "inputSchema": {"json": {"type": "object", "properties": props}}}}
    for n, (_, d, props) in TOOLS.items()
]}


def _run_tool(s: Session, name: str, args: dict) -> dict:
    if not s.premise_id:
        return {"error": "No location selected. Tell the user: Please enter your premise ID, or you can also select your area on the map."}
    fn = TOOLS.get(name, (None,))[0]
    if fn is None:
        return {"error": f"unknown tool {name}"}
    try:
        return fn(s, args or {})
    except Exception as exc:  # tool failures go back to the model, not to the user
        log.warning("tool %s failed: %s", name, exc)
        return {"error": "This information isn't available right now."}


# ---------------------------------------------------------------------------
# endpoint
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    session_id: Optional[str] = Field(default=None, max_length=64)
    premise_id: Optional[str] = Field(default=None, max_length=20)


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    tools_used: list[str] = []
    emergency: bool = False
    model: Optional[str] = None


_bedrock = None


def _client():
    global _bedrock
    if _bedrock is None:
        _bedrock = get_store()._boto_session().client("bedrock-runtime", region_name=settings.aws_region)
    return _bedrock


@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    session_id, s = _get_session(req.session_id)
    text = req.message.strip()

    # bind the session to the dashboard's selected premise; a new home starts a fresh conversation
    if req.premise_id and req.premise_id != s.premise_id:
        try:
            found = topo.find_premise(get_store(), req.premise_id)
        except Exception as exc:  # e.g. expired AWS login while loading data from S3
            log.error("premise lookup failed: %s", exc)
            raise HTTPException(status_code=503, detail="Customer data is unavailable right now.") from exc
        if found:
            s.premise_id, s.messages = req.premise_id, []

    if EMERGENCY_RE.search(text):
        return ChatResponse(session_id=session_id, reply=EMERGENCY_REPLY, emergency=True)

    msgs = _trim(s.messages + [{"role": "user", "content": [{"text": text}]}])
    tools_used: list[str] = []
    try:
        for _ in range(MAX_TOOL_ROUNDS + 1):
            resp = _client().converse(
                modelId=settings.aep_chat_model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=msgs,
                toolConfig=TOOL_CONFIG,
                inferenceConfig={"maxTokens": 600, "temperature": 0},
            )
            out = resp["output"]["message"]
            msgs.append(out)
            if resp.get("stopReason") != "tool_use":
                break
            results = []
            for block in out["content"]:
                if "toolUse" in block:
                    tu = block["toolUse"]
                    tools_used.append(tu["name"])
                    results.append({"toolResult": {"toolUseId": tu["toolUseId"],
                                                   "content": [{"json": _run_tool(s, tu["name"], tu.get("input"))}]}})
            msgs.append({"role": "user", "content": results})
    except Exception as exc:
        log.error("chat model call failed: %s", exc)
        raise HTTPException(status_code=502, detail="The assistant is unavailable right now.") from exc

    reply = " ".join(b["text"] for b in msgs[-1]["content"] if "text" in b)
    reply = THINKING_RE.sub("", reply).strip() or "Sorry, I couldn't put together an answer. Could you rephrase?"
    with _lock:
        s.messages = msgs
    # emergencies the keyword check missed but the model caught: same reply, same red style
    if EMERGENCY_MARK in reply.lower():
        return ChatResponse(session_id=session_id, reply=EMERGENCY_REPLY, emergency=True,
                            model=settings.aep_chat_model_id)
    return ChatResponse(session_id=session_id, reply=reply, tools_used=sorted(set(tools_used)),
                        model=settings.aep_chat_model_id)


@router.delete("/chat/{session_id}", status_code=204)
def end_chat(session_id: str):
    with _lock:
        _sessions.pop(session_id, None)
