"""Pydantic response models for the API.

These describe the JSON the frontend and any model/agent layer consume. They
intentionally omit privacy-sensitive fields (see topology/main): no addresses,
no street codes, no per-premise life-support flag.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    source: str  # "s3://..." or "local:<dir>"
    tables_loaded: int
    tables_total: int


class TableInfo(BaseModel):
    name: str
    rows: Optional[int] = None  # null until loaded
    columns: list[str]
    loaded: bool


class CatalogResponse(BaseModel):
    source: str
    tables: list[TableInfo]


class Premise(BaseModel):
    premise_id: str
    lat: float
    lon: float
    circuit_id: str
    transformer_loc: str
    service_type: Optional[str] = None
    city: Optional[str] = None
    has_chain: bool
    zone_id: Optional[str] = None


class OutageHistory(BaseModel):
    out_feb2025: bool
    out_sep2024: bool
    out_other: bool


class PremiseLookupResponse(BaseModel):
    premise: Premise
    outage_history: Optional[OutageHistory] = None
    data_coverage: str  # "good" | "partial" | "none"


class ChainLink(BaseModel):
    step: int
    device_loc: Optional[str] = None
    device_type: str
    circuit_id: Optional[str] = None
    # enriched from the device/transformer tables where available:
    lat: Optional[float] = None
    lon: Optional[float] = None
    customers_downstream: Optional[int] = None
    rating: Optional[str] = None
    automated: Optional[bool] = None


class PowerPathResponse(BaseModel):
    premise_id: str
    circuit_id: str
    links: list[ChainLink]
    note: str


class Device(BaseModel):
    device_id: str
    device_loc: str
    device_type: str
    circuit_id: str
    lat: float
    lon: float
    normal_state: Optional[str] = None
    rating: Optional[str] = None
    upstream_loc: Optional[str] = None
    customers_downstream: int
    automated: Optional[bool] = None


class Zone(BaseModel):
    zone_id: str
    customers: int
    circuit_id: str
    device_type: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None


class ZoneDamageCount(BaseModel):
    zone_id: str
    event: str
    device: int
    pole: int
    primary_wire: int
    secondary: int
    transformer: int


class DamageRecord(BaseModel):
    damage_id: int
    event: str
    report_date: Optional[str] = None
    repaired: Optional[bool] = None
    repaired_date: Optional[str] = None
    circuit_id: str
    asset_type: Optional[str] = None
    damage_type: Optional[str] = None
    damage_cat: Optional[str] = None
    quantity: int
    access_issue: Optional[bool] = None
    lat: float
    lon: float
    xf_zone: Optional[str] = None
    outage_loc: Optional[str] = None


class DamageHeatCell(BaseModel):
    lat: float
    lon: float
    count: int


class Facility(BaseModel):
    name: str
    type: str
    town: str
    lat: float
    lon: float
    is_general_er: bool
    zone_id: Optional[str] = None


class RepairBundle(BaseModel):
    asset_type: str
    parts: str
    direct_hours: float


class LaborUnit(BaseModel):
    part: str
    size_band: Optional[str] = None
    install_h: float
    removal_h: float


class LaborAdder(BaseModel):
    adder: str
    hours: float


class CircuitSummary(BaseModel):
    circuit_id: str
    premises: int
    transformers: int
    devices: int
    zones: int
    damage_feb2025: int
    damage_sep2024: int
    damage_other: int
