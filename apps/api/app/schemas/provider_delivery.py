from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas.domain import ContractId, ContractModel, SafeText
from app.schemas.slot_reports import ProviderDeliveryChannel

ProviderDispatchStatus = Literal[
    "dry_run_recorded",
    "blocked_not_configured",
    "sent",
    "failed",
    "skipped",
]
ProviderDispatchReason = Literal[
    "dry_run_only",
    "provider_mode_disabled",
    "provider_channel_not_configured",
    "provider_send_succeeded",
    "provider_send_failed",
    "outbox_not_found",
    "consent_missing",
]


class ProviderDeliveryV2ReadinessResponse(ContractModel):
    auditLogEnabled: Literal[True]
    checkedAt: datetime
    configuredChannels: list[ProviderDeliveryChannel] = Field(max_length=3)
    containsSensitiveRawData: Literal[False]
    externalNetworkCallAttempted: Literal[False]
    liveDeliveryEnabled: bool
    missingChannels: list[ProviderDeliveryChannel] = Field(max_length=3)
    providerDeliveryMode: Literal["disabled", "dry_run", "live"]
    requiresExplicitConsent: Literal[True]
    storesProviderRecipients: Literal[False]
    unsubscribeRequired: Literal[True]


class ProviderDeliveryDispatchCreate(ContractModel):
    channels: list[ProviderDeliveryChannel] = Field(min_length=1, max_length=3)
    containsSensitiveRawData: Literal[False]
    dryRun: bool = True
    explicitConsent: bool
    maxAttempts: int = Field(default=1, ge=1, le=3)
    outboxDeliveryIds: list[ContractId] | None = Field(default=None, max_length=100)
    recordedAt: datetime | None = None
    unsubscribeAction: Literal["pause_or_delete_filter"]

    @field_validator("channels")
    @classmethod
    def normalize_channels(cls, value: list[ProviderDeliveryChannel]) -> list[ProviderDeliveryChannel]:
        return list(dict.fromkeys(value))


class ProviderDeliveryDispatchAuditEvent(ContractModel):
    auditId: ContractId
    channel: ProviderDeliveryChannel
    consentChecked: bool
    containsSensitiveRawData: Literal[False]
    externalNetworkCallAttempted: bool
    notificationId: ContractId | None = None
    outboxDeliveryId: ContractId | None = None
    providerDeliveryMode: Literal["disabled", "dry_run", "live"]
    providerFailureCode: SafeText | None = None
    reason: ProviderDispatchReason
    recordedAt: datetime
    retryBackoffSeconds: int = Field(ge=60, le=3600)
    status: ProviderDispatchStatus
    unsubscribeAction: Literal["pause_or_delete_filter"]


class ProviderDeliveryDispatchResult(ContractModel):
    auditEvent: ProviderDeliveryDispatchAuditEvent
    channel: ProviderDeliveryChannel
    containsSensitiveRawData: Literal[False]
    externalNetworkCallAttempted: bool
    notificationId: ContractId | None = None
    outboxDeliveryId: ContractId | None = None
    providerFailureCode: SafeText | None = None
    providerMessageId: SafeText | None = None
    reason: ProviderDispatchReason
    status: ProviderDispatchStatus


class ProviderDeliveryDispatchResponse(ContractModel):
    auditEvents: list[ProviderDeliveryDispatchAuditEvent] = Field(max_length=200)
    containsSensitiveRawData: Literal[False]
    deliveryResults: list[ProviderDeliveryDispatchResult] = Field(max_length=200)
    dryRun: bool
    externalNetworkCallAttempted: bool
    liveDeliveryEnabled: bool
    providerDeliveryMode: Literal["disabled", "dry_run", "live"]
    slotAlertsDelivered: bool
    storesProviderRecipients: Literal[False]
