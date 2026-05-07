from fastapi import APIRouter, Request

from app.core.auth import require_admin_auth
from app.schemas.monitoring import RuntimeMonitoringResponse

router = APIRouter(prefix="/monitoring", tags=["monitoring"])


@router.get("/runtime", response_model=RuntimeMonitoringResponse)
async def read_runtime_monitoring(request: Request) -> RuntimeMonitoringResponse:
    require_admin_auth(request)
    return request.app.state.runtime_monitor.snapshot()
