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
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import chat
from . import concierge
from . import predict
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
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)
app.include_router(chat.router)


@app.on_event("startup")
def _warm_models() -> None:
    """Load the models in the background so the first dashboard request is fast."""
    import threading
    threading.Thread(target=lambda: _safe(predict.engine), daemon=True).start()


def _safe(fn) -> None:
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - e.g. expired AWS login; requests will retry
        log.warning("model warm-up failed: %s", exc)


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
def get_power_path(
    premise_id: str,
    severity: float = Query(default=1.0, ge=0.5, le=2.0,
                            description="storm severity knob (0.5 / 1.0 / 1.5 / 2.0)"),
):
    store = get_store()
    pp = topo.power_path(store, premise_id, severity)
    if not pp:
        # Only reached when the premise itself is unknown. A premise with a
        # missing/partial chain still returns a (fallback) path.
        raise HTTPException(
            status_code=404,
            detail=f"premise '{premise_id}' not found",
        )
    return pp


@app.get("/premise/{premise_id}/risk", tags=["models"])
def get_risk(premise_id: str):
    """Outage risk card for each storm severity (0.5 / 1.0 / 1.5 / 2.0), shaped like
    mock/api/risk_by_severity.json. Homes without an equipment chain get a fallback."""
    if not topo.find_premise(get_store(), premise_id):
        raise HTTPException(status_code=404, detail=f"premise '{premise_id}' not found")
    return predict.risk_by_severity(premise_id)


@app.get("/premise/{premise_id}/link-risk", tags=["models"])
def get_link_risk(premise_id: str, severity: float = Query(default=1.0, ge=0.1, le=3.0)):
    """Risk for each link (transformer, fuse/recloser area) on the home's Power Path."""
    return predict.link_risk(premise_id, severity)


@app.get("/premise/{premise_id}/restoration-grid", tags=["models"])
def get_restoration_grid(premise_id: str):
    """Restoration P10/P50/P90 hours for every dashboard scenario, shaped like
    mock/api/restoration_grid.json, plus drivers and the repair queue."""
    p = topo.find_premise(get_store(), premise_id)
    if not p or not p.get("has_chain"):
        raise HTTPException(status_code=404, detail=f"no equipment chain for premise '{premise_id}'")
    return predict.restoration_grid(str(premise_id))


def _known(premise_id: str) -> None:
    if not topo.find_premise(get_store(), premise_id):
        raise HTTPException(status_code=404, detail=f"premise '{premise_id}' not found")


@app.get("/premise/{premise_id}/guidance", tags=["models"])
def get_guidance(premise_id: str):
    """Preparation checklist + safety, from the home's risk band and expected outage length
    (variants: no-needs / medical)."""
    _known(premise_id)
    return concierge.guidance(premise_id)


@app.get("/premise/{premise_id}/alerts", tags=["models"])
def get_alerts(premise_id: str):
    """Alert eligibility, channels, timing and escalations (variants: no-needs / medical)."""
    _known(premise_id)
    return concierge.alerts(premise_id)


@app.get("/premise/{premise_id}/timeline", tags=["models"])
def get_timeline(premise_id: str):
    """Storm replay: model estimates at each step + the real Feb 2025 damage on the home's path."""
    _known(premise_id)
    return concierge.timeline(premise_id)


@app.get("/premise/{premise_id}/outage-hours", tags=["models"])
def get_outage_hours(
    premise_id: str,
    crews: int = Query(default=2, ge=1, le=10),
    storm_severity: float = Query(default=1.0, ge=0.1, le=3.0),
    access: str = Query(default="auto", pattern="^(auto|on|off)$"),
    switching_available: bool = True,
    prioritize_critical: bool = True,
):
    """All 200 simulated outage lengths (hours, sorted) for a scenario, if the home loses
    power. The dashboard's "Time That Matters" compares them with how long things last."""
    p = topo.find_premise(get_store(), premise_id)
    if not p or not p.get("has_chain"):
        raise HTTPException(status_code=404, detail=f"no equipment chain for premise '{premise_id}'")
    r = predict.simulate(str(premise_id), crews, storm_severity, access, switching_available, None, prioritize_critical)
    return {"premise_id": str(premise_id), "hours": r["runs"], "p10": r["p10"], "p50": r["p50"], "p90": r["p90"],
            "label": "Model estimate", "applies_if": "your home loses power"}


@app.get("/assumptions", tags=["models"])
def get_assumptions():
    return {"items": concierge.ASSUMPTIONS}


@app.get("/circuits/{circuit_id}/outline", tags=["network"])
def circuit_outline(circuit_id: str):
    """Outline of the area a circuit serves (convex hull of its homes; no individual points)."""
    return concierge.circuit_outline(circuit_id)


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


@app.get("/risk/heat", tags=["models"])
def risk_heat(severity: float = Query(default=1.0, ge=0.5, le=2.0)):
    """Predicted chance of losing power (Model A), averaged per ~500 m area for the map heat.
    Areas with fewer than 5 homes are hidden."""
    sev = min(predict.SEVERITIES, key=lambda s: abs(s - severity))
    return predict.risk_heat(sev)


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


# --------------------------------------------------------------------------
# hosted mode: serve the built dashboard from the same server (AEP_STATIC_DIR)
# --------------------------------------------------------------------------

if settings.aep_static_dir:
    @app.get("/", include_in_schema=False)
    def site_root():
        return RedirectResponse("/web/index.html")

    @app.middleware("http")
    async def no_stale_pages(request, call_next):
        # the page must be re-checked on every visit so a redeploy shows up at once;
        # its JS/CSS files have content hashes in their names, so they can stay cached
        response = await call_next(request)
        if request.url.path.endswith((".html", "/")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    # mounted last so every API route above keeps priority
    app.mount("/", StaticFiles(directory=settings.aep_static_dir, html=True), name="site")
