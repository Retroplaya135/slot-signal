from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from app.core.auth import require_admin_auth, require_client_or_admin_auth
from app.schemas.entitlements import (
    AccessCodeAuditResponse,
    AccessCodeIssueRequest,
    AccessCodeIssueResponse,
    AccessCodeListResponse,
    AccessCodeUpdateRequest,
    AccessCodeUpdateResponse,
    AccessCodeVerifyRequest,
    AccessCodeVerifyResponse,
)
from app.services.entitlements import InMemoryEntitlementStore, create_entitlement_store

router = APIRouter(prefix="/entitlements", tags=["entitlements"])


def _store(request: Request) -> InMemoryEntitlementStore:
    store = getattr(request.app.state, "entitlement_store", None)
    if store is None:
        store = create_entitlement_store(getattr(request.app.state, "settings", None))
        request.app.state.entitlement_store = store
    return store


def _clock_now(request: Request) -> datetime:
    configured = getattr(getattr(request.app.state, "settings", None), "clock_now", None)
    return configured or datetime.now(timezone.utc)


def require_valid_entitlement(request: Request, *, required_tier: str = "beta") -> None:
    settings = getattr(request.app.state, "settings", None)
    if not getattr(settings, "entitlement_required", False):
        return
    access_code = request.headers.get("x-slot-signal-access-code", "").strip()
    if not access_code:
        raise HTTPException(status_code=403, detail="Valid beta or advanced entitlement is required for this action.")
    response = _store(request).verify_access_code(
        AccessCodeVerifyRequest.model_validate(
            {
                "accessCode": access_code,
                "requiredTier": required_tier,
            }
        ),
        now=_clock_now(request),
    )
    if not response.valid:
        raise HTTPException(status_code=403, detail="Valid beta or advanced entitlement is required for this action.")


@router.post("/access-codes", response_model=AccessCodeIssueResponse)
async def issue_access_code(payload: AccessCodeIssueRequest, request: Request) -> AccessCodeIssueResponse:
    require_admin_auth(request)
    entitlement = _store(request).issue_access_code(payload, now=_clock_now(request))
    return AccessCodeIssueResponse.model_validate({"entitlement": entitlement})


@router.get("/access-codes", response_model=AccessCodeListResponse)
async def list_access_codes(request: Request) -> AccessCodeListResponse:
    require_admin_auth(request)
    return AccessCodeListResponse.model_validate(
        {
            "containsRawAccessCodes": False,
            "entitlements": _store(request).list_entitlements(),
        }
    )


@router.post("/access-codes/verify", response_model=AccessCodeVerifyResponse)
async def verify_access_code(payload: AccessCodeVerifyRequest, request: Request) -> AccessCodeVerifyResponse:
    require_client_or_admin_auth(request)
    return _store(request).verify_access_code(payload, now=_clock_now(request))


@router.get("/access-codes/audit", response_model=AccessCodeAuditResponse)
async def read_access_code_audit(request: Request) -> AccessCodeAuditResponse:
    require_admin_auth(request)
    return AccessCodeAuditResponse.model_validate(
        {
            "auditEvents": _store(request).audit_events(),
            "containsRawAccessCodes": False,
        }
    )


@router.patch("/access-codes/{entitlement_id}", response_model=AccessCodeUpdateResponse)
async def update_access_code(
    entitlement_id: str,
    payload: AccessCodeUpdateRequest,
    request: Request,
) -> AccessCodeUpdateResponse:
    require_admin_auth(request)
    response = _store(request).update_access_code(entitlement_id, payload, now=_clock_now(request))
    if response is None:
        raise HTTPException(status_code=404, detail="Access-code entitlement was not found.")
    return response


@router.get("/access-codes/{entitlement_id}/audit", response_model=AccessCodeAuditResponse)
async def read_access_code_audit_for_entitlement(entitlement_id: str, request: Request) -> AccessCodeAuditResponse:
    require_admin_auth(request)
    return AccessCodeAuditResponse.model_validate(
        {
            "auditEvents": _store(request).audit_events(entitlement_id),
            "containsRawAccessCodes": False,
        }
    )
