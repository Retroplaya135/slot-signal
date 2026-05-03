from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.domain import ContractId, ContractModel, NotificationEvent, SafeText

SlotReportSourceKind = Literal["community_report", "manual_report"]
SlotReportConfidence = Literal["user_visible", "community_report"]
SlotReportFreshness = Literal["fresh", "stale"]
SlotReportTrustStatus = Literal["accepted_unique", "accepted_duplicate", "accepted_conflict", "stale_suppressed"]
SlotReportQualityTier = Literal["trusted", "standard", "low", "suppressed"]
SlotReportQualitySignal = Literal[
    "visible_metadata_only",
    "user_visible_confidence",
    "community_report_confidence",
    "registered_local_identity",
    "stable_local_identity",
    "identity_rotation_warning",
    "independent_corroboration",
    "fresh_report",
    "duplicate_same_dates",
    "conflicting_same_scope",
    "local_review_watch",
    "local_review_restricted",
]
SlotReportSuppressionReason = Literal[
    "stale_report",
    "duplicate_report",
    "conflicting_report",
    "restricted_contributor",
    "low_quality_score",
]
NotificationChannel = Literal["browser", "telegram", "email", "slack"]
NotificationDeliveryMode = Literal["immediate", "digest"]
AlertDeliveryStatus = Literal["sent", "suppressed", "failed"]
NotificationAdapterSandboxChannel = Literal["email", "telegram", "slack"]
NotificationAdapterSandboxStatus = Literal["recorded", "skipped", "suppressed"]
NotificationAdapterSandboxReason = Literal[
    "sandbox_payload_recorded",
    "channel_not_subscribed",
    "not_eligible",
]
ProviderDeliveryChannel = Literal["email", "telegram", "slack"]
ProviderOutboxStatus = Literal["queued_disabled", "skipped", "suppressed"]
ProviderOutboxReason = Literal[
    "provider_disabled_by_default",
    "channel_not_subscribed",
    "not_eligible",
]
ProviderDeliveryBlockedReason = Literal[
    "external_provider_delivery_disabled_by_default",
    "provider_credentials_not_configured",
]
AlertSubscriptionStatus = Literal["active", "paused", "deleted"]
AlertSubscriptionAuditAction = Literal["created", "paused", "resumed", "cooldown_updated", "delivery_policy_updated", "deleted"]
ContributorReputationStatus = Literal["new", "normal", "watch", "restricted"]
ContributorAbuseAuditAction = Literal["report_accepted", "rate_limited", "abuse_review_flagged"]
ContributorAbuseAuditReason = Literal[
    "accepted_under_rate_limit",
    "hourly_report_limit_exceeded",
    "conflict_watch_threshold_reached",
]
ContributorIdentityHealth = Literal["not_registered", "new", "stable", "rotated", "review"]
ContributorIdentityProofKind = Literal["opaque_local_key"]
ContributorIdentityStorageScope = Literal["extension_local_storage"]
ContributorIdentityAuditAction = Literal["created", "seen", "rotated"]
ContributorModerationReason = Literal["rate_limit_review", "conflict_review", "manual_review", "false_report_review"]
ContributorLocalReviewStatus = Literal["clear", "watch", "restricted"]
PublicEstimateParserStatus = Literal["parsed", "parser_failed", "source_stale"]
PublicEstimateSnapshotStatus = Literal["accepted", "quarantined"]
PublicEstimateFreshness = Literal["fresh", "stale", "quarantined"]
PublicEstimateAdapterMode = Literal["fixture_replay"]
PublicEstimateAllowlistStatus = Literal["allowlisted"]
PublicEstimateSourceId = Literal["travel_state_global_wait_times"]
PublicContextSourceKind = Literal["public_estimate"]
PublicContextFreshness = Literal["fresh", "stale", "quarantined", "mixed"]
PublicContextStatus = Literal["accepted", "quarantined", "mixed"]
SourcePolicySourceKind = Literal[
    "community_report",
    "manual_report",
    "public_estimate",
    "notification_adapter_sandbox",
    "authorized_partner_api",
]
SourcePolicyLane = Literal[
    "community_signal",
    "manual_visible_metadata",
    "public_context",
    "sandbox_payload",
    "authorized_source_pending_evidence",
]
SourcePolicyAlertEligibility = Literal[
    "alert_allowed",
    "context_only",
    "sandbox_only",
    "blocked_pending_authorization",
]
AlertDeliveryReason = Literal[
    "already_delivered_locally",
    "browser_api_unavailable",
    "browser_create_failed",
    "browser_notification_created",
    "digest_mode_deferred",
    "digest_summary_sent",
    "digest_suppressed_by_user",
    "not_browser_channel",
    "not_eligible",
]
AlertDigestDeliveryReason = Literal["digest_summary_sent", "digest_suppressed_by_user"]
AlertDigestDeliveryStatus = Literal["sent", "suppressed"]

_SENSITIVE_NOTE_PATTERN = re.compile(
    r"\b("
    r"password|passcode|otp|mfa|2fa|cookie|session|token|bearer|authorization|"
    r"passport|ds-160|ds160|sevis|csrf|hidden field|raw html|html dump|screenshot"
    r")\b",
    re.IGNORECASE,
)
_EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_PATTERN = re.compile(r"(?:\+?\d[\s().-]?){8,}")


class AlertSubscriptionCreate(ContractModel):
    active: bool = True
    channels: list[NotificationChannel] = Field(min_length=1, max_length=4)
    cooldownMinutes: int = Field(default=15, ge=15, le=1440)
    country: SafeText
    deliveryMode: NotificationDeliveryMode = "immediate"
    digestWindowMinutes: int = Field(default=60, ge=15, le=1440)
    postCities: list[SafeText] = Field(min_length=1, max_length=24)
    targetStartDate: date
    targetEndDate: date
    visaClasses: list[SafeText] = Field(min_length=1, max_length=24)

    @field_validator("channels")
    @classmethod
    def normalize_channels(cls, value: list[NotificationChannel]) -> list[NotificationChannel]:
        return list(dict.fromkeys(value))

    @field_validator("postCities", "visaClasses")
    @classmethod
    def normalize_unique_values(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def validate_date_window(self) -> "AlertSubscriptionCreate":
        if self.targetStartDate > self.targetEndDate:
            raise ValueError("targetStartDate must be on or before targetEndDate")
        return self


class AlertSubscription(AlertSubscriptionCreate):
    subscriptionId: ContractId
    createdAt: datetime
    deletedAt: datetime | None = None
    lastNotificationAt: datetime | None = None
    pausedAt: datetime | None = None
    status: AlertSubscriptionStatus = "active"
    updatedAt: datetime | None = None


class AlertSubscriptionUpdate(ContractModel):
    active: bool | None = None
    auditReason: str | None = Field(default=None, max_length=160)
    containsSensitiveRawData: Literal[False]
    cooldownMinutes: int | None = Field(default=None, ge=15, le=1440)
    deliveryMode: NotificationDeliveryMode | None = None
    digestWindowMinutes: int | None = Field(default=None, ge=15, le=1440)

    @field_validator("auditReason")
    @classmethod
    def reject_sensitive_audit_reason(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if _SENSITIVE_NOTE_PATTERN.search(value):
            raise ValueError("auditReason must not include credentials, tokens, MFA, raw page data, or screenshots")
        if _EMAIL_PATTERN.search(value) or _PHONE_PATTERN.search(value):
            raise ValueError("auditReason must not include personal contact data")
        return value


class AlertSubscriptionAuditEvent(ContractModel):
    action: AlertSubscriptionAuditAction
    auditReason: str | None = Field(default=None, max_length=160)
    containsSensitiveRawData: Literal[False]
    recordedAt: datetime
    subscriptionId: ContractId


class AlertSubscriptionListResponse(ContractModel):
    auditEvents: list[AlertSubscriptionAuditEvent] = Field(max_length=500)
    subscriptions: list[AlertSubscription] = Field(max_length=500)


class AlertSubscriptionUpdateResponse(ContractModel):
    auditEvent: AlertSubscriptionAuditEvent
    subscription: AlertSubscription


class AlertSubscriptionDeleteResponse(ContractModel):
    auditEvent: AlertSubscriptionAuditEvent
    deleted: bool
    removedPendingMatches: int
    subscription: AlertSubscription


class AlertPendingCleanupRequest(ContractModel):
    checkedAt: datetime | None = None
    cutoffBefore: datetime | None = None
    dryRun: bool = True


class AlertPendingCleanupResponse(ContractModel):
    checkedAt: datetime
    cleanupReason: Literal["stale_pending_cleanup"]
    containsSensitiveRawData: Literal[False]
    deletedPendingMatches: int = Field(ge=0)
    dryRun: bool
    matchedPendingMatches: int = Field(ge=0)


class AlertDeliveryAckCreate(ContractModel):
    acknowledgedAt: datetime | None = None
    containsSensitiveRawData: Literal[False]
    deliveryAttemptedInBrowser: bool
    deliveryStatus: AlertDeliveryStatus
    reason: AlertDeliveryReason


class AlertDeliveryAuditEvent(ContractModel):
    acknowledgedAt: datetime
    containsSensitiveRawData: Literal[False]
    deliveryAttemptedInBrowser: bool
    deliveryStatus: AlertDeliveryStatus
    notificationEvent: NotificationEvent
    notificationId: ContractId
    reason: AlertDeliveryReason
    reportId: ContractId
    subscriptionId: ContractId


class AlertDeliveryAckResponse(ContractModel):
    deliveryAudit: AlertDeliveryAuditEvent
    notificationEvent: NotificationEvent
    replayed: bool


class AlertDigestDeliveryAckCreate(ContractModel):
    acknowledgedAt: datetime | None = None
    containsSensitiveRawData: Literal[False]
    deliveryAttemptedInBrowser: Literal[False] = False
    deliveryStatus: AlertDigestDeliveryStatus
    reason: AlertDigestDeliveryReason

    @model_validator(mode="after")
    def validate_digest_reason_matches_status(self) -> "AlertDigestDeliveryAckCreate":
        if self.deliveryStatus == "sent" and self.reason != "digest_summary_sent":
            raise ValueError("sent digest decisions must use digest_summary_sent")
        if self.deliveryStatus == "suppressed" and self.reason != "digest_suppressed_by_user":
            raise ValueError("suppressed digest decisions must use digest_suppressed_by_user")
        return self


class AlertDigestDeliveryAckResponse(ContractModel):
    acknowledgedAt: datetime
    acknowledgedCount: int = Field(ge=0)
    containsSensitiveRawData: Literal[False]
    deliveryAudits: list[AlertDeliveryAuditEvent] = Field(max_length=100)
    deliveryStatus: AlertDigestDeliveryStatus
    reason: AlertDigestDeliveryReason
    replayedCount: int = Field(ge=0)
    subscriptionId: ContractId


class AlertDeliveryAuditResponse(ContractModel):
    auditEvents: list[AlertDeliveryAuditEvent] = Field(max_length=100)
    notificationId: ContractId


class AlertDeliveryHistoryResponse(ContractModel):
    auditEvents: list[AlertDeliveryAuditEvent] = Field(max_length=100)
    containsSensitiveRawData: Literal[False]
    countsByStatus: dict[AlertDeliveryStatus, int]


