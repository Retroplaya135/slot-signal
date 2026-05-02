from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

MIN_SAFE_CHECK_INTERVAL_MINUTES = 15

ContractId = Annotated[str, Field(min_length=8, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")]
SafeText = Annotated[str, Field(min_length=1, max_length=320)]
ClockTime = Annotated[str, Field(pattern=r"^\d{2}:\d{2}$")]

PortalTarget = Literal["ais_usvisa_info"]
SourceKind = Literal["fixture", "public_reference", "user_visible_portal"]
AdapterResultReason = Literal[
    "fixture_data",
    "manual_check",
    "slots_found",
    "no_slots",
    "http_403",
    "http_429",
    "auth_redirect",
    "parser_mismatch",
    "repeated_empty",
    "empty_response",
    "permission_missing",
    "network_error",
    "policy_blocked",
]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=True)


class CheckPolicy(ContractModel):
    policyId: ContractId
    mode: Literal["fixture_only", "manual_on_demand"]
    minCheckIntervalMinutes: int = Field(ge=MIN_SAFE_CHECK_INTERVAL_MINUTES)
    maxChecksPerDay: int = Field(ge=1, le=96)
    cooldownOnResults: list[AdapterResultReason] = Field(min_length=1, max_length=16)
    livePortalChecksEnabled: Literal[False]
    allowAutomatedBooking: Literal[False]
    requireVisibleUserConfirmation: Literal[True]
    piiStorage: Literal["none"]
    createdAt: datetime


class AvailabilityCheckRequest(ContractModel):
    requestId: ContractId
    policyId: ContractId
    createdAt: datetime
    source: Literal["popup", "sidepanel", "service_worker", "test_harness"]
    portalTarget: PortalTarget
    sourceKind: Literal["fixture", "public_reference"]
    requestedConsulateIds: list[ContractId] = Field(min_length=1, max_length=24)
    idempotencyKey: ContractId
    traceId: ContractId
    livePortalChecksEnabled: Literal[False]
    userConsent: Literal["visible_session_only"]


class SlotCandidate(ContractModel):
    candidateId: ContractId
    snapshotId: ContractId
    portalTarget: PortalTarget
    consulateId: ContractId
    consulateName: SafeText
    appointmentDate: date
    appointmentTime: ClockTime | None
    appointmentType: Literal["consular", "asc", "ofc", "dropbox", "unknown"]
    sourceKind: SourceKind
    detectedAt: datetime
    confidence: Literal["low", "medium", "high"]
    rank: int = Field(ge=1, le=1000)
    bookingAction: Literal["open_official_page_only"]
    piiIncluded: Literal[False]

    @field_validator("appointmentTime")
    @classmethod
    def validate_clock_time(cls, value: str | None) -> str | None:
        if value is None or re.fullmatch(r"\d{2}:\d{2}", value):
            return value
        raise ValueError("appointmentTime must be HH:MM or null")


class AvailabilitySnapshot(ContractModel):
    snapshotId: ContractId
    requestId: ContractId
    capturedAt: datetime
    status: Literal["slots_found", "no_slots", "cooldown", "failed"]
    portalTarget: PortalTarget
    sourceKind: SourceKind
    resultReason: AdapterResultReason
    candidates: list[SlotCandidate] = Field(max_length=50)
    nextAllowedCheckAt: datetime | None
    minNextCheckMinutes: int = Field(ge=MIN_SAFE_CHECK_INTERVAL_MINUTES)
    auditEventId: ContractId | None
    livePortalRequestMade: Literal[False]


class BookingAssistSession(ContractModel):
    sessionId: ContractId
    candidateId: ContractId
    snapshotId: ContractId
    createdAt: datetime
    expiresAt: datetime
    status: Literal["prepared", "official_page_opened", "cancelled", "expired"]
    officialUrl: str
    finalConfirmationAuthority: Literal["user_in_browser"]
    allowBookingConfirmation: Literal[False]
    autoSubmitAllowed: Literal[False]
    visibleUserActionRequired: Literal[True]
    traceId: ContractId

    @field_validator("officialUrl")
    @classmethod
    def official_url_must_stay_on_ais(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme == "https" and parsed.netloc == "ais.usvisa-info.com":
            return value
        raise ValueError("officialUrl must stay on https://ais.usvisa-info.com")


class NotificationEvent(ContractModel):
    notificationId: ContractId
    eventType: Literal["availability_detected", "cooldown_started", "check_failed", "booking_assist_ready"]
    channel: Literal["browser", "telegram", "email", "slack", "debug"]
    createdAt: datetime
    deliveryStatus: Literal["pending", "sent", "failed", "suppressed"]
    relatedSnapshotId: ContractId | None
    relatedSessionId: ContractId | None
    messageIntent: Literal["alert_only", "status_only", "assist_ready"]
    redactionLevel: Literal["no_secrets", "pii_redacted"]
    containsBookingConfirmation: Literal[False]
    traceId: ContractId


class AuditEvent(ContractModel):
    auditId: ContractId
    occurredAt: datetime
    actorType: Literal["user", "extension", "backend", "adapter", "notification", "test_harness"]
    action: Literal[
        "check_requested",
        "snapshot_recorded",
        "cooldown_started",
        "notification_queued",
        "booking_assist_opened",
        "policy_rejected",
    ]
    source: Literal["popup", "sidepanel", "service_worker", "api", "fixture_adapter", "test_harness"]
    result: Literal["accepted", "rejected", "succeeded", "failed", "cooldown"]
    reason: AdapterResultReason | None
    traceId: ContractId
    idempotencyKey: ContractId
    redactionLevel: Literal["no_secrets", "pii_redacted"]
    containsSensitiveRawData: Literal[False]
    safeSummary: SafeText | None


class AdapterRunResult(ContractModel):
    runId: ContractId
    requestId: ContractId
    startedAt: datetime
    finishedAt: datetime | None
    status: Literal["succeeded", "no_slots", "cooldown", "failed"]
    sourceKind: SourceKind
    resultReason: AdapterResultReason
    httpStatus: Literal[403, 429, 500, 502, 503] | None
    snapshotId: ContractId | None
    nextAllowedCheckAt: datetime | None
    cooldownMinutes: int | None = Field(ge=MIN_SAFE_CHECK_INTERVAL_MINUTES)
    retryable: bool
    traceId: ContractId
    livePortalRequestMade: Literal[False]


DOMAIN_CONTRACT_MODELS = {
    "AdapterRunResult": AdapterRunResult,
    "AuditEvent": AuditEvent,
    "AvailabilityCheckRequest": AvailabilityCheckRequest,
    "AvailabilitySnapshot": AvailabilitySnapshot,
    "BookingAssistSession": BookingAssistSession,
    "CheckPolicy": CheckPolicy,
    "NotificationEvent": NotificationEvent,
    "SlotCandidate": SlotCandidate,
}
