"""Build the shared feature table and write it to S3 (or a local dir).

Usage (from ml/):
    uv run python build_features.py            # read + write S3
    uv run python build_features.py --dry-run  # build in memory, print shapes, no write

Environment:
    AWS_PROFILE          default "default" (local SSO). Unset in SageMaker to use the role.
    AEP_S3_BUCKET        default sagemaker-aep-outage-indiansassemble
    AEP_S3_PREFIX        default processed
    AEP_LOCAL_DATA_DIR   if set, read/write this local dir instead of S3
"""
from __future__ import annotations

import argparse
import json

from aepml import features, io as data_io


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="build but do not write")
    ap.add_argument("--summary-out", default=None, help="write a JSON summary to this path")
    args = ap.parse_args()

    print(f"source: {data_io.source_label()}")
    result = features.build_all(write=not args.dry_run)

    summary = {"source": data_io.source_label(), "frames": {}}
    for name, df in result.items():
        info = {
            "rows": int(len(df)),
            "cols": int(len(df.columns)),
            "columns": list(df.columns),
        }
        if "label_damaged" in df.columns:
            info["positives"] = int(df["label_damaged"].sum())
            info["positive_rate"] = round(float(df["label_damaged"].mean()), 4)
            info["by_event"] = (
                df.groupby("event")["label_damaged"].agg(["size", "sum", "mean"])
                .round(4).to_dict("index")
            )
        if "access_issue" in df.columns:
            info["positives"] = int(df["access_issue"].sum())
            info["positive_rate"] = round(float(df["access_issue"].mean()), 4)
        if name == "features_zones":
            info["total_counts"] = {
                c: int(df[c].sum()) for c in features.DAMAGE_TYPE_COLS
            }
        summary["frames"][name] = info

    print(json.dumps(summary, indent=2, default=str))
    if args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)


if __name__ == "__main__":
    main()
