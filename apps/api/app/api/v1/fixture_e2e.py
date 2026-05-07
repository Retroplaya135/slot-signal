from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from app.core.auth import require_admin_auth, require_client_or_admin_auth
from app.schemas.fixture_e2e import (
    FixtureE2EAuditReadResponse,
    FixtureE2EDeleteResponse,
    FixtureE2EExportResponse,
    FixtureE2ERetentionPruneRequest,
    FixtureE2ERetentionPruneResponse,
    FixtureE2ERunRequest,
    FixtureE2ERunResponse,
)
from app.services.fixture_e2e import execute_fixture_e2e_run, read_fixture_e2e_audit
from app.storage.fixture_e2e_store import FixtureE2EStore, FixtureE2EStoreUnavailableError, create_fixture_e2e_store

router = APIRouter(prefix="/fixture-e2e", tags=["fixture-e2e"])


def _store(request: Request) -> FixtureE2EStore:
    store = getattr(request.app.state, "fixture_e2e_store", None)
    if store is None:
        store = create_fixture_e2e_store(request.app.state.settings)
        request.app.state.fixture_e2e_store = store
    return store


def _ensure_persistence_admin_allowed(request: Request) -> None:
    require_admin_auth(request)


def _store_unavailable(error: FixtureE2EStoreUnavailableError) -> HTTPException:
    return HTTPException(status_code=503, detail="Durable fixture audit store is unavailable.")


@router.post("/runs", response_model=FixtureE2ERunResponse)
async def create_fixture_e2e_run(payload: FixtureE2ERunRequest, request: Request) -> FixtureE2ERunResponse:
    require_client_or_admin_auth(request)
    try:
        return execute_fixture_e2e_run(payload, _store(request))
    except FixtureE2EStoreUnavailableError as error:
        raise _store_unavailable(error) from error


@router.post("/audit/retention/prune", response_model=FixtureE2ERetentionPruneResponse)
async def prune_fixture_e2e_audit(
    payload: FixtureE2ERetentionPruneRequest,
    request: Request,
) -> FixtureE2ERetentionPruneResponse:
    _ensure_persistence_admin_allowed(request)
    cutoff = payload.cutoffBefore or (
        datetime.now(timezone.utc) - timedelta(days=request.app.state.settings.audit_retention_days)
    )
    try:
        result = _store(request).prune_before(cutoff, payload.dryRun)
    except FixtureE2EStoreUnavailableError as error:
        raise _store_unavailable(error) from error
    return FixtureE2ERetentionPruneResponse.model_validate(
        {
            "containsSensitiveRawData": False,
            "cutoffBefore": cutoff,
            "deletedAuditEvents": result["deletedAuditEvents"],
            "deletedRuns": result["deletedRuns"],
            "dryRun": payload.dryRun,
            "matchedRuns": result["matchedRuns"],
            "retentionAction": "retention_prune",
        }
    )


@router.get("/runs/{run_id}/export", response_model=FixtureE2EExportResponse)
async def export_fixture_e2e_run(run_id: str, request: Request) -> FixtureE2EExportResponse:
    _ensure_persistence_admin_allowed(request)
    try:
        response = _store(request).export_run(run_id)
        schema_version = _store(request).schema_version()
    except FixtureE2EStoreUnavailableError as error:
        raise _store_unavailable(error) from error
    if response is None:
        raise HTTPException(status_code=404, detail="Fixture E2E run was not found.")
    return FixtureE2EExportResponse.model_validate(
        {
            "appointmentChangingActionTaken": False,
            "auditEvents": response.auditEvents,
            "containsSensitiveRawData": False,
            "exportedAt": datetime.now(timezone.utc),
            "instrumentation": response.instrumentation,
            "livePortalRequestMade": False,
            "retentionDays": request.app.state.settings.audit_retention_days,
            "runId": response.run.runId,
            "safeSummary": "Redacted fixture E2E audit export; no portal page dump or private auth data included.",
            "schemaVersion": schema_version,
        }
    )


@router.delete("/runs/{run_id}", response_model=FixtureE2EDeleteResponse)
async def delete_fixture_e2e_run(run_id: str, request: Request) -> FixtureE2EDeleteResponse:
    _ensure_persistence_admin_allowed(request)
    try:
        result = _store(request).delete_run_with_counts(run_id)
    except FixtureE2EStoreUnavailableError as error:
        raise _store_unavailable(error) from error
    return FixtureE2EDeleteResponse.model_validate(
        {
            "containsSensitiveRawData": False,
            "deleted": result["deleted"],
            "deletedAuditEvents": result["deletedAuditEvents"],
            "deletedRuns": result["deletedRuns"],
            "retentionAction": "manual_delete",
            "runId": run_id,
        }
    )


@router.get("/runs/{run_id}/audit", response_model=FixtureE2EAuditReadResponse)
async def read_fixture_e2e_run_audit(run_id: str, request: Request) -> FixtureE2EAuditReadResponse:
    _ensure_persistence_admin_allowed(request)
    try:
        audit = read_fixture_e2e_audit(run_id, _store(request))
    except FixtureE2EStoreUnavailableError as error:
        raise _store_unavailable(error) from error
    if audit is None:
        raise HTTPException(status_code=404, detail="Fixture E2E run was not found.")
    return audit
