from collections.abc import Callable
from time import perf_counter

from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import Settings, get_settings
from app.services.entitlements import create_entitlement_store
from app.services.runtime_monitor import RuntimeMonitor
from app.services.slot_reports import create_slot_report_store
from app.storage.fixture_e2e_store import create_fixture_e2e_store


def custom_generate_unique_id(route: APIRoute) -> str:
    tag = route.tags[0] if route.tags else "api"
    return f"{tag}-{route.name}"


def create_app(settings_factory: Callable[[], Settings] = get_settings) -> FastAPI:
    settings = settings_factory()
    app = FastAPI(
        title=settings.app_name,
        version=settings.api_version,
        openapi_url=f"{settings.api_v1_prefix}/openapi.json",
        generate_unique_id_function=custom_generate_unique_id,
    )
    app.state.settings = settings
    app.state.fixture_e2e_store = create_fixture_e2e_store(settings)
    app.state.runtime_monitor = RuntimeMonitor()
    app.state.slot_report_store = create_slot_report_store(settings)
    app.state.entitlement_store = create_entitlement_store(settings)

    @app.middleware("http")
    async def runtime_monitoring_middleware(request, call_next):
        started = perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            route = getattr(request.scope.get("route"), "path", request.url.path)
            app.state.runtime_monitor.record_request(
                duration_ms=(perf_counter() - started) * 1000,
                method=request.method,
                route=route,
                status_code=status_code,
            )

    cors_origins = settings.allowed_origins
    if not cors_origins and settings.environment in {"local", "test"}:
        cors_origins = ("http://127.0.0.1:5179", "http://localhost:5179")
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_credentials=False,
            allow_headers=["Authorization", "Content-Type"],
            allow_methods=["DELETE", "GET", "PATCH", "POST"],
            allow_origins=list(cors_origins),
        )
    app.include_router(api_router, prefix=settings.api_v1_prefix)
    return app


app = create_app()
