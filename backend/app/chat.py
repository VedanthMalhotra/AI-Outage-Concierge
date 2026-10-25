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

Numbers the model states must come from tool results. Risk and restoration come
from the trained models (predictions.py -> predict.py), guidance and alerts from
rules on that output (concierge.py), and network, history and explanation facts
from the cleaned and feature tables (profile.py). No sample data is used.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import concierge
from . import predictions
from . import topology as topo
from .config import get_settings
from .data import get_store
from .profile import customer_profile

log = logging.getLogger("aep.chat")
router = APIRouter(tags=["chat"])
settings = get_settings()

MAX_TOOL_ROUNDS = 4
MAX_SESSIONS = 500

SYSTEM_PROMPT = """You are the AEP Outage Concierge, a friendly assistant for residential \
Appalachian Power customers in the Roanoke Valley preparing for or living through a storm outage.

Grounding (most important):
- Only say what the CUSTOMER PROFILE and the tool results in this conversation say, plus what \
the user told you. Do not add facts, advice, services, promises or steps from your own knowledge.
- The CUSTOMER PROFILE describes this user's own home from AEP's data: their circuit, service \
type, transformer, equipment path, zone, area factors (lines, poles), and whether they lost power \
in past storms. Answer questions about their home, area, equipment or history directly from it, \
without calling a tool. Past storms are history; risk and restoration for the coming storm come \
from the tools.
- Never promise anything the tool results do not state: no crew priority, no visits, no phone \
numbers, no websites, no account or profile changes, no timelines. Describe alerts, escalations, \
guidance and estimates using only the wording the tools give.
- Never mention websites, apps, phone numbers, offices, customer service, how crews work or \
decide priorities, or any other AEP process, unless a tool result states it.
- If the tools do not provide the answer, reply exactly: "I don't have that information. I can \
help with your outage risk, restoration time, how to prepare, and alerts." Add nothing else.
- Only state numbers (risk, hours, counts) that appear in a tool result. Never estimate them yourself.

Explaining predictions:
- Explain WHY with at most two reasons: the model's own top_reasons from get_outage_risk (also in \
the profile's model_outlook). You may add one supporting fact from the CUSTOMER PROFILE, such as \
whether this home lost power in the February 2025 storm. Never say a declared need (like medical \
equipment) changes the outage risk; it changes guidance and alerts only.
- Only use reasons and facts that appear in the profile or tool results. If something is unknown, \
say so instead of guessing. The outage history is about THIS home only.
- For "why that long" questions, use only the restoration tool's own fields. The crews in an \
estimate are a what-if setting, not crews actually on the way.

Emergencies:
- If the user describes any emergency or danger to anyone (health problem, injury, fire, smoke, \
gas, a downed or fallen line, pole or tree, being trapped or under something, a crash, or \
anything urgent), reply only: "This sounds like an emergency. Please call 911 now." \
Add nothing else, do not ask for their location, do not call tools.

Style (you are texting a real customer, not an engineer):
- Answer the question in your first sentence. Then stop: 2 or 3 short sentences, about 60 words \
at most. Give only what this person needs to know or do.
- Use everyday words. Never use these words with the customer: transformer, recloser, fuse, zone, \
circuit, branch, primary, secondary, model, tool, probability, P10, P90, percentile, scenario, \
severity, simulation. Say instead: "the equipment that serves your street", "the safety switch \
that protects your line", "the power lines near you", "our estimate", "chance".
- Round numbers: "about 80%" (never 80.1%), "about 10 to 44 hours, most likely around a day".
- Do not list what-ifs, assumptions or what the estimate includes unless the customer asks. For a \
"what if" question, give only that one change compared with now.
- Preparation: one sentence on the most important step for them, then at most 5 short bullets, \
then "Want the full checklist?". Mention safety only if they ask about safety or describe danger.
- Alerts: say yes or no, then in one sentence what they will get and when.
- No headings, no tables. At most one **bold** number per answer.
- End risk and restoration answers with: "This is an estimate, not a confirmed outage."

Example answers (style only; always use the real numbers from the tools):
- "Will I lose power?" -> "There's a high chance, about 80%, that your home loses power in a storm \
like February 2025. That's mainly because a lot of equipment and homes share the line that serves \
your street. This is an estimate, not a confirmed outage."
- "How long would it take?" -> "If your power goes out, it would most likely be back in about \
**24 hours**, and could take anywhere from 10 to 44 hours. This is an estimate, not a confirmed outage."
- "What if more crews come?" -> "With 4 crews instead of 2, it would most likely be about 17 hours \
instead of 24."

Tools and memory:
- Use the tools whenever the user asks about their outage risk, restoration time, preparation or \
alerts. Call a tool again with new inputs for "what if" questions.
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

DEFAULT_SCENARIO = {"storm_severity": 1.0, "crews": 2, "access": "auto",
                    "switching_available": True, "prioritize_critical": True}


@dataclass
class Session:
    premise_id: Optional[str] = None
    profile: Optional[dict] = None
    messages: list[dict] = field(default_factory=list)
    last_seen: float = field(default_factory=time.time)
    # the dashboard's current sliders; tools default to these so chat matches the page
    scenario: dict = field(default_factory=lambda: dict(DEFAULT_SCENARIO))


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


_hits: dict[str, list[float]] = {}


def _rate_limited(ip: str, now: float) -> bool:
    """True if this visitor has sent too many messages in the last 10 minutes."""
    with _lock:
        recent = [t for t in _hits.get(ip, []) if now - t < 600]
        if len(recent) >= settings.aep_chat_rate_per_10min:
            _hits[ip] = recent
            return True
        _hits[ip] = recent + [now]
        if len(_hits) > 5000:  # forget idle visitors
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 600]:
                del _hits[k]
        return False


def _trim(messages: list[dict]) -> list[dict]:
    """Keep the most recent messages, starting on a plain user turn (never on a tool result)."""
    msgs = messages[-settings.aep_chat_max_messages:]
    while msgs and not (msgs[0]["role"] == "user" and "text" in msgs[0]["content"][0]):
        msgs = msgs[1:]
    return msgs


# ---------------------------------------------------------------------------
# tools (read-only; always scoped to the session's own premise)
# ---------------------------------------------------------------------------

def _tool_risk(s: Session, args: dict) -> dict:
    return predictions.predict_risk(s.premise_id, args.get("storm_severity", s.scenario["storm_severity"]))


def _tool_restoration(s: Session, args: dict) -> dict:
    sc = s.scenario | {k: v for k, v in args.items() if k in DEFAULT_SCENARIO}  # what-ifs override the page
    return predictions.simulate_restoration(s.premise_id, **sc)


def _scenario_text(sc: dict, changed: bool) -> str:
    road = {"auto": "decided by the model", "on": "access problems at every repair", "off": "no access problems"}[sc["access"]]
    text = ("DASHBOARD SETTINGS (what the customer has set on the page right now): "
            f"storm severity {sc['storm_severity']}x the February 2025 storm, {sc['crews']} crews on the circuit, "
            f"road access {road}, switching {'available' if sc['switching_available'] else 'not available'}, "
            f"critical facilities {'prioritized' if sc['prioritize_critical'] else 'not prioritized'}.\n"
            "Answer risk and restoration questions for these settings: the tools use them by default, so only "
            "pass a value when the customer asks about a different scenario (a what-if). The profile's "
            "model_outlook is for a 1x storm; when the storm setting is different, call get_outage_risk.")
    if changed:
        text += ("\nThe settings changed since your last answer, so numbers earlier in this conversation are out of "
                 "date. Call the tools again before giving any number, and mention the new setting.")
    return text


def _tool_guidance(s: Session, args: dict) -> dict:
    g = concierge.guidance(s.premise_id)["variants"]["medical" if args.get("medical_equipment") else "no-needs"]
    return {"safety": [x["text"] for x in g["safety"]], "checklist": g["checklist"],
            "escalation": g.get("escalation"), "risk_band": g["risk_band"],
            "expected_outage_hours": g["expected_hours"], "based_on": g["based_on"], "label": "Your action"}


def _tool_alerts(s: Session, args: dict) -> dict:
    a = concierge.alerts(s.premise_id)["variants"]["medical" if args.get("medical_equipment") else "no-needs"]
    return {"eligible": a["eligible"],
            "rules": [{"name": r["name"], "applies": r["met"], "why": r["why"]} for r in a["rules"]],
            "escalations": a["escalations"], "note": a["note"]}


TOOLS: dict[str, tuple[Any, str, dict]] = {
    "get_outage_risk": (_tool_risk, "The customer's outage risk band, probability, confidence and top reasons for a storm severity.", {
        "storm_severity": {"type": "number", "description": "0.5 minor, 1.0 like Feb 2025, 1.5 severe, 2.0 extreme. Omit to use the dashboard setting"}}),
    "estimate_restoration": (_tool_restoration, "Likely restoration time range in hours for a scenario. Use for 'how long' and 'what if' questions. Omitted inputs use the dashboard settings.", {
        "crews": {"type": "integer", "description": "crews on the circuit, 1-10. Omit to use the dashboard setting"},
        "storm_severity": {"type": "number", "description": "0.5, 1.0, 1.5 or 2.0. Omit to use the dashboard setting"},
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
    scenario: Optional["ChatScenario"] = None


class ChatScenario(BaseModel):
    """The dashboard's sliders at the moment the message was sent."""
    storm_severity: float = Field(default=1.0, ge=0.5, le=2.0)
    crews: int = Field(default=2, ge=1, le=10)
    access: Literal["auto", "on", "off"] = "auto"
    switching_available: bool = True
    prioritize_critical: bool = True


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
def chat(req: ChatRequest, request: Request):
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0]
    if _rate_limited(ip, time.time()):
        raise HTTPException(status_code=429, detail="Too many messages. Please wait a few minutes.")
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
            try:
                s.profile = customer_profile(req.premise_id)
                r = predictions.predict_risk(req.premise_id)
                if s.profile is not None and "error" not in r:
                    s.profile["model_outlook"] = {k: r[k] for k in ("risk_band", "probability", "confidence", "top_reasons")} | {
                        "storm": "like Feb 2025", "label": "Model estimate (trained outage-risk model)"}
            except Exception as exc:  # profile is context only; the chat still works without it
                log.warning("profile build failed for this session: %s", exc)
                s.profile = None

    if EMERGENCY_RE.search(text):
        return ChatResponse(session_id=session_id, reply=EMERGENCY_REPLY, emergency=True)

    scenario_changed = False
    if req.scenario:
        new = req.scenario.model_dump()
        scenario_changed = bool(s.messages) and new != s.scenario
        s.scenario = new

    msgs = _trim(s.messages + [{"role": "user", "content": [{"text": text}]}])
    system = [{"text": SYSTEM_PROMPT}]
    if s.profile:
        system.append({"text": "CUSTOMER PROFILE (this user's own home only; facts from AEP data):\n"
                               + json.dumps(s.profile, default=str)})
    else:
        system.append({"text": "CUSTOMER PROFILE: none. No location is selected yet."})
    system.append({"text": _scenario_text(s.scenario, scenario_changed)})
    tools_used: list[str] = []
    try:
        for _ in range(MAX_TOOL_ROUNDS + 1):
            resp = _client().converse(
                modelId=settings.aep_chat_model_id,
                system=system,
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
