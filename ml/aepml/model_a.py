"""Model A: probability a network link is damaged in a storm.

An explainable logistic regression over the link features (features.py), fit
pooled over all three events with an **event intercept** so the fitted event
effects become data-driven severity presets instead of guessed multipliers
(docs/ideas/model-targets.md section 2). Features are standardised; coefficients
are reported back in standardised space with their plain-language labels so the
A-to-home card can say *why* a link is risky.

A storm-severity knob (0.5 / 1.0 / 1.5 / 2.0) scales the event log-odds shift,
letting the same model answer "a Feb-2025-like storm, but 1.5x as bad".
"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from .features import FEATURE_COLUMNS, EVENTS

# Reference event whose intercept defines severity == 1.0.
REFERENCE_EVENT = "feb2025"


@dataclass
class ModelA:
    scaler: StandardScaler
    clf: LogisticRegression
    feature_columns: list[str]
    event_offsets: dict[str, float]  # extra log-odds vs the reference event
    base_rate: float

    # ----------------------------------------------------------------- #
    @classmethod
    def fit(cls, frame: pd.DataFrame, C: float = 1.0,
            feature_columns: list[str] | None = None) -> "ModelA":
        cols = list(feature_columns or FEATURE_COLUMNS)
        X_num = frame[cols].to_numpy(float)

        # One-hot event columns (drop the reference) give the event intercepts.
        ev = pd.Categorical(frame["event"], categories=list(EVENTS))
        ev_dummies = pd.get_dummies(ev, prefix="event")
        ref_col = f"event_{REFERENCE_EVENT}"
        if ref_col in ev_dummies.columns:
            ev_dummies = ev_dummies.drop(columns=[ref_col])
        ev_cols = list(ev_dummies.columns)

        scaler = StandardScaler().fit(X_num)
        X = np.hstack([scaler.transform(X_num), ev_dummies.to_numpy(float)])
        y = frame["y_damaged"].to_numpy(int)

        # No class re-weighting: we want calibrated probabilities, because the
        # A-to-home step multiplies (1 - p_link) across the chain. Balanced
        # weights would inflate every p_link and saturate every home at ~1.
        clf = LogisticRegression(C=C, max_iter=2000, solver="lbfgs")
        clf.fit(X, y)

        # Split coefficients back into feature block and event block.
        n_feat = len(cols)
        event_offsets = {REFERENCE_EVENT: 0.0}
        for name, coef in zip(ev_cols, clf.coef_[0][n_feat:]):
            event_offsets[name.replace("event_", "")] = float(coef)
        for e in EVENTS:
            event_offsets.setdefault(e, 0.0)

        return cls(scaler=scaler, clf=clf, feature_columns=cols,
                   event_offsets=event_offsets, base_rate=float(y.mean()))

    # ----------------------------------------------------------------- #
    def _linear(self, frame: pd.DataFrame) -> np.ndarray:
        """Feature contribution to the log-odds, excluding the event term."""
        X = self.scaler.transform(frame[self.feature_columns].to_numpy(float))
        n_feat = len(self.feature_columns)
        w = self.clf.coef_[0][:n_feat]
        return X @ w + float(self.clf.intercept_[0])

    def predict_proba(self, frame: pd.DataFrame, event: str = REFERENCE_EVENT,
                      severity: float = 1.0) -> np.ndarray:
        """P(link damaged) for a given event and severity knob.

        The event's storm strength is its log-odds shift above the quietest
        observed event (the baseline). ``severity`` scales that shift: severity
        1.0 reproduces the event as observed, 0.5 halves its storm strength, 2.0
        doubles it. This means the knob also moves the reference event, so the
        0.5 / 1.0 / 1.5 / 2.0 slider is live on the default ("Feb-2025-like")
        storm, not just on the quieter ones.
        """
        baseline = min(self.event_offsets.values()) if self.event_offsets else 0.0
        storm_strength = self.event_offsets.get(event, 0.0) - baseline
        z = self._linear(frame) + baseline + severity * storm_strength
        return 1.0 / (1.0 + np.exp(-z))

    def contributions(self, row: pd.Series) -> dict[str, float]:
        """Per-feature signed log-odds contribution for one link row, used to
        build the human-readable 'top reasons'. Standardised feature value times
        its coefficient."""
        x = row[self.feature_columns].to_numpy(float).reshape(1, -1)
        xs = self.scaler.transform(x)[0]
        w = self.clf.coef_[0][: len(self.feature_columns)]
        return {c: float(xs_i * w_i) for c, xs_i, w_i in zip(self.feature_columns, xs, w)}

    def coefficient_table(self) -> pd.DataFrame:
        n = len(self.feature_columns)
        rows = [{"feature": c, "coef": float(v), "kind": "feature"}
                for c, v in zip(self.feature_columns, self.clf.coef_[0][:n])]
        rows.append({"feature": "intercept", "coef": float(self.clf.intercept_[0]),
                     "kind": "intercept"})
        for e, v in self.event_offsets.items():
            rows.append({"feature": f"event:{e}", "coef": float(v), "kind": "event"})
        return pd.DataFrame(rows).sort_values("coef", ascending=False).reset_index(drop=True)
