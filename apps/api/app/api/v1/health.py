from fastapi import APIRouter, Request

from app.schemas.health import DependencyCheck, HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def read_health(request: Request) -> HealthResponse:
    settings = request.app.state.settings
    database_check = DependencyCheck(status="not_configured")
    store = getattr(request.app.state, "fixture_e2e_store", None)
    if settings.audit_db_path and hasattr(store, "health_check"):
        store_health = store.health_check()
        database_check = DependencyCheck(
            status=store_health.get("status", "degraded"),
            detail=store_health.get("detail"),
        )
    auth_status = "ok" if not settings.auth_required or (settings.admin_token_sha256 and settings.client_token_sha256) else "degraded"
    provider_status = "ok" if settings.provider_delivery_mode == "live" else "disabled"
    entitlement_store = getattr(request.app.state, "entitlement_store", None)
    entitlement_check = DependencyCheck(status="disabled")
    if settings.entitlement_required:
        if entitlement_store and hasattr(entitlement_store, "health_check"):
            health = entitlement_store.health_check()
            entitlement_check = DependencyCheck(status=health.get("status", "degraded"), detail=health.get("detail"))
        else:
            entitlement_check = DependencyCheck(status="degraded", detail="entitlement store is required but unavailable")
    return HealthResponse(
        status="ok",
        service=settings.app_name,
        version=settings.api_version,
        environment=settings.environment,
        live_portal_enabled=False,
        checks={
            "database": database_check,
            "queue": DependencyCheck(status="not_configured"),
            "portal_adapter": DependencyCheck(status="disabled"),
            "notifications": DependencyCheck(status=provider_status),
            "production_auth": DependencyCheck(status=auth_status),
            "entitlements": entitlement_check,
        },
    )
