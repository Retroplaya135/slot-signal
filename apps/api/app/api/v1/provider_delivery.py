from fastapi import APIRouter, Request

from app.core.auth import require_admin_auth
from app.notifications.provider_delivery import (
    dispatch_provider_deliveries,
    provider_delivery_readiness_v2,
)
from app.schemas.provider_delivery import (
    ProviderDeliveryDispatchCreate,
    ProviderDeliveryDispatchResponse,
    ProviderDeliveryV2ReadinessResponse,
)

router = APIRouter(prefix="/provider-delivery", tags=["provider-delivery"])


@router.get("/readiness", response_model=ProviderDeliveryV2ReadinessResponse)
async def read_provider_delivery_readiness(request: Request) -> ProviderDeliveryV2ReadinessResponse:
    require_admin_auth(request)
    return provider_delivery_readiness_v2(request.app.state.settings)


@router.post("/dispatch", response_model=ProviderDeliveryDispatchResponse)
async def dispatch_provider_delivery(
    payload: ProviderDeliveryDispatchCreate,
    request: Request,
) -> ProviderDeliveryDispatchResponse:
    require_admin_auth(request)
    outbox = request.app.state.slot_report_store.provider_outbox_history(limit=1000).deliveries
    return dispatch_provider_deliveries(
        outbox=outbox,
        payload=payload,
        settings=request.app.state.settings,
    )
