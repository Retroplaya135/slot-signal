from typing import Literal

from pydantic import BaseModel, ConfigDict


class DependencyCheck(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: Literal["ok", "not_configured", "disabled", "degraded"]
    detail: str | None = None


class HealthResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: Literal["ok"]
    service: str
    version: str
    environment: Literal["local", "test", "staging", "production"]
    live_portal_enabled: Literal[False]
    checks: dict[str, DependencyCheck]
