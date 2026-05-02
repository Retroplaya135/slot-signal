from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from app.adapters.source import FixtureAdapterScenario
from app.schemas.domain import (
    ContractId,
    ContractModel,
    SafeText,
    AdapterRunResult,
    AuditEvent,
    AvailabilitySnapshot,
    BookingAssistSession,
    NotificationEvent,
)


class SafeNotificationMessage(ContractModel):
    title: SafeText
    body: SafeText
    actionLabel: Literal["Open tracker", "Review candidate"]
    messageIntent: Literal["alert_only", "status_only", "assist_ready"]
    bookingLanguageStatus: Literal["candidate_not_booked"]
    containsBookingConfirmation: Literal[False]
    containsSensitiveRawData: Literal[False]


class NotificationDeliveryResult(ContractModel):
    deliveryId: ContractId
    notificationId: ContractId
    channel: Literal["browser", "telegram", "email", "slack", "debug"]
    attemptedAt: datetime
    status: Literal["sent", "failed", "suppressed"]
    reason: Literal[
        "delivered",
        "channel_disabled",
        "adapter_not_configured",
        "missing_permission",
        "browser_api_unavailable",
        "unsafe_content",
    ]
    providerMessageId: str | None
    safeMessage: SafeNotificationMessage
    containsBookingConfirmation: Literal[False]
    containsSensitiveRawData: Literal[False]


class NotificationDispatchBundle(ContractModel):
    notification: NotificationEvent
    deliveries: list[NotificationDeliveryResult] = Field(min_length=1, max_length=4)
    auditEvent: AuditEvent


class FixtureE2ERunRequest(ContractModel):
    idempotencyKey: ContractId
    now: datetime | None = None
    requestedConsulateIds: list[ContractId] = Field(default_factory=lambda: ["consulate:fixture"], min_length=1, max_length=24)
    requestId: ContractId
    scenario: FixtureAdapterScenario = "slots_found"
    traceId: ContractId


class FixtureE2ERun(ContractModel):
    runId: ContractId
    createdAt: datetime
    idempotencyKey: ContractId
    scenario: FixtureAdapterScenario
    status: Literal["completed", "policy_blocked"]
    traceId: ContractId


class FixtureE2EInstrumentationSpan(ContractModel):
    spanId: ContractId
    stage: Literal[
        "request_validated",
        "adapter_completed",
        "notification_dispatched",
        "booking_assist_prepared",
        "audit_persisted",
    ]
    startedAt: datetime
    finishedAt: datetime
    durationMs: float = Field(ge=0)
    result: Literal["accepted", "succeeded", "suppressed", "replayed"]


class FixtureE2EIdempotencyState(ContractModel):
    key: ContractId
    status: Literal["created", "replayed"]
    replayedRunId: ContractId | None


class FixtureE2EInstrumentation(ContractModel):
    idempotency: FixtureE2EIdempotencyState
    spans: list[FixtureE2EInstrumentationSpan] = Field(min_length=1, max_length=12)


class FixtureE2ERunResponse(ContractModel):
    run: FixtureE2ERun
    adapterRun: AdapterRunResult
    appointmentChangingActionTaken: Literal[False]
    auditEvents: list[AuditEvent] = Field(min_length=1, max_length=12)
    bookingAssistSession: BookingAssistSession | None
    instrumentation: FixtureE2EInstrumentation
    livePortalRequestMade: Literal[False]
    notificationDispatch: NotificationDispatchBundle | None
    replayed: bool
    snapshot: AvailabilitySnapshot | None


class FixtureE2EAuditReadResponse(ContractModel):
    auditEvents: list[AuditEvent] = Field(min_length=1, max_length=12)
    instrumentation: FixtureE2EInstrumentation
    runId: ContractId


class FixtureE2EExportResponse(ContractModel):
    appointmentChangingActionTaken: Literal[False]
    auditEvents: list[AuditEvent] = Field(min_length=1, max_length=12)
    containsSensitiveRawData: Literal[False]
    exportedAt: datetime
    instrumentation: FixtureE2EInstrumentation
    livePortalRequestMade: Literal[False]
    retentionDays: int = Field(ge=1, le=365)
    runId: ContractId
    safeSummary: SafeText
    schemaVersion: int = Field(ge=1)


class FixtureE2EDeleteResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    deleted: bool
    deletedAuditEvents: int = Field(ge=0)
    deletedRuns: int = Field(ge=0, le=1)
    retentionAction: Literal["manual_delete"]
    runId: ContractId


class FixtureE2ERetentionPruneRequest(ContractModel):
    cutoffBefore: datetime | None = None
    dryRun: bool = True


class FixtureE2ERetentionPruneResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    cutoffBefore: datetime
    deletedAuditEvents: int = Field(ge=0)
    deletedRuns: int = Field(ge=0)
    dryRun: bool
    matchedRuns: int = Field(ge=0)
    retentionAction: Literal["retention_prune"]
