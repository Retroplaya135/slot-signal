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


class SlotReportCreate(ContractModel):
    sourceKind: SlotReportSourceKind
    country: SafeText
    postCity: SafeText
    visaClass: SafeText
    availableDates: list[date] = Field(min_length=1, max_length=60)
    capturedAt: datetime
    confidence: SlotReportConfidence
    notes: str | None = Field(default=None, max_length=320)
    contributorId: str | None = Field(default=None, min_length=8, max_length=120)
    containsSensitiveRawData: Literal[False]
    credentialDataIncluded: Literal[False]
    portalAutomationUsed: Literal[False]
    bookingActionTaken: Literal[False]

    @field_validator("availableDates")
    @classmethod
    def normalize_available_dates(cls, value: list[date]) -> list[date]:
        unique_sorted = sorted(set(value))
        if not unique_sorted:
            raise ValueError("availableDates must include at least one date")
        return unique_sorted

    @field_validator("notes")
    @classmethod
    def reject_sensitive_notes(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if _SENSITIVE_NOTE_PATTERN.search(value):
            raise ValueError("notes must not include credentials, tokens, MFA, raw page data, or screenshots")
        if _EMAIL_PATTERN.search(value) or _PHONE_PATTERN.search(value):
            raise ValueError("notes must not include personal contact data")
        return value


class SlotReportProvenance(ContractModel):
    sourceKind: SlotReportSourceKind
    confidence: SlotReportConfidence
    country: SafeText
    postCity: SafeText
    visaClass: SafeText
    capturedAt: datetime
    submittedAt: datetime
    contributorId: str | None = Field(default=None, min_length=8, max_length=120)
    officialAvailabilitySource: Literal[False]
    availabilityClaim: Literal["community_report_not_official_confirmation"]


class SlotReportTrust(ContractModel):
    status: SlotReportTrustStatus
    dedupeKey: str = Field(min_length=8, max_length=240, pattern=r"^[A-Za-z0-9._:-]+$")
    duplicateOfReportId: ContractId | None
    conflictingReportIds: list[ContractId] = Field(max_length=24)
    eligibleForNotification: bool
    independentContributorCount: int = Field(default=0, ge=0, le=1000)
    qualityScore: int = Field(default=70, ge=0, le=100)
    qualitySignals: list[SlotReportQualitySignal] = Field(default_factory=list, max_length=16)
    qualityTier: SlotReportQualityTier = "standard"
    similarFreshReportCount: int = Field(default=0, ge=0, le=1000)
    suppressionReasons: list[SlotReportSuppressionReason] = Field(default_factory=list, max_length=16)
    visibleMetadataOnly: Literal[True]
    provenance: SlotReportProvenance


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


class AlertMatch(ContractModel):
    subscriptionId: ContractId
    reportId: ContractId
    matchedDates: list[date] = Field(min_length=1, max_length=60)
    notificationReason: Literal["fresh_community_report_matches_filter"]
    availabilityClaim: Literal["community_report_not_official_confirmation"]
    deliveryMode: NotificationDeliveryMode = "immediate"
    digestWindowMinutes: int = Field(default=60, ge=15, le=1440)
    lastDeliveryAttemptAt: datetime | None = None
    nextRetryAt: datetime | None = None
    notificationEvent: NotificationEvent
    reportTrust: SlotReportTrust
    retryAttemptCount: int = Field(default=0, ge=0)


class AlertMatchesResponse(ContractModel):
    subscription: AlertSubscription
    matches: list[AlertMatch] = Field(max_length=100)


class AlertNotificationDigestGroup(ContractModel):
    deliveryMode: Literal["digest"]
    digestWindowMinutes: int = Field(ge=15, le=1440)
    latestMatchedAt: datetime
    matches: list[AlertMatch] = Field(max_length=100)
    pendingCount: int = Field(ge=0)
    subscriptionId: ContractId


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


class NotificationAdapterSandboxCreate(ContractModel):
    adapterMode: Literal["sandbox_only"]
    channels: list[NotificationAdapterSandboxChannel] = Field(min_length=1, max_length=3)
    containsSensitiveRawData: Literal[False]
    includeDigest: bool = False
    notificationIds: list[ContractId] | None = Field(default=None, max_length=100)
    recordedAt: datetime | None = None

    @field_validator("channels")
    @classmethod
    def normalize_channels(cls, value: list[NotificationAdapterSandboxChannel]) -> list[NotificationAdapterSandboxChannel]:
        return list(dict.fromkeys(value))


class NotificationAdapterSandboxPayload(ContractModel):
    actionLabel: Literal["Open tracker"]
    adapterMode: Literal["sandbox_only"]
    availabilityClaim: Literal["community_report_not_official_confirmation"]
    body: SafeText
    channel: NotificationAdapterSandboxChannel
    containsBookingConfirmation: Literal[False]
    containsSensitiveRawData: Literal[False]
    country: SafeText
    externalNetworkCallAttempted: Literal[False]
    matchedDates: list[date] = Field(min_length=1, max_length=60)
    postCity: SafeText
    providerEndpoint: Literal["not_called"]
    recipientRef: ContractId
    redactionLevel: Literal["no_secrets"]
    title: Literal["Community visa slot report"]
    unsubscribeAction: Literal["pause_or_delete_filter"]
    visaClass: SafeText


class NotificationAdapterSandboxDelivery(ContractModel):
    channel: NotificationAdapterSandboxChannel
    containsSensitiveRawData: Literal[False]
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    notificationId: ContractId
    payload: NotificationAdapterSandboxPayload | None
    reason: NotificationAdapterSandboxReason
    recordedAt: datetime
    reportId: ContractId
    sandboxDeliveryId: ContractId
    status: NotificationAdapterSandboxStatus
    subscriptionId: ContractId


class NotificationAdapterSandboxResponse(ContractModel):
    adapterMode: Literal["sandbox_only"]
    containsSensitiveRawData: Literal[False]
    countsByStatus: dict[NotificationAdapterSandboxStatus, int]
    deliveries: list[NotificationAdapterSandboxDelivery] = Field(max_length=200)
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    slotAlertsDelivered: Literal[False]


class NotificationAdapterSandboxHistoryResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    countsByStatus: dict[NotificationAdapterSandboxStatus, int]
    deliveries: list[NotificationAdapterSandboxDelivery] = Field(max_length=200)
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    slotAlertsDelivered: Literal[False]


class ProviderDeliveryReadinessResponse(ContractModel):
    blockedReasons: list[ProviderDeliveryBlockedReason] = Field(min_length=1, max_length=8)
    checkedAt: datetime
    containsSensitiveRawData: Literal[False]
    credentialStorageMode: Literal["not_configured"]
    deliveryBoundary: Literal["browser_digest_primary_provider_outbox_disabled"]
    externalNetworkCallAttempted: Literal[False]
    externalProviderDeliveryEnabled: Literal[False]
    liveProviderConfigured: Literal[False]
    nextRequiredProof: Literal["delivery_readiness_provider_configuration_not_implemented"]
    providerChannels: list[ProviderDeliveryChannel] = Field(min_length=3, max_length=3)
    providerSafeOutboxEnabled: Literal[True]
    safeDefaultDeliveryModes: list[Literal["browser", "digest"]] = Field(min_length=2, max_length=2)


class ProviderOutboxCreate(ContractModel):
    adapterMode: Literal["provider_safe_outbox"]
    channels: list[ProviderDeliveryChannel] = Field(min_length=1, max_length=3)
    containsSensitiveRawData: Literal[False]
    externalDeliveryEnabled: Literal[False]
    includeDigest: bool = False
    notificationIds: list[ContractId] | None = Field(default=None, max_length=100)
    recordedAt: datetime | None = None

    @field_validator("channels")
    @classmethod
    def normalize_channels(cls, value: list[ProviderDeliveryChannel]) -> list[ProviderDeliveryChannel]:
        return list(dict.fromkeys(value))


class ProviderOutboxPayload(ContractModel):
    actionLabel: Literal["Open tracker"]
    adapterMode: Literal["provider_safe_outbox"]
    availabilityClaim: Literal["community_report_not_official_confirmation"]
    body: SafeText
    channel: ProviderDeliveryChannel
    containsBookingConfirmation: Literal[False]
    containsSensitiveRawData: Literal[False]
    country: SafeText
    externalNetworkCallAttempted: Literal[False]
    matchedDates: list[date] = Field(min_length=1, max_length=60)
    postCity: SafeText
    providerEndpoint: Literal["disabled_by_default"]
    recipientRef: ContractId
    redactionLevel: Literal["no_secrets"]
    retryBackoffSeconds: int = Field(ge=60, le=3600)
    title: Literal["Community visa slot report"]
    unsubscribeAction: Literal["pause_or_delete_filter"]
    visaClass: SafeText


class ProviderOutboxDelivery(ContractModel):
    channel: ProviderDeliveryChannel
    containsSensitiveRawData: Literal[False]
    externalDeliveryEnabled: Literal[False]
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    notificationId: ContractId
    outboxDeliveryId: ContractId
    payload: ProviderOutboxPayload | None
    reason: ProviderOutboxReason
    recordedAt: datetime
    reportId: ContractId
    status: ProviderOutboxStatus
    subscriptionId: ContractId


class ProviderOutboxResponse(ContractModel):
    adapterMode: Literal["provider_safe_outbox"]
    containsSensitiveRawData: Literal[False]
    countsByStatus: dict[ProviderOutboxStatus, int]
    deliveries: list[ProviderOutboxDelivery] = Field(max_length=200)
    externalDeliveryEnabled: Literal[False]
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    slotAlertsDelivered: Literal[False]


class ProviderOutboxHistoryResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    countsByStatus: dict[ProviderOutboxStatus, int]
    deliveries: list[ProviderOutboxDelivery] = Field(max_length=200)
    externalDeliveryEnabled: Literal[False]
    externalNetworkCallAttempted: Literal[False]
    liveProviderConfigured: Literal[False]
    slotAlertsDelivered: Literal[False]


class ContributorConflictQuorum(ContractModel):
    currentIndependentContributors: int = Field(ge=0)
    met: bool
    requiredIndependentContributors: int = Field(default=2, ge=2)


class ContributorRateLimitPolicy(ContractModel):
    currentWindowReports: int = Field(ge=0)
    limited: bool
    maxReports: int = Field(ge=1)
    windowHours: int = Field(ge=1)


class ContributorAbuseAuditEvent(ContractModel):
    action: ContributorAbuseAuditAction
    containsSensitiveRawData: Literal[False]
    contributorId: str = Field(min_length=8, max_length=120)
    limitMaxReports: int = Field(ge=1)
    limitWindowHours: int = Field(ge=1)
    reason: ContributorAbuseAuditReason
    recentReportCount: int = Field(ge=0)
    recordedAt: datetime


class ContributorAbuseAuditResponse(ContractModel):
    auditEvents: list[ContributorAbuseAuditEvent] = Field(max_length=500)
    containsSensitiveRawData: Literal[False]


class ContributorModerationNoteCreate(ContractModel):
    containsSensitiveRawData: Literal[False]
    note: str = Field(min_length=4, max_length=320)
    reason: ContributorModerationReason
    reviewStatus: ContributorLocalReviewStatus

    @field_validator("note")
    @classmethod
    def reject_sensitive_note(cls, value: str) -> str:
        if _SENSITIVE_NOTE_PATTERN.search(value):
            raise ValueError("moderation note must not include credentials, tokens, MFA, raw page data, or screenshots")
        if _EMAIL_PATTERN.search(value) or _PHONE_PATTERN.search(value):
            raise ValueError("moderation note must not include personal contact data")
        return value


class ContributorModerationNote(ContributorModerationNoteCreate):
    contributorId: str = Field(min_length=8, max_length=120)
    noteId: ContractId
    recordedAt: datetime


class ContributorModerationNoteCreateResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    note: ContributorModerationNote


class ContributorModerationNotesResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    notes: list[ContributorModerationNote] = Field(max_length=500)


class ContributorIdentityAuditEvent(ContractModel):
    action: ContributorIdentityAuditAction
    containsSensitiveRawData: Literal[False]
    contributorId: str = Field(min_length=8, max_length=120)
    contributorKeyId: ContractId
    previousContributorKeyId: ContractId | None = None
    recordedAt: datetime
    rotationCount: int = Field(ge=0, le=100)


class ContributorTrustSummary(ContractModel):
    acceptedUniqueReports: int = Field(ge=0)
    abuseAuditEventCount: int = Field(ge=0)
    abuseReviewRequired: bool
    conflictQuorumPolicy: ContributorConflictQuorum
    conflictReports: int = Field(ge=0)
    contributorId: str = Field(min_length=8, max_length=120)
    duplicateReports: int = Field(ge=0)
    identityHealth: ContributorIdentityHealth
    identityRotationWarning: bool
    localReviewStatus: ContributorLocalReviewStatus
    localIdentitySeen: bool
    moderationNoteCount: int = Field(ge=0)
    notificationEligibleReports: int = Field(ge=0)
    piiStored: Literal[False]
    rateLimitPolicy: ContributorRateLimitPolicy
    recentReportCount: int = Field(ge=0)
    reputationStatus: ContributorReputationStatus
    staleReports: int = Field(ge=0)
    totalReports: int = Field(ge=0)


class ContributorTrustResponse(ContractModel):
    trust: ContributorTrustSummary


class PublicEstimateFixtureImportRequest(ContractModel):
    adapterMode: PublicEstimateAdapterMode
    capturedAt: datetime | None = None
    containsSensitiveRawData: Literal[False]
    country: SafeText
    estimateLabel: SafeText
    fixtureText: str = Field(min_length=1, max_length=4000)
    freshUntil: datetime | None = None
    parserVersion: str = Field(min_length=1, max_length=80)
    postCity: SafeText
    quarantineByDefault: Literal[True]
    sourceId: PublicEstimateSourceId
    sourceName: SafeText
    sourcePermission: Literal["public_estimate_context"]
    sourceUrl: str = Field(min_length=12, max_length=500)
    triggersSlotAlerts: Literal[False]
    visaClass: SafeText

    @field_validator("fixtureText")
    @classmethod
    def reject_sensitive_fixture_text(cls, value: str) -> str:
        if _SENSITIVE_NOTE_PATTERN.search(value):
            raise ValueError("fixtureText must not include credentials, tokens, MFA, raw page data, or screenshots")
        if _EMAIL_PATTERN.search(value) or _PHONE_PATTERN.search(value):
            raise ValueError("fixtureText must not include personal contact data")
        return value

    @field_validator("sourceUrl")
    @classmethod
    def require_http_fixture_source_url(cls, value: str) -> str:
        if not value.startswith(("https://", "http://")):
            raise ValueError("sourceUrl must be an HTTP(S) URL")
        return value


class PublicContextSummary(ContractModel):
    acceptedEstimateCount: int = Field(ge=0)
    alertTriggerAllowed: Literal[False]
    availabilityClaim: Literal["public_context_not_slot_availability"]
    contextId: ContractId
    country: SafeText
    freshUntil: datetime
    freshnessLabel: PublicContextFreshness
    latestCapturedAt: datetime
    latestEstimateLabel: SafeText
    latestEstimateValueDays: int = Field(ge=0, le=3650)
    parserStatuses: list[PublicEstimateParserStatus] = Field(max_length=8)
    postCity: SafeText
    quarantinedEstimateCount: int = Field(ge=0)
    recommendedUse: Literal["decision_context_only"]
    reviewNote: Literal["public_context_not_appointment_inventory"]
    slotAlertTriggerAttempted: Literal[False]
    sourceKind: PublicContextSourceKind
    sourceNames: list[SafeText] = Field(max_length=16)
    sourceUrls: list[str] = Field(max_length=16)
    staleEstimateCount: int = Field(ge=0)
    status: PublicContextStatus
    totalEstimateCount: int = Field(ge=1)
    triggersSlotAlerts: Literal[False]
    visaClass: SafeText


class PublicContextSummaryResponse(ContractModel):
    containsSensitiveRawData: Literal[False]
    contexts: list[PublicContextSummary] = Field(max_length=100)
    liveFetchAttempted: Literal[False]
    quarantinedContextCount: int = Field(ge=0)
    slotAlertsDelivered: Literal[False]
    slotAlertTriggerAttempted: Literal[False]
    sourcePolicy: "SourcePolicyRecord"


