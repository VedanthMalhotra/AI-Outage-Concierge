"""S3 (or local) I/O for the cleaned tables and feature outputs.

Environment-neutral: runs the same here or in SageMaker JupyterLab. Reads the
cleaned parquet tables from s3://<bucket>/<prefix>/batchN/ and writes feature
frames to s3://<bucket>/<prefix>/features/. Set AEP_LOCAL_DATA_DIR to read/write
a local directory instead (nothing is cached to disk otherwise).

AWS auth: uses AWS_PROFILE if set (default "default" for local SSO), else the
ambient credentials / execution role (SageMaker).
"""
from __future__ import annotations

import io
import os
from typing import Optional

import boto3
import pandas as pd

BUCKET = os.environ.get("AEP_S3_BUCKET", "sagemaker-aep-outage-indiansassemble")
PREFIX = os.environ.get("AEP_S3_PREFIX", "processed")
LOCAL_DIR = os.environ.get("AEP_LOCAL_DATA_DIR")  # optional override
PROFILE = os.environ.get("AWS_PROFILE", "default")
REGION = os.environ.get("AWS_REGION", "us-east-2")

# logical table -> relative path under the prefix
TABLES = {
    "premise": "batch1/premise.parquet",
    "chain": "batch1/chain.parquet",
    "transformer": "batch1/transformer.parquet",
    "device": "batch1/device.parquet",
    "zone": "batch1/zone.parquet",
    "damage": "batch2/damage.parquet",
    "outage_labels": "batch2/outage_labels.parquet",
    "zone_damage_counts": "batch2/zone_damage_counts.parquet",
    "access_labels": "batch2/access_labels.parquet",
    "pole": "batch3/pole.parquet",
    "line": "batch3/line.parquet",
    "facility": "batch4/facility.parquet",
    "labor_unit": "batch4/labor_unit.parquet",
    "labor_adder": "batch4/labor_adder.parquet",
    "repair_bundle": "batch4/repair_bundle.parquet",
}

_session: Optional[boto3.session.Session] = None


def _boto() -> boto3.session.Session:
    global _session
    if _session is None:
        _session = boto3.session.Session(
            profile_name=PROFILE or None, region_name=REGION
        )
    return _session


def _using_local() -> bool:
    return bool(LOCAL_DIR)


def read_table(name: str) -> pd.DataFrame:
    rel = TABLES[name]
    if _using_local():
        return pd.read_parquet(os.path.join(LOCAL_DIR, rel))
    s3 = _boto().client("s3")
    obj = s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}/{rel}")
    return pd.read_parquet(io.BytesIO(obj["Body"].read()))


def read_all() -> dict[str, pd.DataFrame]:
    return {name: read_table(name) for name in TABLES}


def write_feature(df: pd.DataFrame, name: str) -> str:
    """Write a feature frame to <prefix>/features/<name>.parquet. Returns its URI."""
    rel = f"features/{name}.parquet"
    if _using_local():
        path = os.path.join(LOCAL_DIR, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        df.to_parquet(path, index=False)
        return f"local:{path}"
    buf = io.BytesIO()
    df.to_parquet(buf, index=False)
    buf.seek(0)
    s3 = _boto().client("s3")
    key = f"{PREFIX}/{rel}"
    s3.put_object(Bucket=BUCKET, Key=key, Body=buf.getvalue())
    return f"s3://{BUCKET}/{key}"


def source_label() -> str:
    return f"local:{LOCAL_DIR}" if _using_local() else f"s3://{BUCKET}/{PREFIX}"
