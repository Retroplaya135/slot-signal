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


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _new_id(prefix: str) -> str:
    return f"{prefix}:{uuid4().hex[:20]}"


def _safe_suffix(value: str) -> str:
    return "".join(character if character.isalnum() or character in "._:-" else ":" for character in value)[:64]


def _safe_key_part(value: str) -> str:
    normalized = value.strip().casefold()
    return "".join(character if character.isalnum() else ":" for character in normalized).strip(":")[:80] or "unknown"


def _matches_text(left: str, right: str) -> bool:
    return left.casefold() == right.casefold()


def _slot_scope_key(report: SlotReport | SlotReportCreate) -> tuple[str, str, str]:
    return (
        report.country.casefold(),
        report.postCity.casefold(),
        report.visaClass.casefold(),
    )


def _dedupe_key(report: SlotReport | SlotReportCreate) -> str:
    date_part = ":".join(str(available_date) for available_date in report.availableDates)
    return (
        "slot-report-dedupe:"
        f"{_safe_key_part(report.country)}:"
        f"{_safe_key_part(report.postCity)}:"
        f"{_safe_key_part(report.visaClass)}:"
        f"{date_part}"
    )[:240]


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


def source_policy_records() -> list[SourcePolicyRecord]:
    return [SourcePolicyRecord.model_validate(record) for record in SOURCE_POLICY_REGISTRY]


def source_policy_record(source_kind: str) -> SourcePolicyRecord:
    for record in source_policy_records():
        if record.sourceKind == source_kind:
            return record
    return SourcePolicyRecord.model_validate(
        {
            "alertEligibility": "blocked_pending_authorization",
            "allowedInMvp": False,
            "appointmentChangingActionAllowed": False,
            "canTriggerSlotAlerts": False,
            "credentialAccessAllowed": False,
            "officialAvailabilitySource": False,
            "policyReason": "Unknown sources require explicit source-policy review before alert eligibility.",
            "portalAutomationAllowed": False,
            "proofGate": "written_source_authorization_required",
            "requiresWrittenAuthorization": True,
            "sourceKind": "authorized_partner_api",
            "sourceLane": "authorized_source_pending_evidence",
        }
    )


class InMemorySlotReportStore:
    def __init__(self) -> None:
        self._contributor_abuse_audit: list[ContributorAbuseAuditEvent] = []
        self._contributor_identities: dict[str, ContributorIdentityRecord] = {}
        self._contributor_identity_audit: list[ContributorIdentityAuditEvent] = []
        self._contributor_moderation_notes: list[ContributorModerationNote] = []
        self._delivery_audit: dict[str, list[AlertDeliveryAuditEvent]] = {}
        self._delivery_status_by_notification_id: dict[str, str] = {}
        self._notification_adapter_sandbox_audit: list[NotificationAdapterSandboxDelivery] = []
        self._pending_match_keys: set[tuple[str, str]] = set()
        self._pending_matches: list[AlertMatch] = []
        self._provider_outbox: list[ProviderOutboxDelivery] = []
        self._public_estimates: list[PublicEstimateSnapshot] = []
        self._reports: list[SlotReport] = []
        self._subscription_audit: list[AlertSubscriptionAuditEvent] = []
        self._subscriptions: dict[str, AlertSubscription] = {}

    def create_report(self, payload: SlotReportCreate, now: datetime | None = None) -> SlotReport:
        stored_at = _utc(now or _now())
        source_policy = source_policy_record(payload.sourceKind)
        if not source_policy.canTriggerSlotAlerts:
            raise SourcePolicyViolation(source_policy)
        if payload.contributorId:
            self._enforce_contributor_rate_limit(payload.contributorId, stored_at)
        captured_at = _utc(payload.capturedAt)
        fresh_until = captured_at + timedelta(hours=SLOT_REPORT_FRESHNESS_HOURS)
        freshness = "fresh" if fresh_until >= stored_at else "stale"
        report_id = _new_id("slot-report")
        trust = self._build_trust(
            captured_at=captured_at,
            fresh_until=fresh_until,
            freshness=freshness,
            payload=payload,
            report_id=report_id,
            stored_at=stored_at,
        )
        report = SlotReport.model_validate(
            {
                **payload.model_dump(),
                "availabilityClaim": "community_report_not_official_confirmation",
                "capturedAt": captured_at,
                "freshUntil": fresh_until,
                "freshness": freshness,
                "reportId": report_id,
                "storedAt": stored_at,
                "trust": trust,
            }
        )
        self._reports.append(report)
        if report.trust.provenance.contributorId:
            self._record_contributor_abuse_audit(
                self._contributor_audit_event(
                    action="report_accepted",
                    contributor_id=report.trust.provenance.contributorId,
                    now=stored_at,
                    reason="accepted_under_rate_limit",
                    recent_report_count=self._contributor_window_report_count(report.trust.provenance.contributorId, stored_at),
                )
            )
            if self._contributor_conflict_count(report.trust.provenance.contributorId) >= 3:
                self._record_contributor_abuse_audit(
                    self._contributor_audit_event(
                        action="abuse_review_flagged",
                        contributor_id=report.trust.provenance.contributorId,
                        now=stored_at,
                        reason="conflict_watch_threshold_reached",
                        recent_report_count=self._contributor_window_report_count(
                            report.trust.provenance.contributorId,
                            stored_at,
                        ),
                    )
                )
        self._queue_quality_eligible_scope_matches(report, stored_at)
        return report

    def latest_reports(
        self,
        *,
        country: str | None = None,
        include_stale: bool = False,
        include_low_trust: bool = False,
        now: datetime | None = None,
        post_city: str | None = None,
        target_end_date: date | None = None,
        target_start_date: date | None = None,
        visa_class: str | None = None,
    ) -> list[SlotReportLatestRow]:
        checked_at = _utc(now or _now())
        rows: list[SlotReportLatestRow] = []
        for report in self._reports:
            refreshed = self._with_quality(self._with_freshness(report, checked_at), checked_at)
            if not include_stale and refreshed.freshness == "stale":
                continue
            if not include_low_trust and (
                refreshed.trust.status != "accepted_unique" or not refreshed.trust.eligibleForNotification
            ):
                continue
            if country and not _matches_text(refreshed.country, country):
                continue
            if post_city and not _matches_text(refreshed.postCity, post_city):
                continue
            if visa_class and not _matches_text(refreshed.visaClass, visa_class):
                continue
            matched_dates = _matching_dates(refreshed, target_start_date, target_end_date)
            if not matched_dates:
                continue
            rows.append(
                SlotReportLatestRow.model_validate(
                    {
                        **refreshed.model_dump(),
                        "matchedDates": matched_dates,
                    }
                )
            )
        return sorted(
            rows,
            key=lambda row: (row.trust.eligibleForNotification, row.trust.qualityScore, row.capturedAt),
            reverse=True,
        )

    def create_subscription(self, payload: AlertSubscriptionCreate, now: datetime | None = None) -> AlertSubscription:
        created_at = _utc(now or _now())
        status = "active" if payload.active else "paused"
        subscription = AlertSubscription.model_validate(
            {
                **payload.model_dump(),
                "createdAt": created_at,
                "pausedAt": None if payload.active else created_at,
                "subscriptionId": _new_id("slot-alert"),
                "status": status,
                "updatedAt": created_at,
            }
        )
        self._subscriptions[subscription.subscriptionId] = subscription
        self._record_subscription_audit(
            AlertSubscriptionAuditEvent.model_validate(
                {
                    "action": "created",
                    "auditReason": None,
                    "containsSensitiveRawData": False,
                    "recordedAt": created_at,
                    "subscriptionId": subscription.subscriptionId,
                }
            )
        )
        self._queue_matches_for_subscription(subscription, created_at)
        return subscription

    def list_subscriptions(self, *, include_deleted: bool = False) -> list[AlertSubscription]:
        subscriptions = list(self._subscriptions.values())
        if not include_deleted:
            subscriptions = [subscription for subscription in subscriptions if subscription.status != "deleted"]
        return sorted(subscriptions, key=lambda subscription: subscription.createdAt, reverse=True)

    def get_subscription(self, subscription_id: str) -> AlertSubscription | None:
        return self._subscriptions.get(subscription_id)

    def subscription_audit(self, subscription_id: str | None = None) -> list[AlertSubscriptionAuditEvent]:
        events = self._subscription_audit
        if subscription_id is not None:
            events = [event for event in events if event.subscriptionId == subscription_id]
        return sorted(events, key=lambda event: event.recordedAt)

    def update_subscription(
        self,
        subscription_id: str,
        payload: AlertSubscriptionUpdate,
        now: datetime | None = None,
    ) -> AlertSubscriptionUpdateResponse | None:
        current = self.get_subscription(subscription_id)
        if current is None or current.status == "deleted":
            return None

        updated_at = _utc(now or _now())
        next_active = current.active if payload.active is None else payload.active
        next_cooldown = current.cooldownMinutes if payload.cooldownMinutes is None else payload.cooldownMinutes
        next_delivery_mode = current.deliveryMode if payload.deliveryMode is None else payload.deliveryMode
        next_digest_window = current.digestWindowMinutes if payload.digestWindowMinutes is None else payload.digestWindowMinutes
        action = self._subscription_update_action(
            current,
            next_active,
            next_cooldown,
            next_delivery_mode,
            next_digest_window,
        )
        next_status = "active" if next_active else "paused"
        next_subscription = current.model_copy(
            update={
                "active": next_active,
                "cooldownMinutes": next_cooldown,
                "deletedAt": None,
                "deliveryMode": next_delivery_mode,
                "digestWindowMinutes": next_digest_window,
                "pausedAt": None if next_active else (current.pausedAt or updated_at),
                "status": next_status,
                "updatedAt": updated_at,
            }
        )
        self._subscriptions[subscription_id] = next_subscription
        audit_event = AlertSubscriptionAuditEvent.model_validate(
            {
                "action": action,
                "auditReason": payload.auditReason,
                "containsSensitiveRawData": False,
                "recordedAt": updated_at,
                "subscriptionId": subscription_id,
            }
        )
        self._record_subscription_audit(audit_event)
        if next_subscription.status == "active":
            self._queue_matches_for_subscription(next_subscription, updated_at)
        return AlertSubscriptionUpdateResponse.model_validate(
            {
                "auditEvent": audit_event,
                "subscription": next_subscription,
            }
        )

    def delete_subscription(
        self,
        subscription_id: str,
        *,
        audit_reason: str | None = None,
        now: datetime | None = None,
    ) -> AlertSubscriptionDeleteResponse | None:
        current = self.get_subscription(subscription_id)
        if current is None:
            return None
        deleted_at = _utc(now or _now())
        removed_pending = sum(1 for match in self._pending_matches if match.subscriptionId == subscription_id)
        subscription = current.model_copy(
            update={
                "active": False,
                "deletedAt": deleted_at,
                "pausedAt": current.pausedAt or deleted_at,
                "status": "deleted",
                "updatedAt": deleted_at,
            }
        )
        self._subscriptions[subscription_id] = subscription
        self._pending_matches = [match for match in self._pending_matches if match.subscriptionId != subscription_id]
        self._rebuild_pending_match_keys()
        audit_event = AlertSubscriptionAuditEvent.model_validate(
            {
                "action": "deleted",
                "auditReason": audit_reason,
                "containsSensitiveRawData": False,
                "recordedAt": deleted_at,
                "subscriptionId": subscription_id,
            }
        )
        self._record_subscription_audit(audit_event)
        return AlertSubscriptionDeleteResponse.model_validate(
            {
                "auditEvent": audit_event,
                "deleted": True,
                "removedPendingMatches": removed_pending,
                "subscription": subscription,
            }
        )

    def matches_for_subscription(self, subscription_id: str, now: datetime | None = None) -> list[AlertMatch]:
        subscription = self.get_subscription(subscription_id)
        if subscription is None or not subscription.active or subscription.status != "active":
            return []
        checked_at = _utc(now or _now())
        matches: list[AlertMatch] = []
        for report in self._reports:
            match = self._match_report_for_subscription(report, subscription, checked_at)
            if match:
                matches.append(match)
        return sorted(matches, key=lambda match: match.reportId, reverse=True)

    def pending_notification_matches(
        self,
        *,
        include_backoff: bool = False,
        include_digest: bool = False,
        now: datetime | None = None,
    ) -> list[AlertMatch]:
        checked_at = _utc(now or _now())
        matches = []
        for match in self._pending_matches:
            hydrated = self._with_delivery_status(match, checked_at)
            if hydrated.notificationEvent.deliveryStatus in {"sent", "suppressed"}:
                continue
            if hydrated.deliveryMode == "digest" and not include_digest:
                continue
            if hydrated.nextRetryAt and hydrated.nextRetryAt > checked_at and not include_backoff:
                continue
            matches.append(hydrated)
        return matches

    def digest_notification_groups(self, now: datetime | None = None) -> list[AlertNotificationDigestGroup]:
        digest_matches = self.pending_notification_matches(include_digest=True, now=now)
        grouped: dict[str, list[AlertMatch]] = {}
        for match in digest_matches:
            if match.deliveryMode != "digest":
                continue
            grouped.setdefault(match.subscriptionId, []).append(match)

        groups = []
        for subscription_id, matches in grouped.items():
            subscription = self.get_subscription(subscription_id)
            if subscription is None:
                continue
            groups.append(
                AlertNotificationDigestGroup.model_validate(
                    {
                        "deliveryMode": "digest",
                        "digestWindowMinutes": subscription.digestWindowMinutes,
                        "latestMatchedAt": max(match.notificationEvent.createdAt for match in matches),
                        "matches": sorted(matches, key=lambda match: match.notificationEvent.createdAt, reverse=True),
                        "pendingCount": len(matches),
                        "subscriptionId": subscription_id,
                    }
                )
            )
        return sorted(groups, key=lambda group: group.latestMatchedAt, reverse=True)

    def cleanup_stale_pending_matches(
        self,
        *,
        checked_at: datetime | None = None,
        cutoff_before: datetime | None = None,
        dry_run: bool = True,
    ) -> AlertPendingCleanupResponse:
        cleanup_at = _utc(checked_at or _now())
        cutoff = _utc(cutoff_before) if cutoff_before else None
        stale_notification_ids = []
        reports_by_id = {report.reportId: report for report in self._reports}
        for match in self._pending_matches:
            report = reports_by_id.get(match.reportId)
            if report is None:
                stale_notification_ids.append(match.notificationEvent.notificationId)
                continue
            refreshed = self._with_freshness(report, cleanup_at)
            if refreshed.freshness == "stale" or (cutoff and match.notificationEvent.createdAt < cutoff):
                stale_notification_ids.append(match.notificationEvent.notificationId)

        if not dry_run and stale_notification_ids:
            stale_id_set = set(stale_notification_ids)
            self._pending_matches = [
                match
                for match in self._pending_matches
                if match.notificationEvent.notificationId not in stale_id_set
            ]
            self._rebuild_pending_match_keys()

        return AlertPendingCleanupResponse.model_validate(
            {
                "checkedAt": cleanup_at,
                "cleanupReason": "stale_pending_cleanup",
                "containsSensitiveRawData": False,
                "deletedPendingMatches": 0 if dry_run else len(stale_notification_ids),
                "dryRun": dry_run,
                "matchedPendingMatches": len(stale_notification_ids),
            }
        )

    def acknowledge_delivery(
        self,
        notification_id: str,
        payload: AlertDeliveryAckCreate,
        now: datetime | None = None,
    ) -> AlertDeliveryAckResponse | None:
        existing = self._latest_delivery_audit(notification_id)
        if existing and existing.deliveryStatus in {"sent", "suppressed"}:
            return AlertDeliveryAckResponse.model_validate(
                {
                    "deliveryAudit": existing,
                    "notificationEvent": existing.notificationEvent,
                    "replayed": True,
                }
            )

        match = self._find_match_by_notification_id(notification_id)
        if match is None:
            return None

        acknowledged_at = _utc(payload.acknowledgedAt or now or _now())
        notification_event = match.notificationEvent.model_copy(update={"deliveryStatus": payload.deliveryStatus})
        audit_event = AlertDeliveryAuditEvent.model_validate(
            {
                "acknowledgedAt": acknowledged_at,
                "containsSensitiveRawData": False,
                "deliveryAttemptedInBrowser": payload.deliveryAttemptedInBrowser,
                "deliveryStatus": payload.deliveryStatus,
                "notificationEvent": notification_event,
                "notificationId": notification_id,
                "reason": payload.reason,
                "reportId": match.reportId,
                "subscriptionId": match.subscriptionId,
            }
        )
        self._record_delivery_audit(audit_event)
        if payload.deliveryStatus in {"sent", "suppressed"}:
            self._remove_pending_notification(notification_id)
        return AlertDeliveryAckResponse.model_validate(
            {
                "deliveryAudit": audit_event,
                "notificationEvent": notification_event,
                "replayed": False,
            }
        )

    def acknowledge_digest_delivery(
        self,
        subscription_id: str,
        payload: AlertDigestDeliveryAckCreate,
        now: datetime | None = None,
    ) -> AlertDigestDeliveryAckResponse | None:
        if self.get_subscription(subscription_id) is None:
            return None

        acknowledged_at = _utc(payload.acknowledgedAt or now or _now())
        digest_matches = [
            match
            for match in self.pending_notification_matches(
                include_backoff=True,
                include_digest=True,
                now=acknowledged_at,
            )
            if match.subscriptionId == subscription_id and match.deliveryMode == "digest"
        ]
        audits: list[AlertDeliveryAuditEvent] = []
        replayed_count = 0

        if not digest_matches:
            prior_audits = [
                event
                for event in self.delivery_history(limit=1000)
                if event.subscriptionId == subscription_id
                and event.reason in {"digest_summary_sent", "digest_suppressed_by_user"}
            ]
            return AlertDigestDeliveryAckResponse.model_validate(
                {
                    "acknowledgedAt": acknowledged_at,
                    "acknowledgedCount": 0,
                    "containsSensitiveRawData": False,
                    "deliveryAudits": prior_audits,
                    "deliveryStatus": payload.deliveryStatus,
                    "reason": payload.reason,
                    "replayedCount": len(prior_audits),
                    "subscriptionId": subscription_id,
                }
            )

        for match in digest_matches:
            ack_response = self.acknowledge_delivery(
                match.notificationEvent.notificationId,
                AlertDeliveryAckCreate.model_validate(
                    {
                        "acknowledgedAt": acknowledged_at,
                        "containsSensitiveRawData": False,
                        "deliveryAttemptedInBrowser": False,
                        "deliveryStatus": payload.deliveryStatus,
                        "reason": payload.reason,
                    }
                ),
                now=acknowledged_at,
            )
            if ack_response is None:
                continue
            audits.append(ack_response.deliveryAudit)
            if ack_response.replayed:
                replayed_count += 1

        return AlertDigestDeliveryAckResponse.model_validate(
            {
                "acknowledgedAt": acknowledged_at,
                "acknowledgedCount": len(audits) - replayed_count,
                "containsSensitiveRawData": False,
                "deliveryAudits": audits,
                "deliveryStatus": payload.deliveryStatus,
                "reason": payload.reason,
                "replayedCount": replayed_count,
                "subscriptionId": subscription_id,
            }
        )

    def delivery_audit(self, notification_id: str) -> list[AlertDeliveryAuditEvent]:
        return list(self._delivery_audit.get(notification_id, []))

    def delivery_history(self, limit: int = 100) -> list[AlertDeliveryAuditEvent]:
        events = [event for audit_events in self._delivery_audit.values() for event in audit_events]
        return sorted(events, key=lambda event: event.acknowledgedAt, reverse=True)[:limit]

    def sandbox_notification_adapters(
        self,
        payload: NotificationAdapterSandboxCreate,
        now: datetime | None = None,
    ) -> NotificationAdapterSandboxResponse:
        recorded_at = _utc(payload.recordedAt or now or _now())
        notification_filter = set(payload.notificationIds or [])
        matches = self.pending_notification_matches(
            include_backoff=True,
            include_digest=payload.includeDigest,
            now=recorded_at,
        )
        if notification_filter:
            matches = [
                match
                for match in matches
                if match.notificationEvent.notificationId in notification_filter
            ]

        deliveries: list[NotificationAdapterSandboxDelivery] = []
        for match in matches:
            subscription = self.get_subscription(match.subscriptionId)
            report = self._report_by_id(match.reportId)
            if subscription is None or report is None:
                continue
            for channel in payload.channels:
                delivery_payload: NotificationAdapterSandboxPayload | None = None
                status = "recorded"
                reason = "sandbox_payload_recorded"
                if channel not in subscription.channels:
                    status = "skipped"
                    reason = "channel_not_subscribed"
                elif not match.reportTrust.eligibleForNotification:
                    status = "suppressed"
                    reason = "not_eligible"
                else:
                    delivery_payload = self._notification_adapter_sandbox_payload(
                        channel=channel,
                        match=match,
                        report=report,
                    )
                deliveries.append(
                    NotificationAdapterSandboxDelivery.model_validate(
                        {
                            "channel": channel,
                            "containsSensitiveRawData": False,
                            "externalNetworkCallAttempted": False,
                            "liveProviderConfigured": False,
                            "notificationId": match.notificationEvent.notificationId,
                            "payload": delivery_payload,
                            "reason": reason,
                            "recordedAt": recorded_at,
                            "reportId": match.reportId,
                            "sandboxDeliveryId": _new_id("sandbox-delivery"),
                            "status": status,
                            "subscriptionId": match.subscriptionId,
                        }
                    )
                )

        self._notification_adapter_sandbox_audit.extend(deliveries)
        return NotificationAdapterSandboxResponse.model_validate(
            {
                "adapterMode": "sandbox_only",
                "containsSensitiveRawData": False,
                "countsByStatus": self._notification_adapter_sandbox_counts(deliveries),
                "deliveries": deliveries,
                "externalNetworkCallAttempted": False,
                "liveProviderConfigured": False,
                "slotAlertsDelivered": False,
            }
        )

    def notification_adapter_sandbox_history(self, limit: int = 100) -> NotificationAdapterSandboxHistoryResponse:
        deliveries = sorted(
            self._notification_adapter_sandbox_audit,
            key=lambda delivery: delivery.recordedAt,
            reverse=True,
        )[:limit]
        return NotificationAdapterSandboxHistoryResponse.model_validate(
            {
                "containsSensitiveRawData": False,
                "countsByStatus": self._notification_adapter_sandbox_counts(deliveries),
                "deliveries": deliveries,
                "externalNetworkCallAttempted": False,
                "liveProviderConfigured": False,
                "slotAlertsDelivered": False,
            }
        )

    def provider_delivery_readiness(self, now: datetime | None = None) -> ProviderDeliveryReadinessResponse:
        return ProviderDeliveryReadinessResponse.model_validate(
            {
                "blockedReasons": [
                    "external_provider_delivery_disabled_by_default",
                    "provider_credentials_not_configured",
                ],
                "checkedAt": _utc(now or _now()),
                "containsSensitiveRawData": False,
                "credentialStorageMode": "not_configured",
                "deliveryBoundary": "browser_digest_primary_provider_outbox_disabled",
                "externalNetworkCallAttempted": False,
                "externalProviderDeliveryEnabled": False,
                "liveProviderConfigured": False,
                "nextRequiredProof": "delivery_readiness_provider_configuration_not_implemented",
                "providerChannels": ["email", "telegram", "slack"],
                "providerSafeOutboxEnabled": True,
                "safeDefaultDeliveryModes": ["browser", "digest"],
            }
        )

    def create_provider_outbox(
        self,
        payload: ProviderOutboxCreate,
        now: datetime | None = None,
    ) -> ProviderOutboxResponse:
        recorded_at = _utc(payload.recordedAt or now or _now())
        notification_filter = set(payload.notificationIds or [])
        matches = self.pending_notification_matches(
            include_backoff=True,
            include_digest=payload.includeDigest,
            now=recorded_at,
        )
        if notification_filter:
            matches = [
                match
                for match in matches
                if match.notificationEvent.notificationId in notification_filter
            ]

        deliveries: list[ProviderOutboxDelivery] = []
        for match in matches:
            subscription = self.get_subscription(match.subscriptionId)
            report = self._report_by_id(match.reportId)
            for channel in payload.channels:
                delivery_payload: ProviderOutboxPayload | None = None
                status = "queued_disabled"
                reason = "provider_disabled_by_default"
                if subscription is None or channel not in subscription.channels:
                    status = "skipped"
                    reason = "channel_not_subscribed"
                elif report is None or not match.reportTrust.eligibleForNotification:
                    status = "suppressed"
                    reason = "not_eligible"
                else:
                    delivery_payload = self._provider_outbox_payload(
                        channel=channel,
                        match=match,
                        report=report,
                    )
                deliveries.append(
                    ProviderOutboxDelivery.model_validate(
                        {
                            "channel": channel,
                            "containsSensitiveRawData": False,
                            "externalDeliveryEnabled": False,
                            "externalNetworkCallAttempted": False,
                            "liveProviderConfigured": False,
                            "notificationId": match.notificationEvent.notificationId,
                            "outboxDeliveryId": _new_id("provider-outbox"),
                            "payload": delivery_payload,
                            "reason": reason,
                            "recordedAt": recorded_at,
                            "reportId": match.reportId,
                            "status": status,
                            "subscriptionId": match.subscriptionId,
                        }
                    )
                )

        self._provider_outbox.extend(deliveries)
        return ProviderOutboxResponse.model_validate(
            {
                "adapterMode": "provider_safe_outbox",
                "containsSensitiveRawData": False,
                "countsByStatus": self._provider_outbox_counts(deliveries),
                "deliveries": deliveries,
                "externalDeliveryEnabled": False,
                "externalNetworkCallAttempted": False,
                "liveProviderConfigured": False,
                "slotAlertsDelivered": False,
            }
        )

    def provider_outbox_history(self, limit: int = 100) -> ProviderOutboxHistoryResponse:
        deliveries = sorted(
            self._provider_outbox,
            key=lambda delivery: delivery.recordedAt,
            reverse=True,
        )[:limit]
        return ProviderOutboxHistoryResponse.model_validate(
            {
                "containsSensitiveRawData": False,
                "countsByStatus": self._provider_outbox_counts(deliveries),
                "deliveries": deliveries,
                "externalDeliveryEnabled": False,
                "externalNetworkCallAttempted": False,
                "liveProviderConfigured": False,
                "slotAlertsDelivered": False,
            }
        )

    def upsert_contributor_identity(
        self,
        contributor_id: str,
        payload: ContributorIdentityUpsert,
        now: datetime | None = None,
    ) -> ContributorIdentityResponse:
        recorded_at = _utc(now or _now())
        first_seen_at = _utc(payload.createdAt)
        last_seen_at = _utc(payload.lastSeenAt or recorded_at)
        existing = self._contributor_identities.get(contributor_id)
        previous_key_id = existing.contributorKeyId if existing else None
        action = "created"
        if existing is not None:
            first_seen_at = existing.firstSeenAt
            action = "seen"
            if existing.contributorKeyId != payload.contributorKeyId or payload.rotationCount > existing.rotationCount:
                action = "rotated"

        identity_health = self._contributor_identity_health(
            action=action,
            contributor_id=contributor_id,
            rotation_count=payload.rotationCount,
        )
        identity = ContributorIdentityRecord.model_validate(
            {
                **payload.model_dump(),
                "contributorId": contributor_id,
                "firstSeenAt": first_seen_at,
                "identityHealth": identity_health,
                "lastSeenAt": last_seen_at,
                "rotationWarning": payload.rotationCount > 0 or action == "rotated",
            }
        )
        audit_event = ContributorIdentityAuditEvent.model_validate(
            {
                "action": action,
                "containsSensitiveRawData": False,
                "contributorId": contributor_id,
                "contributorKeyId": payload.contributorKeyId,
                "previousContributorKeyId": previous_key_id if action == "rotated" else None,
                "recordedAt": recorded_at,
                "rotationCount": payload.rotationCount,
            }
        )
        self._contributor_identities[contributor_id] = identity
        self._record_contributor_identity_audit(audit_event)
        return ContributorIdentityResponse.model_validate(
            {
                "auditEvents": self.contributor_identity_audit(contributor_id),
                "containsSensitiveRawData": False,
                "identity": identity,
            }
        )

    def contributor_identity(self, contributor_id: str) -> ContributorIdentityRecord | None:
        return self._contributor_identities.get(contributor_id)

    def contributor_identity_audit(self, contributor_id: str | None = None) -> list[ContributorIdentityAuditEvent]:
        events = self._contributor_identity_audit
        if contributor_id is not None:
            events = [event for event in events if event.contributorId == contributor_id]
        return sorted(events, key=lambda event: event.recordedAt)

    def add_contributor_moderation_note(
        self,
        contributor_id: str,
        payload: ContributorModerationNoteCreate,
        now: datetime | None = None,
    ) -> ContributorModerationNote:
        recorded_at = _utc(now or _now())
        note = ContributorModerationNote.model_validate(
            {
                **payload.model_dump(),
                "contributorId": contributor_id,
                "noteId": _new_id("contributor-note"),
                "recordedAt": recorded_at,
            }
        )
        self._record_contributor_moderation_note(note)
        return note

    def contributor_moderation_notes(self, contributor_id: str | None = None) -> list[ContributorModerationNote]:
        notes = self._contributor_moderation_notes
        if contributor_id is not None:
            notes = [note for note in notes if note.contributorId == contributor_id]
        return sorted(notes, key=lambda note: note.recordedAt)

    def _contributor_local_review_status(self, contributor_id: str) -> str:
        moderation_notes = self.contributor_moderation_notes(contributor_id)
        return moderation_notes[-1].reviewStatus if moderation_notes else "clear"

    def contributor_trust(self, contributor_id: str, now: datetime | None = None) -> ContributorTrustSummary:
        checked_at = _utc(now or _now())
        contributor_reports = [
            report
            for report in self._reports
            if report.trust.provenance.contributorId == contributor_id
        ]
        status_counts = {
            "accepted_conflict": 0,
            "accepted_duplicate": 0,
            "accepted_unique": 0,
            "stale_suppressed": 0,
        }
        for report in contributor_reports:
            status_counts[report.trust.status] += 1
        recent_cutoff = checked_at - timedelta(hours=CONTRIBUTOR_RECENT_WINDOW_HOURS)
        recent_count = sum(1 for report in contributor_reports if report.storedAt >= recent_cutoff)
        rate_window_count = self._contributor_window_report_count(contributor_id, checked_at)
        independent_count = self._max_independent_contributors_for_contributor(contributor_id)
        reputation_status = "new" if len(contributor_reports) < 2 else "normal"
        if status_counts["accepted_conflict"] >= 3:
            reputation_status = "watch"
        rate_limited = rate_window_count >= CONTRIBUTOR_REPORT_RATE_LIMIT_PER_WINDOW
        if any(event.action == "rate_limited" for event in self.contributor_abuse_audit(contributor_id)):
            reputation_status = "restricted" if rate_limited else reputation_status
        moderation_notes = self.contributor_moderation_notes(contributor_id)
        local_review_status = self._contributor_local_review_status(contributor_id)
        if local_review_status == "restricted":
            reputation_status = "restricted"
        elif local_review_status == "watch" and reputation_status not in {"restricted"}:
            reputation_status = "watch"
        identity = self.contributor_identity(contributor_id)
        identity_health = identity.identityHealth if identity else "not_registered"
        identity_rotation_warning = identity.rotationWarning if identity else False
        abuse_review_required = status_counts["accepted_conflict"] >= 3 or local_review_status in {"watch", "restricted"}
        return ContributorTrustSummary.model_validate(
            {
                "acceptedUniqueReports": status_counts["accepted_unique"],
                "abuseAuditEventCount": len(self.contributor_abuse_audit(contributor_id)),
                "abuseReviewRequired": abuse_review_required,
                "conflictQuorumPolicy": {
                    "currentIndependentContributors": independent_count,
                    "met": independent_count >= CONFLICT_QUORUM_REQUIRED_CONTRIBUTORS,
                    "requiredIndependentContributors": CONFLICT_QUORUM_REQUIRED_CONTRIBUTORS,
                },
                "conflictReports": status_counts["accepted_conflict"],
                "contributorId": contributor_id,
                "duplicateReports": status_counts["accepted_duplicate"],
                "identityHealth": identity_health,
                "identityRotationWarning": identity_rotation_warning,
                "localReviewStatus": local_review_status,
                "localIdentitySeen": identity is not None,
                "moderationNoteCount": len(moderation_notes),
                "notificationEligibleReports": sum(
                    1 for report in contributor_reports if report.trust.eligibleForNotification
                ),
                "piiStored": False,
                "rateLimitPolicy": {
                    "currentWindowReports": rate_window_count,
                    "limited": rate_limited,
                    "maxReports": CONTRIBUTOR_REPORT_RATE_LIMIT_PER_WINDOW,
                    "windowHours": CONTRIBUTOR_RATE_LIMIT_WINDOW_HOURS,
                },
                "recentReportCount": recent_count,
                "reputationStatus": reputation_status,
                "staleReports": status_counts["stale_suppressed"],
                "totalReports": len(contributor_reports),
            }
        )

    def contributor_abuse_audit(self, contributor_id: str | None = None) -> list[ContributorAbuseAuditEvent]:
        events = self._contributor_abuse_audit
        if contributor_id is not None:
            events = [event for event in events if event.contributorId == contributor_id]
        return sorted(events, key=lambda event: event.recordedAt)

    def create_public_estimate_snapshot(
        self,
        payload: PublicEstimateSnapshotCreate,
        now: datetime | None = None,
    ) -> PublicEstimateSnapshot:
        stored_at = _utc(now or _now())
        captured_at = _utc(payload.capturedAt)
        fresh_until = _utc(payload.freshUntil)
        status = "accepted"
        freshness_label = "stale" if payload.parserStatus == "source_stale" or fresh_until < stored_at else "fresh"
        quarantine_reason = None
        if payload.parserStatus == "parser_failed":
            status = "quarantined"
            freshness_label = "quarantined"
            quarantine_reason = payload.parserStatus
        snapshot = PublicEstimateSnapshot.model_validate(
            {
                **payload.model_dump(),
                "capturedAt": captured_at,
                "estimateId": _new_id("public-estimate"),
                "freshUntil": fresh_until,
                "freshnessLabel": freshness_label,
                "quarantineReason": quarantine_reason,
                "status": status,
                "storedAt": stored_at,
            }
        )
        self._public_estimates.append(snapshot)
        return snapshot

    def import_public_estimate_fixture(
        self,
        payload: PublicEstimateFixtureImportRequest,
        now: datetime | None = None,
    ) -> PublicEstimateFixtureImportResponse:
        stored_at = _utc(now or _now())
        captured_at = _utc(payload.capturedAt or stored_at)
        fresh_until = _utc(payload.freshUntil) if payload.freshUntil else captured_at + timedelta(hours=PUBLIC_ESTIMATE_FIXTURE_FRESH_HOURS)
        allowlisted_source = self._allowlisted_public_estimate_source(payload)
        parsed_days = self._parse_public_estimate_days(payload.fixtureText)
        parser_drift_detected = parsed_days is None
        parser_status = "parser_failed" if parser_drift_detected else "source_stale" if fresh_until < stored_at else "parsed"
        snapshot_payload = PublicEstimateSnapshotCreate.model_validate(
            {
                "availabilityClaim": "public_estimate_not_slot_availability",
                "capturedAt": captured_at,
                "containsSensitiveRawData": False,
                "country": payload.country,
                "estimateLabel": payload.estimateLabel,
                "estimateValueDays": parsed_days if parsed_days is not None else 0,
                "freshUntil": fresh_until,
                "parserStatus": parser_status,
                "parserVersion": payload.parserVersion,
                "postCity": payload.postCity,
                "sourceName": allowlisted_source["sourceName"],
                "sourcePermission": "public_estimate_context",
                "sourceUrl": payload.sourceUrl,
                "triggersSlotAlerts": False,
                "visaClass": payload.visaClass,
            }
        )
        snapshot = self.create_public_estimate_snapshot(snapshot_payload, now=stored_at)
        return PublicEstimateFixtureImportResponse.model_validate(
            {
                "adapterMode": payload.adapterMode,
                "allowlistStatus": "allowlisted",
                "liveFetchAttempted": False,
                "parserDriftDetected": parser_drift_detected,
                "quarantineByDefault": True,
                "sourceId": payload.sourceId,
                "slotAlertTriggerAttempted": False,
                "snapshot": snapshot,
            }
        )

    def latest_public_estimates(
        self,
        *,
        country: str | None = None,
        include_quarantined: bool = False,
        post_city: str | None = None,
        visa_class: str | None = None,
    ) -> tuple[list[PublicEstimateSnapshot], int]:
        filtered = []
        quarantined_count = 0
        for estimate in self._public_estimates:
            if country and not _matches_text(estimate.country, country):
                continue
            if post_city and not _matches_text(estimate.postCity, post_city):
                continue
            if visa_class and not _matches_text(estimate.visaClass, visa_class):
                continue
            if estimate.status == "quarantined":
                quarantined_count += 1
                if not include_quarantined:
                    continue
            filtered.append(estimate)
        return sorted(filtered, key=lambda estimate: estimate.capturedAt, reverse=True)[:100], quarantined_count

    def public_context_summary(
        self,
        *,
        country: str | None = None,
        include_quarantined: bool = False,
        post_city: str | None = None,
        visa_class: str | None = None,
    ) -> PublicContextSummaryResponse:
        filtered = []
        for estimate in self._public_estimates:
            if country and not _matches_text(estimate.country, country):
                continue
            if post_city and not _matches_text(estimate.postCity, post_city):
                continue
            if visa_class and not _matches_text(estimate.visaClass, visa_class):
                continue
            filtered.append(estimate)

        all_grouped: dict[tuple[str, str, str], list[PublicEstimateSnapshot]] = {}
        visible_grouped: dict[tuple[str, str, str], list[PublicEstimateSnapshot]] = {}
        for estimate in filtered:
            key = _slot_scope_key(estimate)
            all_grouped.setdefault(key, []).append(estimate)
            if include_quarantined or estimate.status != "quarantined":
                visible_grouped.setdefault(key, []).append(estimate)

        quarantined_context_count = sum(
            1
            for estimates in all_grouped.values()
            if any(estimate.status == "quarantined" for estimate in estimates)
        )
        contexts = [
            self._public_context_summary_for_scope(estimates)
            for estimates in visible_grouped.values()
            if estimates
        ]
        return PublicContextSummaryResponse.model_validate(
            {
                "containsSensitiveRawData": False,
                "contexts": sorted(contexts, key=lambda context: context.latestCapturedAt, reverse=True)[:100],
                "liveFetchAttempted": False,
                "quarantinedContextCount": quarantined_context_count,
                "slotAlertsDelivered": False,
                "slotAlertTriggerAttempted": False,
                "sourcePolicy": source_policy_record("public_estimate"),
            }
        )

    def export_state(self) -> dict[str, object]:
        return {
            "contributorIdentities": list(self._contributor_identities.values()),
            "contributorIdentityAuditEvents": self.contributor_identity_audit(),
            "contributorModerationNotes": self.contributor_moderation_notes(),
            "deliveryAuditEvents": self.delivery_history(limit=1000),
            "pendingMatches": self.pending_notification_matches(include_backoff=True, include_digest=True),
            "publicEstimates": list(self._public_estimates),
            "reports": list(self._reports),
            "schemaVersion": 0,
            "subscriptions": list(self._subscriptions.values()),
        }

    def delete_report_with_counts(self, report_id: str) -> dict[str, int | bool]:
        existing = next((report for report in self._reports if report.reportId == report_id), None)
        if existing is None:
            return {
                "deleted": False,
                "deletedDeliveryAuditEvents": 0,
                "deletedPendingMatches": 0,
                "deletedReports": 0,
            }

        related_notification_ids = self._related_notification_ids_for_report(report_id)
        deleted_pending_matches = sum(1 for match in self._pending_matches if match.reportId == report_id)
        deleted_delivery_audit_events = sum(
            len(events)
            for notification_id, events in self._delivery_audit.items()
            if notification_id in related_notification_ids
        )
        self._reports = [report for report in self._reports if report.reportId != report_id]
        self._pending_matches = [match for match in self._pending_matches if match.reportId != report_id]
        for notification_id in related_notification_ids:
            self._delivery_audit.pop(notification_id, None)
            self._delivery_status_by_notification_id.pop(notification_id, None)
        self._rebuild_pending_match_keys()
        return {
            "deleted": True,
            "deletedDeliveryAuditEvents": deleted_delivery_audit_events,
            "deletedPendingMatches": deleted_pending_matches,
            "deletedReports": 1,
        }

    def prune_reports_before(self, cutoff: datetime, dry_run: bool) -> dict[str, int]:
        cutoff_utc = _utc(cutoff)
        matched_report_ids = [
            report.reportId
            for report in self._reports
            if report.capturedAt < cutoff_utc
        ]
        if dry_run:
            return {
                "deletedDeliveryAuditEvents": 0,
                "deletedPendingMatches": 0,
                "deletedReports": 0,
                "matchedReports": len(matched_report_ids),
            }

        totals = {
            "deletedDeliveryAuditEvents": 0,
            "deletedPendingMatches": 0,
            "deletedReports": 0,
            "matchedReports": len(matched_report_ids),
        }
        for report_id in matched_report_ids:
            result = self.delete_report_with_counts(report_id)
            totals["deletedDeliveryAuditEvents"] += int(result["deletedDeliveryAuditEvents"])
            totals["deletedPendingMatches"] += int(result["deletedPendingMatches"])
            totals["deletedReports"] += int(result["deletedReports"])
        return totals

    def _build_trust(
        self,
        *,
        captured_at: datetime,
        fresh_until: datetime,
        freshness: str,
        payload: SlotReportCreate,
        report_id: str,
        stored_at: datetime,
    ) -> SlotReportTrust:
        dedupe_key = _dedupe_key(payload)
        duplicate_of = next(
            (
                report.reportId
                for report in self._reports
                if report.trust.dedupeKey == dedupe_key and report.freshness == "fresh"
            ),
            None,
        )
        conflicting_report_ids = [
            report.reportId
            for report in self._reports
            if report.freshness == "fresh"
            and _slot_scope_key(report) == _slot_scope_key(payload)
            and report.trust.dedupeKey != dedupe_key
            and report.trust.status in {"accepted_unique", "accepted_conflict"}
        ][:24]
        if freshness == "stale":
            status = "stale_suppressed"
        elif duplicate_of:
            status = "accepted_duplicate"
        elif conflicting_report_ids:
            status = "accepted_conflict"
        else:
            status = "accepted_unique"
        quality = self._quality_assessment(
            confidence=payload.confidence,
            contributor_id=payload.contributorId,
            dedupe_key=dedupe_key,
            duplicate_of_report_id=duplicate_of,
            freshness=freshness,
            reference_at=stored_at,
            report_id=report_id,
            status=status,
        )

        return SlotReportTrust.model_validate(
            {
                "conflictingReportIds": conflicting_report_ids,
                "dedupeKey": dedupe_key,
                "duplicateOfReportId": duplicate_of,
                "eligibleForNotification": quality["eligibleForNotification"] and fresh_until >= stored_at,
                "independentContributorCount": quality["independentContributorCount"],
                "provenance": {
                    "availabilityClaim": "community_report_not_official_confirmation",
                    "capturedAt": captured_at,
                    "confidence": payload.confidence,
                    "contributorId": payload.contributorId,
                    "country": payload.country,
                    "officialAvailabilitySource": False,
                    "postCity": payload.postCity,
                    "sourceKind": payload.sourceKind,
                    "submittedAt": stored_at,
                    "visaClass": payload.visaClass,
                },
                "qualityScore": quality["qualityScore"],
                "qualitySignals": quality["qualitySignals"],
                "qualityTier": quality["qualityTier"],
                "similarFreshReportCount": quality["similarFreshReportCount"],
                "status": status,
                "suppressionReasons": quality["suppressionReasons"],
                "visibleMetadataOnly": True,
            }
        )

    def _with_quality(self, report: SlotReport, now: datetime) -> SlotReport:
        quality = self._quality_assessment(
            confidence=report.trust.provenance.confidence,
            contributor_id=report.trust.provenance.contributorId,
            dedupe_key=report.trust.dedupeKey,
            duplicate_of_report_id=report.trust.duplicateOfReportId,
            freshness=report.freshness,
            reference_at=now,
            report_id=report.reportId,
            status=report.trust.status,
        )
        trust = report.trust.model_copy(
            update={
                "eligibleForNotification": quality["eligibleForNotification"],
                "independentContributorCount": quality["independentContributorCount"],
                "qualityScore": quality["qualityScore"],
                "qualitySignals": quality["qualitySignals"],
                "qualityTier": quality["qualityTier"],
                "similarFreshReportCount": quality["similarFreshReportCount"],
                "suppressionReasons": quality["suppressionReasons"],
            }
        )
        return report.model_copy(update={"trust": trust})

    def _quality_assessment(
        self,
        *,
        confidence: str,
        contributor_id: str | None,
        dedupe_key: str,
        duplicate_of_report_id: str | None,
        freshness: str,
        reference_at: datetime,
        report_id: str,
        status: str,
    ) -> dict[str, object]:
        score = 60
        quality_signals: list[str] = []
        suppression_reasons: list[str] = []

        _append_unique(quality_signals, "visible_metadata_only")
        if confidence == "user_visible":
            score += 15
            _append_unique(quality_signals, "user_visible_confidence")
        else:
            score += 5
            _append_unique(quality_signals, "community_report_confidence")

        if freshness == "fresh":
            score += 15
            _append_unique(quality_signals, "fresh_report")
        else:
            score -= 60
            _append_unique(suppression_reasons, "stale_report")

        similar_reports = [
            report
            for report in self._reports
            if report.reportId != report_id and report.trust.dedupeKey == dedupe_key and report.freshUntil >= reference_at
        ]
        similar_fresh_report_count = len(similar_reports) + (1 if freshness == "fresh" else 0)
        contributor_ids = {
            report.trust.provenance.contributorId
            for report in similar_reports
            if report.trust.provenance.contributorId
        }
        if contributor_id and freshness == "fresh":
            contributor_ids.add(contributor_id)
        independent_contributor_count = len(contributor_ids)
        if similar_fresh_report_count >= 2:
            score += 5
            _append_unique(quality_signals, "duplicate_same_dates")
        if independent_contributor_count >= CONFLICT_QUORUM_REQUIRED_CONTRIBUTORS:
            score += 10
            _append_unique(quality_signals, "independent_corroboration")

        if status == "accepted_duplicate" or duplicate_of_report_id is not None:
            score -= 35
            _append_unique(suppression_reasons, "duplicate_report")
        if status == "accepted_conflict":
            score -= 45
            _append_unique(quality_signals, "conflicting_same_scope")
            _append_unique(suppression_reasons, "conflicting_report")
        if status == "stale_suppressed":
            _append_unique(suppression_reasons, "stale_report")

        if contributor_id:
            score += 5
            identity = self.contributor_identity(contributor_id)
            if identity is not None:
                score += 5
                _append_unique(quality_signals, "registered_local_identity")
                if identity.identityHealth == "stable":
                    score += 10
                    _append_unique(quality_signals, "stable_local_identity")
                if identity.rotationWarning or identity.identityHealth in {"rotated", "review"}:
                    score -= 15 if identity.identityHealth == "rotated" else 25
                    _append_unique(quality_signals, "identity_rotation_warning")

            local_review_status = self._contributor_local_review_status(contributor_id)
            if local_review_status == "watch":
                score -= 25
                _append_unique(quality_signals, "local_review_watch")
            elif local_review_status == "restricted":
                score -= 70
                _append_unique(quality_signals, "local_review_restricted")
                _append_unique(suppression_reasons, "restricted_contributor")

        score = _clamp_quality_score(score)
        if score < SLOT_REPORT_QUALITY_NOTIFICATION_THRESHOLD:
            _append_unique(suppression_reasons, "low_quality_score")

        direct_suppression = any(reason != "low_quality_score" for reason in suppression_reasons)
        quality_tier = "trusted" if score >= 85 else "standard"
        if score < SLOT_REPORT_QUALITY_NOTIFICATION_THRESHOLD:
            quality_tier = "low"
        if direct_suppression or score < 40:
            quality_tier = "suppressed"
        eligible = (
            status == "accepted_unique"
            and freshness == "fresh"
            and score >= SLOT_REPORT_QUALITY_NOTIFICATION_THRESHOLD
            and not direct_suppression
        )
        return {
            "eligibleForNotification": eligible,
            "independentContributorCount": independent_contributor_count,
            "qualityScore": score,
            "qualitySignals": quality_signals,
            "qualityTier": quality_tier,
            "similarFreshReportCount": similar_fresh_report_count,
            "suppressionReasons": suppression_reasons,
        }

    def _with_freshness(self, report: SlotReport, now: datetime) -> SlotReport:
        freshness = "fresh" if report.freshUntil >= now else "stale"
        if report.freshness == freshness and (freshness == "fresh" or report.trust.status == "stale_suppressed"):
            return report
        trust = report.trust
        if freshness == "stale" and report.trust.status != "stale_suppressed":
            trust = report.trust.model_copy(
                update={
                    "eligibleForNotification": False,
                    "status": "stale_suppressed",
                }
            )
        return report.model_copy(update={"freshness": freshness, "trust": trust})

    def _match(
        self,
        subscription: AlertSubscription,
        report: SlotReport,
        matched_dates: list[date],
        now: datetime,
    ) -> AlertMatch:
        channel = subscription.channels[0]
        notification = NotificationEvent.model_validate(
            {
                "channel": channel,
                "containsBookingConfirmation": False,
                "createdAt": now,
                "deliveryStatus": "pending",
                "eventType": "availability_detected",
                "messageIntent": "alert_only",
                "notificationId": f"notification:slot-alert:{_safe_suffix(subscription.subscriptionId)}:{_safe_suffix(report.reportId)}",
                "redactionLevel": "no_secrets",
                "relatedSessionId": None,
                "relatedSnapshotId": report.reportId,
                "traceId": f"trace:slot-alert:{_safe_suffix(subscription.subscriptionId)}",
            }
        )
        return AlertMatch.model_validate(
            {
                "availabilityClaim": "community_report_not_official_confirmation",
                "deliveryMode": subscription.deliveryMode,
                "digestWindowMinutes": subscription.digestWindowMinutes,
                "matchedDates": matched_dates,
                "notificationEvent": notification,
                "notificationReason": "fresh_community_report_matches_filter",
                "reportTrust": report.trust,
                "reportId": report.reportId,
                "subscriptionId": subscription.subscriptionId,
            }
        )

    def _match_report_for_subscription(
        self,
        report: SlotReport,
        subscription: AlertSubscription,
        now: datetime,
    ) -> AlertMatch | None:
        if not subscription.active or subscription.status != "active":
            return None
        if self._subscription_in_cooldown(subscription, now):
            return None
        refreshed = self._with_quality(self._with_freshness(report, now), now)
        if refreshed.freshness == "stale":
            return None
        if not refreshed.trust.eligibleForNotification:
            return None
        if not _matches_text(refreshed.country, subscription.country):
            return None
        if not any(_matches_text(refreshed.postCity, city) for city in subscription.postCities):
            return None
        if not any(_matches_text(refreshed.visaClass, visa_class) for visa_class in subscription.visaClasses):
            return None
        matched_dates = _matching_dates(refreshed, subscription.targetStartDate, subscription.targetEndDate)
        if not matched_dates:
            return None
        return self._match(subscription, refreshed, matched_dates, now)

    def _find_match_by_notification_id(self, notification_id: str) -> AlertMatch | None:
        for match in self._pending_matches:
            if match.notificationEvent.notificationId == notification_id:
                return self._with_delivery_status(match)
        return None

    def _report_by_id(self, report_id: str) -> SlotReport | None:
        return next((report for report in self._reports if report.reportId == report_id), None)

    def _latest_delivery_audit(self, notification_id: str) -> AlertDeliveryAuditEvent | None:
        events = self._delivery_audit.get(notification_id, [])
        return events[-1] if events else None

    def _record_delivery_audit(self, audit_event: AlertDeliveryAuditEvent) -> None:
        events = self._delivery_audit.setdefault(audit_event.notificationId, [])
        events.append(audit_event)
        self._delivery_status_by_notification_id[audit_event.notificationId] = audit_event.deliveryStatus
        if audit_event.deliveryStatus == "sent":
            subscription = self._subscriptions.get(audit_event.subscriptionId)
            if subscription is not None:
                self._subscriptions[audit_event.subscriptionId] = subscription.model_copy(
                    update={
                        "lastNotificationAt": audit_event.acknowledgedAt,
                        "updatedAt": audit_event.acknowledgedAt,
                    }
                )

    def _record_subscription_audit(self, audit_event: AlertSubscriptionAuditEvent) -> None:
        self._subscription_audit.append(audit_event)

    def _notification_adapter_sandbox_payload(
        self,
        *,
        channel: str,
        match: AlertMatch,
        report: SlotReport,
    ) -> NotificationAdapterSandboxPayload:
        matched_date = match.matchedDates[0].isoformat() if match.matchedDates else "a reported date"
        body = (
            f"{report.postCity} {report.visaClass} community availability includes {matched_date}. "
            "Review the community report. No appointment action was taken."
        )
        return NotificationAdapterSandboxPayload.model_validate(
            {
                "actionLabel": "Open tracker",
                "adapterMode": "sandbox_only",
                "availabilityClaim": "community_report_not_official_confirmation",
                "body": body,
                "channel": channel,
                "containsBookingConfirmation": False,
                "containsSensitiveRawData": False,
                "country": report.country,
                "externalNetworkCallAttempted": False,
                "matchedDates": match.matchedDates,
                "postCity": report.postCity,
                "providerEndpoint": "not_called",
                "recipientRef": f"sandbox-recipient:{channel}:local-reviewer",
                "redactionLevel": "no_secrets",
                "title": "Community visa slot report",
                "unsubscribeAction": "pause_or_delete_filter",
                "visaClass": report.visaClass,
            }
        )

    def _provider_outbox_payload(
        self,
        *,
        channel: str,
        match: AlertMatch,
        report: SlotReport,
    ) -> ProviderOutboxPayload:
        matched_date = match.matchedDates[0].isoformat() if match.matchedDates else "a reported date"
        body = (
            f"{report.postCity} {report.visaClass} community availability includes {matched_date}. "
            "Provider delivery is disabled; review in the browser or digest view."
        )
        return ProviderOutboxPayload.model_validate(
            {
                "actionLabel": "Open tracker",
                "adapterMode": "provider_safe_outbox",
                "availabilityClaim": "community_report_not_official_confirmation",
                "body": body,
                "channel": channel,
                "containsBookingConfirmation": False,
                "containsSensitiveRawData": False,
                "country": report.country,
                "externalNetworkCallAttempted": False,
                "matchedDates": match.matchedDates,
                "postCity": report.postCity,
                "providerEndpoint": "disabled_by_default",
                "recipientRef": f"redacted-recipient:{channel}:local-reviewer",
                "redactionLevel": "no_secrets",
                "retryBackoffSeconds": NOTIFICATION_RETRY_BASE_SECONDS,
                "title": "Community visa slot report",
                "unsubscribeAction": "pause_or_delete_filter",
                "visaClass": report.visaClass,
            }
        )

    def _notification_adapter_sandbox_counts(
        self,
        deliveries: list[NotificationAdapterSandboxDelivery],
    ) -> dict[str, int]:
        counts = {"recorded": 0, "skipped": 0, "suppressed": 0}
        for delivery in deliveries:
            counts[delivery.status] += 1
        return counts

    def _provider_outbox_counts(
        self,
        deliveries: list[ProviderOutboxDelivery],
    ) -> dict[str, int]:
        counts = {"queued_disabled": 0, "skipped": 0, "suppressed": 0}
        for delivery in deliveries:
            counts[delivery.status] += 1
        return counts

    def _public_context_summary_for_scope(self, estimates: list[PublicEstimateSnapshot]) -> PublicContextSummary:
        latest = max(estimates, key=lambda estimate: estimate.capturedAt)
        accepted_estimates = [estimate for estimate in estimates if estimate.status == "accepted"]
        quarantined_estimates = [estimate for estimate in estimates if estimate.status == "quarantined"]
        stale_estimates = [estimate for estimate in estimates if estimate.freshnessLabel == "stale"]
        status = "accepted"
        if quarantined_estimates and accepted_estimates:
            status = "mixed"
        elif quarantined_estimates:
            status = "quarantined"

        freshness_values = {estimate.freshnessLabel for estimate in estimates}
        freshness_label = next(iter(freshness_values)) if len(freshness_values) == 1 else "mixed"
        source_names = list(dict.fromkeys(estimate.sourceName for estimate in estimates))
        source_urls = list(dict.fromkeys(estimate.sourceUrl for estimate in estimates))
        parser_statuses = list(dict.fromkeys(estimate.parserStatus for estimate in estimates))
        context_id = (
            "public-context:"
            f"{_safe_key_part(latest.country)}:"
            f"{_safe_key_part(latest.postCity)}:"
            f"{_safe_key_part(latest.visaClass)}"
        )
        return PublicContextSummary.model_validate(
            {
                "acceptedEstimateCount": len(accepted_estimates),
                "alertTriggerAllowed": False,
                "availabilityClaim": "public_context_not_slot_availability",
                "contextId": context_id,
                "country": latest.country,
                "freshUntil": max(estimate.freshUntil for estimate in estimates),
                "freshnessLabel": freshness_label,
                "latestCapturedAt": latest.capturedAt,
                "latestEstimateLabel": latest.estimateLabel,
                "latestEstimateValueDays": latest.estimateValueDays,
                "parserStatuses": parser_statuses,
                "postCity": latest.postCity,
                "quarantinedEstimateCount": len(quarantined_estimates),
                "recommendedUse": "decision_context_only",
                "reviewNote": "public_context_not_appointment_inventory",
                "slotAlertTriggerAttempted": False,
                "sourceKind": "public_estimate",
                "sourceNames": source_names,
                "sourceUrls": source_urls,
                "staleEstimateCount": len(stale_estimates),
                "status": status,
                "totalEstimateCount": len(estimates),
                "triggersSlotAlerts": False,
                "visaClass": latest.visaClass,
            }
        )

    def _remove_pending_notification(self, notification_id: str) -> None:
        self._pending_matches = [
            match for match in self._pending_matches if match.notificationEvent.notificationId != notification_id
        ]
        self._rebuild_pending_match_keys()

    def _with_delivery_status(self, match: AlertMatch, now: datetime | None = None) -> AlertMatch:
        checked_at = _utc(now or _now())
        match = self._with_current_report_trust(match, checked_at)
        latest_audit = self._latest_delivery_audit(match.notificationEvent.notificationId)
        status = self._delivery_status_by_notification_id.get(match.notificationEvent.notificationId)
        if latest_audit is None and (status is None or status == match.notificationEvent.deliveryStatus):
            return match
        retry_attempt_count = len(
            [
                event
                for event in self._delivery_audit.get(match.notificationEvent.notificationId, [])
                if event.deliveryStatus == "failed"
            ]
        )
        last_delivery_attempt_at = latest_audit.acknowledgedAt if latest_audit else match.lastDeliveryAttemptAt
        next_retry_at = None
        if latest_audit and latest_audit.deliveryStatus == "failed":
            retry_delay_seconds = min(
                NOTIFICATION_RETRY_BASE_SECONDS * (2 ** max(retry_attempt_count - 1, 0)),
                NOTIFICATION_RETRY_MAX_SECONDS,
            )
            next_retry_at = latest_audit.acknowledgedAt + timedelta(seconds=retry_delay_seconds)
        return match.model_copy(
            update={
                "lastDeliveryAttemptAt": last_delivery_attempt_at,
                "nextRetryAt": next_retry_at,
                "notificationEvent": match.notificationEvent.model_copy(update={"deliveryStatus": status or match.notificationEvent.deliveryStatus}),
                "retryAttemptCount": retry_attempt_count,
            }
        )

    def _with_current_report_trust(self, match: AlertMatch, now: datetime) -> AlertMatch:
        report = next((candidate for candidate in self._reports if candidate.reportId == match.reportId), None)
        if report is None:
            return match
        refreshed = self._with_quality(self._with_freshness(report, now), now)
        if refreshed.trust == match.reportTrust:
            return match
        return match.model_copy(update={"reportTrust": refreshed.trust})

    def _queue_match(self, match: AlertMatch) -> bool:
        key = (match.subscriptionId, match.reportId)
        if key in self._pending_match_keys:
            return False
        self._pending_match_keys.add(key)
        self._pending_matches.append(match)
        return True

    def _rebuild_pending_match_keys(self) -> None:
        self._pending_match_keys = {
            (match.subscriptionId, match.reportId)
            for match in self._pending_matches
        }

    def _related_notification_ids_for_report(self, report_id: str) -> set[str]:
        pending_ids = {
            match.notificationEvent.notificationId
            for match in self._pending_matches
            if match.reportId == report_id
        }
        audit_ids = {
            notification_id
            for notification_id, events in self._delivery_audit.items()
            if any(event.reportId == report_id for event in events)
        }
        return pending_ids | audit_ids

    def _queue_matches_for_report(self, report: SlotReport, now: datetime) -> None:
        for subscription in self._subscriptions.values():
            match = self._match_report_for_subscription(report, subscription, now)
            if match:
                self._queue_match(match)

    def _queue_quality_eligible_scope_matches(self, report: SlotReport, now: datetime) -> None:
        candidate_reports = [
            candidate
            for candidate in self._reports
            if candidate.reportId == report.reportId or candidate.trust.dedupeKey == report.trust.dedupeKey
        ]
        for candidate in candidate_reports:
            refreshed = self._with_quality(self._with_freshness(candidate, now), now)
            if refreshed.trust.eligibleForNotification:
                self._queue_matches_for_report(refreshed, now)

    def _queue_matches_for_subscription(self, subscription: AlertSubscription, now: datetime) -> None:
        if not subscription.active or subscription.status != "active":
            return
        for report in self._reports:
            match = self._match_report_for_subscription(report, subscription, now)
            if match:
                self._queue_match(match)

    def _subscription_update_action(
        self,
        current: AlertSubscription,
        next_active: bool,
        next_cooldown: int,
        next_delivery_mode: str,
        next_digest_window: int,
    ) -> str:
        if current.active is False and next_active is True:
            return "resumed"
        if current.active is True and next_active is False:
            return "paused"
        if current.cooldownMinutes != next_cooldown:
            return "cooldown_updated"
        if current.deliveryMode != next_delivery_mode or current.digestWindowMinutes != next_digest_window:
            return "delivery_policy_updated"
        return "resumed" if next_active else "paused"

    def _subscription_in_cooldown(self, subscription: AlertSubscription, now: datetime) -> bool:
        if subscription.lastNotificationAt is None:
            return False
        cooldown_until = _utc(subscription.lastNotificationAt) + timedelta(minutes=subscription.cooldownMinutes)
        return cooldown_until > now

    def _max_independent_contributors_for_contributor(self, contributor_id: str) -> int:
        scopes = {
            _slot_scope_key(report)
            for report in self._reports
            if report.trust.provenance.contributorId == contributor_id
        }
        if not scopes:
            return 0
        max_count = 0
        for scope in scopes:
            contributor_ids = {
                report.trust.provenance.contributorId
                for report in self._reports
                if _slot_scope_key(report) == scope and report.trust.provenance.contributorId
            }
            max_count = max(max_count, len(contributor_ids))
        return max_count

    def _contributor_window_report_count(self, contributor_id: str, now: datetime) -> int:
        cutoff = now - timedelta(hours=CONTRIBUTOR_RATE_LIMIT_WINDOW_HOURS)
        return sum(
            1
            for report in self._reports
            if report.trust.provenance.contributorId == contributor_id and report.storedAt >= cutoff
        )

    def _contributor_conflict_count(self, contributor_id: str) -> int:
        return sum(
            1
            for report in self._reports
            if report.trust.provenance.contributorId == contributor_id
            and report.trust.status == "accepted_conflict"
        )

    def _contributor_audit_event(
        self,
        *,
        action: str,
        contributor_id: str,
        now: datetime,
        reason: str,
        recent_report_count: int,
    ) -> ContributorAbuseAuditEvent:
        return ContributorAbuseAuditEvent.model_validate(
            {
                "action": action,
                "containsSensitiveRawData": False,
                "contributorId": contributor_id,
                "limitMaxReports": CONTRIBUTOR_REPORT_RATE_LIMIT_PER_WINDOW,
                "limitWindowHours": CONTRIBUTOR_RATE_LIMIT_WINDOW_HOURS,
                "reason": reason,
                "recentReportCount": recent_report_count,
                "recordedAt": now,
            }
        )

    def _enforce_contributor_rate_limit(self, contributor_id: str, now: datetime) -> None:
        recent_report_count = self._contributor_window_report_count(contributor_id, now)
        if recent_report_count < CONTRIBUTOR_REPORT_RATE_LIMIT_PER_WINDOW:
            return
        audit_event = self._contributor_audit_event(
            action="rate_limited",
            contributor_id=contributor_id,
            now=now,
            reason="hourly_report_limit_exceeded",
            recent_report_count=recent_report_count,
        )
        self._record_contributor_abuse_audit(audit_event)
        raise ContributorRateLimitExceeded(audit_event)

    def _contributor_identity_health(
        self,
        *,
        action: str,
        contributor_id: str,
        rotation_count: int,
    ) -> str:
        if rotation_count >= 3:
            return "review"
        if action == "rotated" or rotation_count > 0:
            return "rotated"
        if self._contributor_window_report_count(contributor_id, _now()) >= 2:
            return "stable"
        return "new"

    def _record_contributor_abuse_audit(self, audit_event: ContributorAbuseAuditEvent) -> None:
        self._contributor_abuse_audit.append(audit_event)

    def _record_contributor_identity_audit(self, audit_event: ContributorIdentityAuditEvent) -> None:
        self._contributor_identity_audit.append(audit_event)

    def _record_contributor_moderation_note(self, note: ContributorModerationNote) -> None:
        self._contributor_moderation_notes.append(note)

    def _parse_public_estimate_days(self, fixture_text: str) -> int | None:
        match = re.search(r"\b(\d{1,4})\s*(?:calendar\s*)?days?\b", fixture_text, re.IGNORECASE)
        if match is None:
            return None
        return min(int(match.group(1)), 3650)

    def _allowlisted_public_estimate_source(
        self, payload: PublicEstimateFixtureImportRequest
    ) -> dict[str, object]:
        source = PUBLIC_ESTIMATE_SOURCE_ALLOWLIST.get(payload.sourceId)
        if source is None:
            raise PublicEstimateSourceNotAllowed(payload.sourceId, payload.sourceUrl)
        if not any(payload.sourceUrl.startswith(prefix) for prefix in source["urlPrefixes"]):
            raise PublicEstimateSourceNotAllowed(payload.sourceId, payload.sourceUrl)
        return source


