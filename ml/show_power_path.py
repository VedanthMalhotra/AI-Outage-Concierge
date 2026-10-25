"""Show one home's power path: the ordered links from its transformer up to the
breaker, each with its Model-A damage probability and reason.

Usage:
    python show_power_path.py                 # uses a sample premise
    python show_power_path.py 893916132       # a specific premise
    python show_power_path.py 893916132 1.5   # with a storm-severity knob
"""

import sys
import joblib
from aepml import load_tables, build_link_frame
from aepml.features import build_home_links
from aepml.model_a import ModelA
from aepml.features import FEATURE_LABELS

EVENT = "feb2025"


def main():
    tables = load_tables()
    frame = build_link_frame(tables)
    model: ModelA = joblib.load("artifacts/model_a/model.joblib")

    premise_id = sys.argv[1] if len(sys.argv) > 1 else \
        str(tables.premise[tables.premise.has_chain == True].premise_id.iloc[0])
    severity = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

    links = build_home_links(tables, frame, EVENT)
    links = links[links.premise_id == premise_id].sort_values("step").copy()
    if links.empty:
        print(f"No power path for premise {premise_id} (not linked to the network).")
        return

    links["p_damage"] = model.predict_proba(links, event=EVENT, severity=severity)

    print(f"\nPower path for home {premise_id}  (storm={EVENT}, severity={severity})")
    print("-" * 78)
    print(f"{'step':>4}  {'kind':<11} {'device':<22} {'p_damage':>8}  {'homes':>5}")
    print("-" * 78)
    for _, r in links.iterrows():
        print(f"{int(r['step']):>4}  {r['link_kind']:<11} "
              f"{str(r.get('device_type', '')):<22} {r['p_damage']:>8.3f}  "
              f"{int(round(float(r.get('customers_behind', 0)))):>5}")

    weakest = links.loc[links["p_damage"].idxmax()]
    contrib = model.contributions(weakest)
    top = max(contrib, key=lambda k: abs(contrib[k])) if contrib else None
    p_out = 1.0
    for p in links["p_damage"]:
        p_out *= (1.0 - p)
    p_out = 1.0 - p_out

    print("-" * 78)
    print(f"Weakest link: {weakest['link_loc']} ({weakest['link_kind']}, "
          f"{weakest.get('device_type')}), p={weakest['p_damage']:.3f}")
    if top:
        print(f"  why: {FEATURE_LABELS.get(top, (top, ''))[1]}")
    print(f"Whole-home outage probability  P(out) = 1 - prod(1-p_link) = {p_out:.3f}")


if __name__ == "__main__":
    main()
