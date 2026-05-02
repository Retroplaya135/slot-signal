from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RuntimeMonitorRetention(BaseModel):
    model_config = ConfigDict(frozen=True)

    eventPolicy: Literal["anomalies_only"]
    maxRecentEvents: int = Field(ge=1, le=1000)
    storesBodies: Literal[False]
    storesHeaders: Literal[False]
    storesIpAddresses: Literal[False]
    storesQueryStrings: Literal[False]


class RuntimeMonitorCounters(BaseModel):
    model_config = ConfigDict(frozen=True)

    authRejections: int = Field(ge=0)
    clientErrors: int = Field(ge=0)
    rateLimited: int = Field(ge=0)
    requestsTotal: int = Field(ge=0)
    serverErrors: int = Field(ge=0)
    slowRequests: int = Field(ge=0)
    statusClasses: dict[str, int]


class RuntimeLatencySummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    averageMs: float
    buckets: dict[str, int]
    maxMs: float
    minMs: float
    slowThresholdMs: float


class RuntimeRouteSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    averageMs: float
    maxMs: float
    method: str
    route: str
    slowRequests: int = Field(ge=0)
    total: int = Field(ge=0)


class RuntimeAnomalyEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    durationMs: float
    method: str
    occurredAt: datetime
    route: str
    signal: Literal["auth_rejection", "client_error", "rate_limited", "server_error", "slow_request"]
    statusCode: int = Field(ge=100, le=599)


class RuntimeRedTeamSignals(BaseModel):
    model_config = ConfigDict(frozen=True)

    authProbeSuspected: bool
    highErrorRate: bool
    rateLimitPressure: bool
    serverErrorSpike: bool
    slowPathPressure: bool


class RuntimeFeatureVector(BaseModel):
    model_config = ConfigDict(frozen=True)

    authRejectionRate: float
    errorRate: float
    rateLimitRate: float
    requestVolume: int = Field(ge=0)
    slowRequestRate: float


class RuntimeMonitoringResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    counters: RuntimeMonitorCounters
    featureVector: RuntimeFeatureVector
    generatedAt: datetime
    latency: RuntimeLatencySummary
    recentAnomalies: list[RuntimeAnomalyEvent]
    redTeamSignals: RuntimeRedTeamSignals
    retention: RuntimeMonitorRetention
    routeSummaries: list[RuntimeRouteSummary]
    schemaVersion: Literal["runtime_monitoring.v1"]
    serviceUptimeSeconds: float
    status: Literal["ok", "watch", "degraded"]
