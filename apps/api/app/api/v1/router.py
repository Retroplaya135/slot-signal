from fastapi import APIRouter

from app.api.v1 import entitlements, fixture_e2e, health, monitoring, provider_delivery, slot_reports

api_router = APIRouter()
api_router.include_router(entitlements.router)
api_router.include_router(fixture_e2e.router)
api_router.include_router(health.router)
api_router.include_router(monitoring.router)
api_router.include_router(provider_delivery.router)
api_router.include_router(slot_reports.router)
