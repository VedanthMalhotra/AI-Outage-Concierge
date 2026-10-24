"""FastAPI application: serves the cleaned AEP outage data from S3.

Run (from the backend/ directory):
    uv run uvicorn app.main:app --reload --port 8000

Endpoints are grouped by the data they expose. Everything reads the processed
parquet tables through the DataStore; nothing here mutates data.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import topology as topo
from .config import get_settings
from .data import TABLE_PATHS, get_store
from .models import (
    CatalogResponse,
    CircuitSummary,
    DamageHeatCell,
    DamageRecord,
    Device,
    Facility,
    HealthResponse,
    LaborAdder,
    LaborUnit,
    OutageHistory,
    PowerPathResponse,
    Premise,
    PremiseLookupResponse,
    RepairBundle,
    TableInfo,
    Zone,
    ZoneDamageCount,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("aep.api")

settings = get_settings()

app = FastAPI(
    title="AEP Outage Concierge — Data API",
    version="0.1.0",
    description=(
        "Serves the cleaned AEP outage datasets (processed parquet batches in "
        "Amazon S3) through read-only API calls. Privacy: no street addresses, "
        "no per-premise life-support flags; facility and customer figures are "
        "aggregates."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _source_label() -> str:
    store = get_store()
    if store.using_local:
        return f"local:{settings.aep_local_data_dir}"
    return f"s3://{settings.aep_s3_bucket}/{settings.aep_s3_prefix}"


# --------------------------------------------------------------------------
# meta
# --------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse, tags=["meta"])
def health():
    store = get_store()
    loaded = sum(1 for t in TABLE_PATHS if store.is_loaded(t))
    return HealthResponse(
        status="ok",
        source=_source_label(),
        tables_loaded=loaded,
        tables_total=len(TABLE_PATHS),
    )


@app.get("/catalog", response_model=CatalogResponse, tags=["meta"])
def catalog():
    """List every table, its columns, and (if already loaded) its row count."""
    store = get_store()
    tables = []
    for name in TABLE_PATHS:
        loaded = store.is_loaded(name)
        df = store.get(name) if loaded else None
        if df is None:
            # peek columns cheaply by loading; tables are small enough.
            df = store.get(name)
            loaded = True
        tables.append(TableInfo(
            name=name,
            rows=len(df),
            columns=list(df.columns),
            loaded=loaded,
        ))
    return CatalogResponse(source=_source_label(), tables=tables)


@app.post("/admin/preload", tags=["meta"])
def preload():
    """Eagerly load all tables into memory. Returns row counts."""
    try:
        return {"source": _source_label(), "row_counts": get_store().preload()}
    except Exception as exc:  # noqa: BLE001 - surface S3/credential errors clearly
        raise HTTPException(status_code=502, detail=f"data load failed: {exc}") from exc


# --------------------------------------------------------------------------
# premise + power path
# --------------------------------------------------------------------------

@app.get("/premise/lookup", response_model=PremiseLookupResponse, tags=["premise"])
def premise_lookup(
    id: Optional[str] = Query(default=None, description="premise id"),
    lat: Optional[float] = Query(default=None),
    lon: Optional[float] = Query(default=None),
):
    store = get_store()
    if id:
        p = topo.find_premise(store, id)
        if not p:
            raise HTTPException(status_code=404, detail=f"premise '{id}' not found")
    elif lat is not None and lon is not None:
        p = topo.nearest_premise(store, lat, lon)
        if not p:
            raise HTTPException(status_code=404, detail="no premise near that location")
    else:
        raise HTTPException(status_code=400, detail="provide ?id= or ?lat=&lon=")

    hist = topo.outage_history(store, p["premise_id"])
    return PremiseLookupResponse(
        premise=Premise(**p),
        outage_history=OutageHistory(**hist) if hist else None,
        data_coverage=topo.data_coverage(p),
    )


@app.get("/premise/{premise_id}/power-path", response_model=PowerPathResponse, tags=["premise"])
def get_power_path(premise_id: str):
    store = get_store()
    pp = topo.power_path(store, premise_id)
    if not pp:
        raise HTTPException(
            status_code=404,
            detail=f"no equipment chain for premise '{premise_id}'",
        )
    return pp


@app.get("/premise/{premise_id}/outage-history", response_model=OutageHistory, tags=["premise"])
def get_outage_history(premise_id: str):
    store = get_store()
    hist = topo.outage_history(store, premise_id)
    if not hist:
        raise HTTPException(status_code=404, detail=f"no labels for premise '{premise_id}'")
    return OutageHistory(**hist)


# --------------------------------------------------------------------------
# circuits / devices / zones
# --------------------------------------------------------------------------

@app.get("/circuits", response_model=list[str], tags=["network"])
def circuits():
    return topo.list_circuits(get_store())


@app.get("/circuits/{circuit_id}/summary", response_model=CircuitSummary, tags=["network"])
def circuit_summary(circuit_id: str):
    return topo.circuit_summary(get_store(), circuit_id)


@app.get("/devices", response_model=list[Device], tags=["network"])
def devices(
    circuit_id: Optional[str] = None,
    device_type: Optional[str] = Query(default=None, description="Fuse / Recloser / Switch ..."),
    limit: int = Query(default=200, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
):
    return topo.list_devices(get_store(), circuit_id, device_type, limit, offset)


@app.get("/zones/{zone_id}", response_model=Zone, tags=["network"])
def zone(zone_id: str):
    z = topo.get_zone(get_store(), zone_id)
    if not z:
        raise HTTPException(status_code=404, detail=f"zone '{zone_id}' not found")
    return Zone(**z)


@app.get("/zones/{zone_id}/damage", response_model=list[ZoneDamageCount], tags=["network"])
def zone_damage(zone_id: str, event: Optional[str] = Query(default=None)):
    return topo.zone_damage(get_store(), zone_id, event)


# --------------------------------------------------------------------------
# damage
# --------------------------------------------------------------------------

@app.get("/damage", response_model=list[DamageRecord], tags=["damage"])
def damage(
    circuit_id: Optional[str] = None,
    event: Optional[str] = Query(default=None, description="feb2025 / sep2024 / other"),
    zone_id: Optional[str] = Query(default=None, description="filter by transformer zone (xf_zone)"),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
):
    return topo.list_damage(get_store(), circuit_id, event, zone_id, limit, offset)


@app.get("/damage/heat", response_model=list[DamageHeatCell], tags=["damage"])
def damage_heat(
    event: Optional[str] = Query(default="feb2025"),
    circuit_id: Optional[str] = None,
):
    return topo.damage_heat(get_store(), event, circuit_id)


# --------------------------------------------------------------------------
# facilities + labor reference
# --------------------------------------------------------------------------

@app.get("/facilities", response_model=list[Facility], tags=["reference"])
def facilities(type: Optional[str] = Query(default=None, description="hospital / fire / ambulance")):
    return topo.list_facilities(get_store(), type)


@app.get("/reference/repair-bundles", response_model=list[RepairBundle], tags=["reference"])
def repair_bundles():
    return topo.repair_bundles(get_store())


@app.get("/reference/labor-units", response_model=list[LaborUnit], tags=["reference"])
def labor_units():
    return topo.labor_units(get_store())


@app.get("/reference/labor-adders", response_model=list[LaborAdder], tags=["reference"])
def labor_adders():
    return topo.labor_adders(get_store())
