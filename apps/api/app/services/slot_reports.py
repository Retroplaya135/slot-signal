from __future__ import annotations

import sqlite3
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import Settings
from app.schemas.domain import NotificationEvent
from app.schemas.slot_reports import (
    AlertDeliveryAckCreate,
    AlertDeliveryAckResponse,
    AlertDeliveryAuditEvent,
    AlertDigestDeliveryAckCreate,
    AlertDigestDeliveryAckResponse,
    AlertMatch,
    AlertNotificationDigestGroup,
    AlertPendingCleanupResponse,
    AlertSubscription,
    AlertSubscriptionAuditEvent,
    AlertSubscriptionCreate,
    AlertSubscriptionDeleteResponse,
    AlertSubscriptionUpdate,
    AlertSubscriptionUpdateResponse,
    ContributorAbuseAuditEvent,
    ContributorIdentityAuditEvent,
    ContributorIdentityRecord,
    ContributorIdentityResponse,
    ContributorIdentityUpsert,
    ContributorModerationNote,
    ContributorModerationNoteCreate,
    ContributorTrustSummary,
    NotificationAdapterSandboxCreate,
    NotificationAdapterSandboxDelivery,
    NotificationAdapterSandboxHistoryResponse,
    NotificationAdapterSandboxPayload,
    NotificationAdapterSandboxResponse,
    ProviderDeliveryReadinessResponse,
    ProviderOutboxCreate,
    ProviderOutboxDelivery,
    ProviderOutboxHistoryResponse,
    ProviderOutboxPayload,
    ProviderOutboxResponse,
    PublicContextSummary,
    PublicContextSummaryResponse,
    PublicEstimateFixtureImportRequest,
    PublicEstimateFixtureImportResponse,
    PublicEstimateSnapshot,
    PublicEstimateSnapshotCreate,
    SlotReport,
    SlotReportCreate,
    SlotReportLatestRow,
    SlotReportTrust,
    SourcePolicyRecord,
    SourcePolicyResponse,
)

SLOT_REPORT_FRESHNESS_HOURS = 6
SLOT_SIGNAL_SCHEMA_VERSION = 6
CONTRIBUTOR_RECENT_WINDOW_HOURS = 24
CONTRIBUTOR_RATE_LIMIT_WINDOW_HOURS = 1
CONTRIBUTOR_REPORT_RATE_LIMIT_PER_WINDOW = 5
CONFLICT_QUORUM_REQUIRED_CONTRIBUTORS = 2
NOTIFICATION_RETRY_BASE_SECONDS = 60
NOTIFICATION_RETRY_MAX_SECONDS = 3600
PUBLIC_ESTIMATE_FIXTURE_FRESH_HOURS = 24
SLOT_REPORT_QUALITY_NOTIFICATION_THRESHOLD = 65
PUBLIC_ESTIMATE_SOURCE_ALLOWLIST = {
    "travel_state_global_wait_times": {
        "sourceName": "Department of State Global Visa Wait Times",
        "urlPrefixes": (
            "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times",
        ),
    },
}
SOURCE_POLICY_REGISTRY: tuple[dict[str, object], ...] = (
    {
        "alertEligibility": "alert_allowed",
        "allowedInMvp": True,
        "appointmentChangingActionAllowed": False,
        "canTriggerSlotAlerts": True,
        "credentialAccessAllowed": False,
        "officialAvailabilitySource": False,
        "policyReason": "Community reports are sanitized visible metadata and may trigger alerts after quality checks.",
        "portalAutomationAllowed": False,
        "proofGate": "quality_and_source_policy",
        "requiresWrittenAuthorization": False,
        "sourceKind": "community_report",
        "sourceLane": "community_signal",
    },
    {
        "alertEligibility": "alert_allowed",
        "allowedInMvp": True,
        "appointmentChangingActionAllowed": False,
        "canTriggerSlotAlerts": True,
        "credentialAccessAllowed": False,
        "officialAvailabilitySource": False,
        "policyReason": "Manual reports are user-visible metadata and may trigger alerts after quality checks.",
        "portalAutomationAllowed": False,
        "proofGate": "quality_and_source_policy",
        "requiresWrittenAuthorization": False,
        "sourceKind": "manual_report",
        "sourceLane": "manual_visible_metadata",
    },
    {
        "alertEligibility": "context_only",
        "allowedInMvp": True,
        "appointmentChangingActionAllowed": False,
        "canTriggerSlotAlerts": False,
        "credentialAccessAllowed": False,
        "officialAvailabilitySource": False,
        "policyReason": "Public estimates are decision context only and never appointment slot availability.",
        "portalAutomationAllowed": False,
        "proofGate": "public_context_no_alert",
        "requiresWrittenAuthorization": False,
        "sourceKind": "public_estimate",
        "sourceLane": "public_context",
    },
    {
        "alertEligibility": "sandbox_only",
        "allowedInMvp": True,
        "appointmentChangingActionAllowed": False,
        "canTriggerSlotAlerts": False,
        "credentialAccessAllowed": False,
        "officialAvailabilitySource": False,
        "policyReason": "Sandbox adapter payloads are reviewer artifacts and cannot create new alert matches.",
        "portalAutomationAllowed": False,
        "proofGate": "adapter_sandbox_no_delivery",
        "requiresWrittenAuthorization": False,
        "sourceKind": "notification_adapter_sandbox",
        "sourceLane": "sandbox_payload",
    },
    {
        "alertEligibility": "blocked_pending_authorization",
        "allowedInMvp": False,
        "appointmentChangingActionAllowed": False,
        "canTriggerSlotAlerts": False,
        "credentialAccessAllowed": False,
        "officialAvailabilitySource": False,
        "policyReason": "Partner/API sources need written source authorization before they can trigger alerts.",
        "portalAutomationAllowed": False,
        "proofGate": "written_source_authorization_required",
        "requiresWrittenAuthorization": True,
        "sourceKind": "authorized_partner_api",
        "sourceLane": "authorized_source_pending_evidence",
    },
)


class ContributorRateLimitExceeded(Exception):
    def __init__(self, audit_event: ContributorAbuseAuditEvent) -> None:
        super().__init__("Contributor exceeded non-PII slot report rate limit.")
        self.audit_event = audit_event


class PublicEstimateSourceNotAllowed(Exception):
    def __init__(self, source_id: str, source_url: str) -> None:
        super().__init__("Public-estimate fixture source is not allowlisted.")
        self.source_id = source_id
        self.source_url = source_url


class SourcePolicyViolation(Exception):
    def __init__(self, source_policy: SourcePolicyRecord) -> None:
        super().__init__("Source is not authorized to trigger slot alerts.")
        self.source_policy = source_policy


def _new_id(prefix: str) -> str:
    return f"{prefix}:{uuid4().hex[:20]}"


def _matches_text(left: str, right: str) -> bool:
    return left.casefold() == right.casefold()


def _matching_dates(report: SlotReport, start_date: date | None, end_date: date | None) -> list[date]:
    dates = []
    for available_date in report.availableDates:
        if start_date and available_date < start_date:
            continue
        if end_date and available_date > end_date:
            continue
        dates.append(available_date)
    return dates


def _append_unique(values: list[str], value: str) -> None:
    if value not in values:
        values.append(value)


def _clamp_quality_score(score: int) -> int:
    return max(0, min(score, 100))


