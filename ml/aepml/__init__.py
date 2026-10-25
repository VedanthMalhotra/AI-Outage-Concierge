"""aepml: Power Path outage-risk models for the AEP Outage Concierge.

The "powerlines idea" (docs/02-plan/model-targets.md, Model A): outage risk lives
on the *links* of the power path, not at the house. We model the probability
that each network link (a zone fuse/recloser area, or a transformer) is damaged
in a storm, then combine the links on a home's chain into a per-home outage
probability:

    P(out) = 1 - prod(1 - p_link)   over the links on the home's chain.

Public surface:
    load_tables      - read the cleaned tables (sample CSVs or processed parquet)
    build_link_frame - one row per (link, event): features + damage label
    ModelA           - fit/predict per-link damage probability (logistic reg.)
    home_risk        - A-to-home derivation with band, confidence, top factors
"""

from .io import load_tables, Tables
from .features import build_link_frame, build_home_links
from .model_a import ModelA, EVENTS
from .risk import home_risk, band_for, RiskResult

__all__ = [
    "load_tables",
    "Tables",
    "build_link_frame",
    "build_home_links",
    "ModelA",
    "EVENTS",
    "home_risk",
    "band_for",
    "RiskResult",
]
