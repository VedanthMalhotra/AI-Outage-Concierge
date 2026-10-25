"""Model A per-link risk, served from a precomputed lookup.

The ml project (../ml, package ``aepml``) trains Model A and exports a compact
lookup to ``backend/_models/link_risk.json`` (see aepml/train.py
``export_link_risk_lookup``). This module just reads that file and joins it onto
a premise's chain, so the backend needs neither scikit-learn nor the feature
pipeline.

Lookup shape::

    {
      "event": "feb2025",
      "severities": [0.5, 1.0, 1.5, 2.0],
      "links": {
        "<link_loc>": {
          "device_type": "...", "link_kind": "...", "reason": "...",
          "p_damage": {"0.5": .., "1.0": .., ...},
          "band":     {"0.5": "Low", ...}
        }
      }
    }

If the file is missing (model not trained yet) every lookup returns None and the
power path simply carries no risk, which the frontend renders in neutral grey.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Optional

log = logging.getLogger("aep.risk")

# backend/app/risk_model.py -> backend/ -> _models/link_risk.json
_DEFAULT_PATH = Path(__file__).resolve().parents[1] / "_models" / "link_risk.json"

_BAND_ORDER = ["Low", "Moderate", "High", "Very High"]


def _severity_key(severity: float, available: list[str]) -> str:
    """Nearest available severity key (the lookup stores a fixed set of stops)."""
    try:
        target = float(severity)
    except (TypeError, ValueError):
        target = 1.0
    best = min(available, key=lambda k: abs(float(k) - target))
    return best


def _band_for(p: float) -> str:
    if p < 0.15:
        return "Low"
    if p < 0.40:
        return "Moderate"
    if p < 0.70:
        return "High"
    return "Very High"


class LinkRiskLookup:
    """Thread-safe, lazily loaded per-link risk lookup."""

    def __init__(self, path: Path = _DEFAULT_PATH):
        self._path = path
        self._data: Optional[dict] = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return self._load() is not None

    def _load(self) -> Optional[dict]:
        if self._data is None:
            with self._lock:
                if self._data is None:
                    if not self._path.exists():
                        log.warning("link-risk lookup not found at %s; power path "
                                    "will have no risk. Run `python -m aepml.train`.",
                                    self._path)
                        self._data = {}  # sentinel: loaded, but empty
                    else:
                        self._data = json.loads(self._path.read_text())
                        log.info("loaded link-risk lookup: %d links (event=%s)",
                                 len(self._data.get("links", {})),
                                 self._data.get("event"))
        return self._data or None

    def severities(self) -> list[str]:
        data = self._load()
        if not data:
            return ["1.0"]
        return [str(s) for s in data.get("severities", [1.0])]

    def link_risk(self, link_loc: Optional[str], severity: float = 1.0) -> Optional[dict]:
        """Return {p_damage, band, reason} for a link, or None if not covered.

        Served by the all-circuit link models in predict.py (110 circuits). The JSON
        lookup above came from a one-circuit sample (CIR72, 270 links) and is only
        used if the models can't load."""
        try:
            from . import predict
            return predict.link_detail(link_loc, severity)
        except Exception as exc:  # noqa: BLE001 - fall back to the JSON lookup
            log.warning("predict.link_detail failed (%s); using %s", exc, self._path)
        data = self._load()
        if not data or link_loc is None:
            return None
        entry = data.get("links", {}).get(str(link_loc))
        if not entry:
            return None
        sk = _severity_key(severity, list(entry["p_damage"].keys()))
        p = entry["p_damage"].get(sk)
        if p is None:
            return None
        band = entry.get("band", {}).get(sk) or _band_for(float(p))
        return {"p_damage": float(p), "band": band, "reason": entry.get("reason")}


# module-level singleton
_lookup: Optional[LinkRiskLookup] = None
_lookup_lock = threading.Lock()


def get_lookup() -> LinkRiskLookup:
    global _lookup
    if _lookup is None:
        with _lookup_lock:
            if _lookup is None:
                _lookup = LinkRiskLookup()
    return _lookup


def home_probability(p_damages: list[float]) -> Optional[float]:
    """A->home combination: P(out) = 1 - prod(1 - p_link) over scored links."""
    ps = [p for p in p_damages if p is not None]
    if not ps:
        return None
    prod = 1.0
    for p in ps:
        prod *= (1.0 - p)
    return round(1.0 - prod, 4)
