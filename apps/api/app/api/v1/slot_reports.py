from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Path, Request

from app.api.v1.entitlements import require_valid_entitlement
from app.core.auth import require_admin_auth, require_client_or_admin_auth
from app.schemas.slot_reports import (
    AlertDeliveryAckCreate,
    AlertDeliveryAckResponse,
    AlertDeliveryHistoryResponse,
    AlertDeliveryAuditResponse,
    AlertDigestDeliveryAckCreate,
    AlertDigestDeliveryAckResponse,
    AlertMatchesResponse,
    AlertNotificationDigestResponse,
    AlertNotificationQueueResponse,
    AlertPendingCleanupRequest,
    AlertPendingCleanupResponse,
    AlertSubscriptionCreate,
    AlertSubscriptionCreateResponse,
    AlertSubscriptionDeleteResponse,
    AlertSubscriptionListResponse,
    AlertSubscriptionUpdate,
    AlertSubscriptionUpdateResponse,
    ContributorAbuseAuditResponse,
    ContributorIdentityResponse,
    ContributorIdentityUpsert,
    ContributorModerationNoteCreate,
    ContributorModerationNoteCreateResponse,
    ContributorModerationNotesResponse,
    ContributorTrustResponse,
    NotificationAdapterSandboxCreate,
    NotificationAdapterSandboxHistoryResponse,
    NotificationAdapterSandboxResponse,
    ProviderDeliveryReadinessResponse,
    ProviderOutboxCreate,
    ProviderOutboxHistoryResponse,
    ProviderOutboxResponse,
    PublicContextSummaryResponse,
    PublicEstimateFixtureImportRequest,
    PublicEstimateFixtureImportResponse,
    PublicEstimateLatestResponse,
    PublicEstimateSnapshot,
    PublicEstimateSnapshotCreate,
    PublicEstimateSnapshotCreateResponse,
    SlotSignalDeleteResponse,
    SlotSignalExportResponse,
    SlotSignalRetentionPruneRequest,
    SlotSignalRetentionPruneResponse,
    SlotReport,
    SlotReportCreate,
    SlotReportLatestResponse,
    SourcePolicyResponse,
)
from app.services.slot_reports import (
    ContributorRateLimitExceeded,
    InMemorySlotReportStore,
    PublicEstimateSourceNotAllowed,
    SourcePolicyViolation,
    create_slot_report_store,
    source_policy_response,
)

router = APIRouter(tags=["slot-reports"])


def _store(request: Request) -> InMemorySlotReportStore:
    store = getattr(request.app.state, "slot_report_store", None)
    if store is None:
        store = create_slot_report_store(getattr(request.app.state, "settings", None))
        request.app.state.slot_report_store = store
    return store


def _ensure_persistence_admin_allowed(request: Request) -> None:
    require_admin_auth(request)
    require_valid_entitlement(request, required_tier="beta")


def _clock_now(request: Request) -> datetime | None:
    return getattr(getattr(request.app.state, "settings", None), "clock_now", None)


@router.post("/slot-reports", response_model=SlotReport)
async def create_slot_report(payload: SlotReportCreate, request: Request) -> SlotReport:
    require_client_or_admin_auth(request)
    try:
        return _store(request).create_report(payload)
    except SourcePolicyViolation as error:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "Source is not authorized to trigger slot alerts.",
                "sourcePolicy": error.source_policy.model_dump(mode="json"),
            },
        ) from error
    except ContributorRateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=error.audit_event.model_dump(mode="json"),
        ) from error


@router.post("/alert-subscriptions", response_model=AlertSubscriptionCreateResponse)
async def create_alert_subscription(
    payload: AlertSubscriptionCreate,
    request: Request,
) -> AlertSubscriptionCreateResponse:
    require_client_or_admin_auth(request)
    store = _store(request)
    subscription = store.create_subscription(payload)
    return AlertSubscriptionCreateResponse.model_validate(
        {
            "initialMatches": store.matches_for_subscription(subscription.subscriptionId),
            "subscription": subscription,
        }
    )


@router.delete("/alert-subscriptions/{subscription_id}", response_model=AlertSubscriptionDeleteResponse)
async def delete_alert_subscription(
    subscription_id: str,
    request: Request,
    auditReason: str | None = None,
) -> AlertSubscriptionDeleteResponse:
    require_client_or_admin_auth(request)
    response = _store(request).delete_subscription(subscription_id, audit_reason=auditReason)
    if response is None:
        raise HTTPException(status_code=404, detail="Alert subscription was not found.")
    return response


@router.post("/contributors/{contributor_id}/moderation-notes", response_model=ContributorModerationNoteCreateResponse)
async def create_contributor_moderation_note(
    payload: ContributorModerationNoteCreate,
    request: Request,
    contributor_id: str = Path(min_length=8, max_length=120),
) -> ContributorModerationNoteCreateResponse:
    require_admin_auth(request)
    note = _store(request).add_contributor_moderation_note(contributor_id, payload)
    return ContributorModerationNoteCreateResponse.model_validate(
        {
            "containsSensitiveRawData": False,
            "note": note,
        }
    )


@router.post("/public-estimates/snapshots", response_model=PublicEstimateSnapshotCreateResponse)
async def create_public_estimate_snapshot(
    payload: PublicEstimateSnapshotCreate,
    request: Request,
) -> PublicEstimateSnapshotCreateResponse:
    require_admin_auth(request)
    snapshot: PublicEstimateSnapshot = _store(request).create_public_estimate_snapshot(
        payload,
        now=_clock_now(request),
    )
    return PublicEstimateSnapshotCreateResponse.model_validate({"snapshot": snapshot})


@router.post("/public-estimates/import-fixture", response_model=PublicEstimateFixtureImportResponse)
async def import_public_estimate_fixture(
    payload: PublicEstimateFixtureImportRequest,
    request: Request,
) -> PublicEstimateFixtureImportResponse:
    require_admin_auth(request)
    try:
        return _store(request).import_public_estimate_fixture(payload, now=_clock_now(request))
    except PublicEstimateSourceNotAllowed as error:
        raise HTTPException(
            status_code=422,
            detail={
                "allowlistStatus": "blocked",
                "message": "Public-estimate source is not allowlisted for fixture replay.",
                "sourceId": error.source_id,
                "sourceUrl": error.source_url,
            },
        ) from error


@router.post("/alert-notifications/digest/{subscription_id}/delivery-ack", response_model=AlertDigestDeliveryAckResponse)
async def acknowledge_digest_alert_delivery(
    subscription_id: str,
    payload: AlertDigestDeliveryAckCreate,
    request: Request,
) -> AlertDigestDeliveryAckResponse:
    require_client_or_admin_auth(request)
    response = _store(request).acknowledge_digest_delivery(subscription_id, payload)
    if response is None:
        raise HTTPException(status_code=404, detail="Digest alert subscription was not found.")
    return response


@router.post("/alert-notifications/pending/cleanup", response_model=AlertPendingCleanupResponse)
async def cleanup_pending_alert_notifications(
    payload: AlertPendingCleanupRequest,
    request: Request,
) -> AlertPendingCleanupResponse:
    require_client_or_admin_auth(request)
    return _store(request).cleanup_stale_pending_matches(
        checked_at=payload.checkedAt,
        cutoff_before=payload.cutoffBefore,
        dry_run=payload.dryRun,
    )


@router.post("/alert-notifications/{notification_id}/delivery-ack", response_model=AlertDeliveryAckResponse)
async def acknowledge_alert_notification_delivery(
    notification_id: str,
    payload: AlertDeliveryAckCreate,
    request: Request,
) -> AlertDeliveryAckResponse:
    require_client_or_admin_auth(request)
    response = _store(request).acknowledge_delivery(notification_id, payload)
    if response is None:
        raise HTTPException(status_code=404, detail="Alert notification was not found.")
    return response


@router.post("/alert-notifications/provider-outbox", response_model=ProviderOutboxResponse)
async def create_alert_notification_provider_outbox(
    payload: ProviderOutboxCreate,
    request: Request,
) -> ProviderOutboxResponse:
    require_admin_auth(request)
    return _store(request).create_provider_outbox(payload)


@router.get("/slot-signal/export", response_model=SlotSignalExportResponse)
async def export_slot_signal_records(request: Request) -> SlotSignalExportResponse:
    _ensure_persistence_admin_allowed(request)
    exported = _store(request).export_state()
    return SlotSignalExportResponse.model_validate(
        {
            **exported,
            "appointmentChangingActionTaken": False,
            "containsSensitiveRawData": False,
            "exportedAt": datetime.now(timezone.utc),
            "livePortalRequestMade": False,
            "safeSummary": "Redacted slot-signal export; community metadata only, no credentials or portal page data.",
        }
    )


@router.delete("/slot-signal/reports/{report_id}", response_model=SlotSignalDeleteResponse)
async def delete_slot_signal_report(report_id: str, request: Request) -> SlotSignalDeleteResponse:
    _ensure_persistence_admin_allowed(request)
    result = _store(request).delete_report_with_counts(report_id)
    return SlotSignalDeleteResponse.model_validate(
        {
            **result,
            "containsSensitiveRawData": False,
            "reportId": report_id,
            "retentionAction": "manual_delete",
        }
    )


@router.post("/slot-signal/retention/prune", response_model=SlotSignalRetentionPruneResponse)
async def prune_slot_signal_records(
    payload: SlotSignalRetentionPruneRequest,
    request: Request,
) -> SlotSignalRetentionPruneResponse:
    _ensure_persistence_admin_allowed(request)
    cutoff = payload.cutoffBefore or (
        datetime.now(timezone.utc) - timedelta(days=request.app.state.settings.audit_retention_days)
    )
    result = _store(request).prune_reports_before(cutoff, payload.dryRun)
    return SlotSignalRetentionPruneResponse.model_validate(
        {
            **result,
            "containsSensitiveRawData": False,
            "cutoffBefore": cutoff,
            "dryRun": payload.dryRun,
            "retentionAction": "retention_prune",
        }
    )
