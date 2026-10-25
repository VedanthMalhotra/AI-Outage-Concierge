"""Train Model A and write its artifacts.

Outputs (model-targets section 4 / MVP plan 10b):
    model.joblib        - fitted ModelA (scaler + logistic regression)
    metrics.json        - AUC / Brier, grouped CV, leave-one-event-out backtest
    features.json       - feature columns + base rate + event offsets
    coefficients.csv    - plain-language coefficient table
    power_path.json     - per-link p_damage + reason (the "Your Power Path" feed)
    risk_sample.json    - A-to-home cards for a few premises (sanity check)

Run:  python -m aepml.train            (uses data/sample)
      python -m aepml.train --base s3://.../processed --fmt parquet --out out/
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
import joblib
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.model_selection import GroupKFold

from .io import load_tables
from .features import build_link_frame, FEATURE_COLUMNS, FEATURE_LABELS, EVENTS
from .model_a import ModelA, REFERENCE_EVENT
from .risk import home_risk


def _safe_auc(y, p) -> float | None:
    y = np.asarray(y)
    if len(np.unique(y)) < 2:
        return None
    return float(roc_auc_score(y, p))


def grouped_cv(frame: pd.DataFrame, n_splits: int = 5) -> dict:
    """CV grouped by circuit_id so the model can't memorise a circuit's storm
    footprint (section 4, within-storm CV)."""
    groups = frame["circuit_id"].fillna("UNKNOWN").to_numpy()
    uniq = np.unique(groups)
    n = min(n_splits, len(uniq))
    if n < 2:
        return {"folds": 0, "note": "only one circuit in data; grouped CV skipped"}

    gkf = GroupKFold(n_splits=n)
    y_all, p_all = [], []
    idx = np.arange(len(frame))
    for tr, te in gkf.split(idx, frame["y_damaged"], groups):
        if frame.iloc[tr]["y_damaged"].nunique() < 2:
            continue
        m = ModelA.fit(frame.iloc[tr])
        # Predict each test row at its own event/severity 1.0.
        p = np.empty(len(te))
        sub = frame.iloc[te]
        for ev in EVENTS:
            mask = sub["event"].to_numpy() == ev
            if mask.any():
                p[mask] = m.predict_proba(sub[mask], event=ev, severity=1.0)
        y_all.append(sub["y_damaged"].to_numpy())
        p_all.append(p)

    if not y_all:
        return {"folds": 0, "note": "no usable folds"}
    y_all = np.concatenate(y_all)
    p_all = np.concatenate(p_all)
    return {"folds": n, "auc": _safe_auc(y_all, p_all),
            "brier": float(brier_score_loss(y_all, p_all)),
            "n": int(len(y_all))}


def leave_one_event_out(frame: pd.DataFrame) -> dict:
    """Train on all events but one, test on the held-out event (the main test,
    section 4). The headline is the Feb-2025 -> Sep-2024 transfer."""
    results = {}
    for test_ev in EVENTS:
        train = frame[frame["event"] != test_ev]
        test = frame[frame["event"] == test_ev]
        if train["y_damaged"].nunique() < 2 or len(test) == 0:
            results[test_ev] = {"auc": None, "brier": None, "n": int(len(test)),
                                "note": "insufficient data"}
            continue
        m = ModelA.fit(train)
        # Use the reference event's offset for a held-out event we never saw.
        ev_for_pred = test_ev if test_ev in m.event_offsets else REFERENCE_EVENT
        p = m.predict_proba(test, event=ev_for_pred, severity=1.0)
        results[test_ev] = {
            "auc": _safe_auc(test["y_damaged"], p),
            "brier": float(brier_score_loss(test["y_damaged"], p))
            if test["y_damaged"].nunique() >= 2 else None,
            "base_rate": float(test["y_damaged"].mean()),
            "n": int(len(test)),
        }
    return results


def baseline_overhead_only(frame: pd.DataFrame) -> dict:
    """Naive rule: rank by overhead share only. The model must beat this."""
    out = {}
    for ev in EVENTS:
        sub = frame[frame["event"] == ev]
        if sub["y_damaged"].nunique() < 2:
            out[ev] = None
            continue
        out[ev] = _safe_auc(sub["y_damaged"], sub["overhead_service_share"])
    return out


def export_power_path(model: ModelA, frame: pd.DataFrame, event: str,
                      severity: float = 1.0) -> list[dict]:
    """Per-link p_damage + a one-line reason for the 'Your Power Path' view."""
    sub = frame[frame["event"] == event].copy()
    sub["p_damage"] = model.predict_proba(sub, event=event, severity=severity)
    rows = []
    for _, r in sub.iterrows():
        reason = _top_reason(model, r)
        rows.append({
            "link_loc": r["link_loc"],
            "link_kind": r["link_kind"],
            "device_type": r.get("device_type"),
            "circuit_id": r.get("circuit_id"),
            "p_damage": round(float(r["p_damage"]), 4),
            "homes_sharing": int(round(float(r.get("customers_behind", 0)))),
            "reason": reason,
        })
    rows.sort(key=lambda d: d["p_damage"], reverse=True)
    return rows


def export_link_risk_lookup(model: ModelA, frame: pd.DataFrame,
                            event: str = REFERENCE_EVENT,
                            severities=(0.5, 1.0, 1.5, 2.0)) -> dict:
    """A compact per-link risk lookup the backend can join onto a chain without
    needing sklearn or the feature pipeline.

    Shape:
        {
          "event": "feb2025",
          "severities": [0.5, 1.0, 1.5, 2.0],
          "links": {
             "<link_loc>": {
                "device_type": "...",
                "reason": "...",             # top factor, plain language
                "p_damage": {"0.5": .., "1.0": .., "1.5": .., "2.0": ..},
                "band":     {"0.5": "...", ...}
             }, ...
          }
        }
    """
    sub = frame[frame["event"] == event].copy()
    sev_keys = [str(s) for s in severities]

    # p_damage per link per severity
    p_by_sev = {str(s): model.predict_proba(sub, event=event, severity=s) for s in severities}

    def band(p: float) -> str:
        if p < 0.15:
            return "Low"
        if p < 0.40:
            return "Moderate"
        if p < 0.70:
            return "High"
        return "Very High"

    links: dict[str, dict] = {}
    for i, (_, r) in enumerate(sub.iterrows()):
        loc = r["link_loc"]
        if pd.isna(loc):
            continue
        reason = _top_reason(model, r)
        links[str(loc)] = {
            "device_type": _clean_str(r.get("device_type")),
            "link_kind": _clean_str(r.get("link_kind")),
            "reason": reason,
            "p_damage": {sk: round(float(p_by_sev[sk][i]), 4) for sk in sev_keys},
            "band": {sk: band(float(p_by_sev[sk][i])) for sk in sev_keys},
        }

    return {"event": event, "severities": list(severities), "links": links}


def _top_reason(model: ModelA, row: pd.Series) -> str:
    """Plain-language reason = the top *risk-raising* factor actually present on
    this link. We only consider features whose raw value is non-trivial, so a
    transformer never gets a 'fuse' reason just because is_fuse=0 sits far from
    the mean. Falls back to the strongest contributor if nothing raises risk.
    """
    contrib = model.contributions(row)
    if not contrib:
        return ""
    present = {}
    for key, val in contrib.items():
        raw = row.get(key)
        try:
            raw = float(raw)
        except (TypeError, ValueError):
            continue
        # skip features that are effectively "off" for this link
        if abs(raw) < 1e-9:
            continue
        present[key] = val
    pool = present or contrib
    # prefer the strongest risk-raising factor; else the strongest overall
    raising = {k: v for k, v in pool.items() if v > 0}
    chosen = (max(raising, key=raising.get) if raising
              else max(pool, key=lambda k: abs(pool[k])))
    return FEATURE_LABELS.get(chosen, (chosen, ""))[1]


def _clean_str(v) -> str | None:
    if v is None:
        return None
    s = str(v)
    return None if s.lower() in ("nan", "none", "<na>") else s


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Train Model A (Power Path).")
    ap.add_argument("--base", default=None,
                    help="data dir or S3 URI (default: repo data/sample)")
    ap.add_argument("--fmt", default="csv", choices=["csv", "parquet"])
    ap.add_argument("--out", default=None, help="output dir (default: ml/artifacts/model_a)")
    ap.add_argument("--event", default=REFERENCE_EVENT,
                    help="event used for the power-path / risk exports")
    args = ap.parse_args(argv)

    out = Path(args.out) if args.out else Path(__file__).resolve().parents[1] / "artifacts" / "model_a"
    out.mkdir(parents=True, exist_ok=True)

    print(f"Loading tables ({args.fmt}) from {args.base or 'data/sample'} ...")
    tables = load_tables(args.base, args.fmt)
    frame = build_link_frame(tables)
    n_links = frame["link_loc"].nunique()
    print(f"Built link frame: {len(frame)} rows, {n_links} links x {len(EVENTS)} events; "
          f"damage positive rate = {frame['y_damaged'].mean():.3f}")

    # Fit the final model on all events.
    model = ModelA.fit(frame)

    metrics = {
        "n_rows": int(len(frame)),
        "n_links": int(n_links),
        "positive_rate": float(frame["y_damaged"].mean()),
        "grouped_cv_by_circuit": grouped_cv(frame),
        "leave_one_event_out": leave_one_event_out(frame),
        "baseline_overhead_only_auc": baseline_overhead_only(frame),
        "event_offsets": model.event_offsets,
    }

    joblib.dump(model, out / "model.joblib")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (out / "features.json").write_text(json.dumps({
        "feature_columns": model.feature_columns,
        "base_rate": model.base_rate,
        "event_offsets": model.event_offsets,
        "reference_event": REFERENCE_EVENT,
        "feature_labels": {k: {"label": v[0], "detail": v[1]} for k, v in FEATURE_LABELS.items()},
    }, indent=2))
    model.coefficient_table().to_csv(out / "coefficients.csv", index=False)

    (out / "power_path.json").write_text(
        json.dumps(export_power_path(model, frame, args.event), indent=2))

    # Compact per-link risk lookup for the backend (no sklearn needed there).
    link_risk = export_link_risk_lookup(model, frame, event=args.event)
    (out / "link_risk.json").write_text(json.dumps(link_risk, indent=2))
    # Also drop a copy where the backend looks for it.
    backend_models = Path(__file__).resolve().parents[2] / "backend" / "_models"
    backend_models.mkdir(parents=True, exist_ok=True)
    (backend_models / "link_risk.json").write_text(json.dumps(link_risk))
    print(f"Wrote link-risk lookup ({len(link_risk['links'])} links) to "
          f"{backend_models / 'link_risk.json'}")

    # Risk cards for a handful of premises with chains.
    sample_ids = (tables.premise[tables.premise["has_chain"] == True]["premise_id"]
                  .dropna().head(5).tolist())
    cards = [home_risk(model, tables, frame, pid, event=args.event).to_dict()
             for pid in sample_ids]
    (out / "risk_sample.json").write_text(json.dumps(cards, indent=2))

    print(f"\nWrote artifacts to {out}:")
    for f in sorted(out.iterdir()):
        print(f"  {f.name}")
    print("\nLeave-one-event-out AUC:")
    for ev, r in metrics["leave_one_event_out"].items():
        print(f"  test={ev:8s} auc={r.get('auc')}  base={r.get('base_rate')}  n={r.get('n')}")


if __name__ == "__main__":
    main()
