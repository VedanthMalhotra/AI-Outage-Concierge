"""Data access layer.

Loads the 15 cleaned parquet tables that live under
  s3://<bucket>/<prefix>/batch{1..4}/*.parquet
into pandas DataFrames, caching them in memory after first read. A local
directory can be used instead of S3 (AEP_LOCAL_DATA_DIR) for offline dev.

The rest of the app only ever talks to this module, so swapping storage
(or adding a warehouse later) touches one file.
"""
from __future__ import annotations

import io
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

import boto3
import pandas as pd

from .config import Settings, get_settings

log = logging.getLogger("aep.data")

# logical table name -> relative path under the prefix
TABLE_PATHS: dict[str, str] = {
    # batch 1 (network)
    "premise": "batch1/premise.parquet",
    "chain": "batch1/chain.parquet",
    "transformer": "batch1/transformer.parquet",
    "device": "batch1/device.parquet",
    "zone": "batch1/zone.parquet",
    # batch 2 (damage + labels)
    "damage": "batch2/damage.parquet",
    "outage_labels": "batch2/outage_labels.parquet",
    "zone_damage_counts": "batch2/zone_damage_counts.parquet",
    "access_labels": "batch2/access_labels.parquet",
    # batch 3 (assets)
    "pole": "batch3/pole.parquet",
    "line": "batch3/line.parquet",
    # batch 4 (reference)
    "facility": "batch4/facility.parquet",
    "labor_unit": "batch4/labor_unit.parquet",
    "labor_adder": "batch4/labor_adder.parquet",
    "repair_bundle": "batch4/repair_bundle.parquet",
}


@dataclass
class DataStore:
    """Lazy, thread-safe cache of the cleaned tables."""

    settings: Settings
    _cache: dict[str, pd.DataFrame] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _session: Optional[boto3.session.Session] = None

    # -- source resolution ---------------------------------------------------

    @property
    def using_local(self) -> bool:
        return bool(self.settings.aep_local_data_dir)

    def source_uri(self, table: str) -> str:
        rel = TABLE_PATHS[table]
        if self.using_local:
            base = self.settings.aep_local_data_dir.rstrip("/\\")
            return f"{base}/{rel}"
        return f"s3://{self.settings.aep_s3_bucket}/{self.settings.aep_s3_prefix}/{rel}"

    def _boto_session(self) -> boto3.session.Session:
        if self._session is None:
            self._session = boto3.session.Session(
                profile_name=self.settings.aws_profile or None,
                region_name=self.settings.aws_region,
            )
        return self._session

    # -- loading --------------------------------------------------------------

    def _read_parquet(self, table: str) -> pd.DataFrame:
        rel = TABLE_PATHS[table]
        if self.using_local:
            uri = self.source_uri(table)
            log.info("loading %s from %s", table, uri)
            return pd.read_parquet(uri)

        # S3: pull bytes with the configured boto3 session so SSO creds apply,
        # then let pandas/pyarrow parse from memory. Avoids s3fs needing its
        # own credential resolution.
        s3 = self._boto_session().client("s3")
        key = f"{self.settings.aep_s3_prefix}/{rel}"
        log.info("loading %s from s3://%s/%s", table, self.settings.aep_s3_bucket, key)
        obj = s3.get_object(Bucket=self.settings.aep_s3_bucket, Key=key)
        return pd.read_parquet(io.BytesIO(obj["Body"].read()))

    def get(self, table: str) -> pd.DataFrame:
        if table not in TABLE_PATHS:
            raise KeyError(f"unknown table '{table}'")
        if table not in self._cache:
            with self._lock:
                if table not in self._cache:
                    self._cache[table] = self._read_parquet(table)
        return self._cache[table]

    def preload(self) -> dict[str, int]:
        """Load every table; return row counts. Used at startup / health."""
        counts: dict[str, int] = {}
        for name in TABLE_PATHS:
            counts[name] = len(self.get(name))
        return counts

    def table_names(self) -> list[str]:
        return list(TABLE_PATHS)

    def is_loaded(self, table: str) -> bool:
        return table in self._cache


# Singleton, created lazily so importing the module never touches AWS.
_store: Optional[DataStore] = None
_store_lock = threading.Lock()


def get_store() -> DataStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = DataStore(settings=get_settings())
    return _store
