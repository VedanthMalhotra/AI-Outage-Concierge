"""Loading the cleaned tables.

Two sources are supported with the same column contract (data/sample/README.md):

  * the small sample CSVs in ``data/sample`` (default; works offline), and
  * the full processed tables (parquet), e.g. under
    ``s3://sagemaker-aep-outage-indiansassemble/processed/`` or a local mirror.

The processed tables carry a few extra columns the sample does not
(``zone_id`` on transformers/poles/line, ``outage_loc``/``xf_zone`` on damage).
When those are absent we derive their equivalents so downstream code only has
to deal with one shape.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path
import numpy as np
import pandas as pd

# Repo-relative default: ml/aepml/io.py -> repo root is two parents up from ml/.
_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SAMPLE_DIR = _REPO_ROOT / "data" / "sample"

# Asset types whose damage only knocks out the single transformer behind it,
# versus everything else which knocks out the whole zone (cleaning guide D1/D3).
LOCAL_ASSET_TYPES = {"Transformer", "Step Transformer", "secondary"}
IGNORE_ASSET_TYPES = {"Light", "Capacitor Bank"}

# Map raw asset_type -> damage category used by Model B (cleaning guide D3).
ASSET_CATEGORY = {
    "pole": "pole",
    "primary": "primary_wire",
    "Transformer": "transformer",
    "Step Transformer": "transformer",
    "Fuse": "device",
    "Fuse Bank": "device",
    "Recloser Bank": "device",
    "Switch": "device",
    "secondary": "secondary",
}

_TABLE_NAMES = (
    "premise",
    "chain",
    "transformer",
    "device",
    "damage",
    "pole",
    "facility",
)


@dataclass
class Tables:
    """The cleaned tables, as pandas frames with a shared column contract."""

    premise: pd.DataFrame
    chain: pd.DataFrame
    transformer: pd.DataFrame
    device: pd.DataFrame
    damage: pd.DataFrame
    pole: pd.DataFrame
    facility: pd.DataFrame

    def copy(self) -> "Tables":
        return Tables(**{f.name: getattr(self, f.name).copy() for f in fields(self)})


def _read_table(base: str | Path, name: str, fmt: str) -> pd.DataFrame:
    if fmt == "csv":
        path = Path(base) / f"{name}.csv"
        return pd.read_csv(path, dtype={"premise_id": "string"})
    if fmt == "parquet":
        return pd.read_parquet(f"{str(base).rstrip('/')}/{name}.parquet")
    raise ValueError(f"unknown fmt {fmt!r}; use 'csv' or 'parquet'")


def _as_str(df: pd.DataFrame, cols: list[str]) -> None:
    """Force id/location columns to nullable strings so joins are exact."""
    for c in cols:
        if c in df.columns:
            df[c] = df[c].astype("string").str.strip()
            df.loc[df[c].isin(["", "nan", "None"]), c] = pd.NA


def _haversine_m(lat1, lon1, lat2, lon2) -> np.ndarray:
    """Great-circle distance in metres between arrays of points."""
    r = 6371000.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = np.radians(np.asarray(lat2) - np.asarray(lat1))
    dlmb = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlmb / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def _nearest_transformer_zone(damage: pd.DataFrame, transformer: pd.DataFrame,
                              max_dist_m: float = 300.0) -> pd.DataFrame:
    """Attach ``xf_zone``/``transformer_loc`` to each damage report by nearest
    transformer within ``max_dist_m`` (cleaning guide D2). Used only when the
    processed ``outage_loc`` column is absent (i.e. the sample data).

    ``zone_id`` here is the transformer's feeding device (``upstream_loc``),
    which is the fuse/recloser area the proposal calls a "zone".
    """
    t = transformer.dropna(subset=["lat", "lon"]).reset_index(drop=True)
    if t.empty or damage.empty:
        damage = damage.copy()
        damage["xf_zone"] = pd.NA
        damage["nearest_transformer_loc"] = pd.NA
        return damage

    t_lat = t["lat"].to_numpy(float)
    t_lon = t["lon"].to_numpy(float)
    zones = t["zone_id"].to_numpy(object) if "zone_id" in t.columns else t["upstream_loc"].to_numpy(object)
    xlocs = t["transformer_loc"].to_numpy(object)

    out_zone, out_xloc = [], []
    for lat, lon in zip(damage["lat"].to_numpy(float), damage["lon"].to_numpy(float)):
        if not np.isfinite(lat) or not np.isfinite(lon):
            out_zone.append(pd.NA)
            out_xloc.append(pd.NA)
            continue
        d = _haversine_m(lat, lon, t_lat, t_lon)
        j = int(np.argmin(d))
        if d[j] <= max_dist_m:
            out_zone.append(zones[j])
            out_xloc.append(xlocs[j])
        else:
            out_zone.append(pd.NA)
            out_xloc.append(pd.NA)

    damage = damage.copy()
    damage["xf_zone"] = pd.array(out_zone, dtype="string")
    damage["nearest_transformer_loc"] = pd.array(out_xloc, dtype="string")
    return damage


def _derive_outage_loc(damage: pd.DataFrame) -> pd.Series:
    """outage_loc = transformer_loc for local asset types, else the zone.
    None for asset types that cause no customer outage (cleaning guide D2).
    """
    is_local = damage["asset_type"].isin(LOCAL_ASSET_TYPES)
    loc = np.where(is_local,
                   damage.get("nearest_transformer_loc", pd.Series(pd.NA, index=damage.index)),
                   damage["xf_zone"])
    out = pd.Series(loc, index=damage.index, dtype="object").astype("string")
    out[damage["asset_type"].isin(IGNORE_ASSET_TYPES)] = pd.NA
    return out


def load_tables(base: str | Path | None = None, fmt: str = "csv") -> Tables:
    """Load the cleaned tables and normalise their column contract.

    Parameters
    ----------
    base : path or S3 URI. Defaults to the repo's ``data/sample`` directory.
    fmt  : ``"csv"`` (sample) or ``"parquet"`` (processed tables).
    """
    if base is None:
        base, fmt = DEFAULT_SAMPLE_DIR, "csv"

    raw = {name: _read_table(base, name, fmt) for name in _TABLE_NAMES}
    t = Tables(**raw)

    # Exact-match join keys as strings.
    _as_str(t.premise, ["premise_id", "circuit_id", "transformer_loc"])
    _as_str(t.chain, ["premise_id", "device_loc", "circuit_id"])
    _as_str(t.transformer, ["transformer_id", "transformer_loc", "circuit_id",
                            "upstream_loc", "zone_id"])
    _as_str(t.device, ["device_id", "device_loc", "circuit_id", "upstream_loc"])
    _as_str(t.damage, ["damage_id", "circuit_id", "outage_loc", "xf_zone",
                       "transformer_loc"])
    _as_str(t.pole, ["pole_id"])
    _as_str(t.facility, ["facility_id"])

    # Transformer zone: prefer processed ``zone_id``; else the feeding device.
    if "zone_id" not in t.transformer.columns:
        t.transformer["zone_id"] = t.transformer["upstream_loc"]

    # Damage -> network match. Use processed columns if present; else derive.
    if "outage_loc" not in t.damage.columns:
        t.damage = _nearest_transformer_zone(t.damage, t.transformer)
        t.damage["outage_loc"] = _derive_outage_loc(t.damage)
    else:
        if "xf_zone" not in t.damage.columns:
            t.damage["xf_zone"] = t.damage["outage_loc"]

    if "damage_cat" not in t.damage.columns:
        t.damage["damage_cat"] = t.damage["asset_type"].map(ASSET_CATEGORY).astype("string")

    return t
