from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


PUBLIC_ESTIMATE_TEST_NOW = datetime(2026, 5, 8, 12, 0, tzinfo=timezone.utc)


def make_client(*, clock_now: datetime | None = None) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Test",
                clock_now=clock_now,
                environment="test",
            )
        )
    )


def make_durable_client(db_path: Path, *, clock_now: datetime | None = None) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Durable Slot Signal Test",
                audit_db_path=str(db_path),
                clock_now=clock_now,
                environment="test",
            )
        )
    )


def slot_report_payload() -> dict:
    return {
        "availableDates": ["2026-06-18", "2026-06-12", "2026-06-18"],
        "bookingActionTaken": False,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "confidence": "user_visible",
        "containsSensitiveRawData": False,
        "country": "India",
        "credentialDataIncluded": False,
        "notes": "User-visible community report from schedule page.",
        "portalAutomationUsed": False,
        "postCity": "Chennai",
        "sourceKind": "community_report",
        "visaClass": "B1/B2",
    }


def test_slot_report_includes_trust_and_provenance_metadata() -> None:
    client = make_client()

    created = client.post("/v1/slot-reports", json=slot_report_payload())

    assert created.status_code == 200
    body = created.json()
    assert body["trust"]["status"] == "accepted_unique"
    assert body["trust"]["dedupeKey"].startswith("slot-report-dedupe:")
    assert body["trust"]["duplicateOfReportId"] is None
    assert body["trust"]["conflictingReportIds"] == []
    assert body["trust"]["eligibleForNotification"] is True
    assert body["trust"]["qualityScore"] >= 85
    assert body["trust"]["qualityTier"] == "trusted"
    assert body["trust"]["qualitySignals"] == ["visible_metadata_only", "user_visible_confidence", "fresh_report"]
    assert body["trust"]["suppressionReasons"] == []
    assert body["trust"]["similarFreshReportCount"] == 1
    assert body["trust"]["independentContributorCount"] == 0
    assert body["trust"]["visibleMetadataOnly"] is True
    assert body["trust"]["provenance"]["sourceKind"] == "community_report"
    assert body["trust"]["provenance"]["confidence"] == "user_visible"
    assert body["trust"]["provenance"]["officialAvailabilitySource"] is False
    assert body["trust"]["provenance"]["availabilityClaim"] == "community_report_not_official_confirmation"


def test_create_slot_report_normalizes_dates_and_latest_query_filters() -> None:
    client = make_client()

    created = client.post("/v1/slot-reports", json=slot_report_payload())

    assert created.status_code == 200
    body = created.json()
    assert body["reportId"].startswith("slot-report:")
    assert body["availableDates"] == ["2026-06-12", "2026-06-18"]
    assert body["freshness"] == "fresh"
    assert body["availabilityClaim"] == "community_report_not_official_confirmation"
    assert body["trust"]["status"] == "accepted_unique"
    assert body["credentialDataIncluded"] is False
    assert body["portalAutomationUsed"] is False
    assert body["bookingActionTaken"] is False

    latest = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-15",
            "visaClass": "B1/B2",
        },
    )

    assert latest.status_code == 200
    reports = latest.json()["reports"]
    assert len(reports) == 1
    assert reports[0]["reportId"] == body["reportId"]
    assert reports[0]["matchedDates"] == ["2026-06-12"]
    assert reports[0]["trust"]["visibleMetadataOnly"] is True


def test_slot_report_rejects_sensitive_data_and_automation_claims() -> None:
    client = make_client()

    sensitive = slot_report_payload() | {"notes": "Portal cookie and OTP copied here."}
    sensitive_response = client.post("/v1/slot-reports", json=sensitive)

    assert sensitive_response.status_code == 422

    automated = slot_report_payload() | {"portalAutomationUsed": True}
    automated_response = client.post("/v1/slot-reports", json=automated)

    assert automated_response.status_code == 422


def test_alert_subscription_matches_reports_and_returns_safe_notification_event() -> None:
    client = make_client()
    report = client.post("/v1/slot-reports", json=slot_report_payload()).json()

    subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser", "telegram"],
            "country": "India",
            "postCities": ["Chennai", "Hyderabad"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )

    assert subscription.status_code == 200
    body = subscription.json()
    assert body["subscription"]["subscriptionId"].startswith("slot-alert:")
    assert len(body["initialMatches"]) == 1
    match = body["initialMatches"][0]
    assert match["reportId"] == report["reportId"]
    assert match["matchedDates"] == ["2026-06-12", "2026-06-18"]
    assert match["notificationEvent"]["eventType"] == "availability_detected"
    assert match["notificationEvent"]["messageIntent"] == "alert_only"
    assert match["notificationEvent"]["containsBookingConfirmation"] is False
    assert match["notificationEvent"]["redactionLevel"] == "no_secrets"

    reread = client.get(f"/v1/alert-subscriptions/{body['subscription']['subscriptionId']}/matches")

    assert reread.status_code == 200
    assert reread.json()["matches"][0]["notificationEvent"]["relatedSnapshotId"] == report["reportId"]


def test_alert_subscription_does_not_match_out_of_range_reports() -> None:
    client = make_client()
    client.post("/v1/slot-reports", json=slot_report_payload())

    response = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-07-31",
            "targetStartDate": "2026-07-01",
            "visaClasses": ["B1/B2"],
        },
    )

    assert response.status_code == 200
    assert response.json()["initialMatches"] == []


def test_new_report_queues_pending_notification_for_existing_subscription() -> None:
    client = make_client()
    subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]

    report = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    pending = client.get("/v1/alert-notifications/pending")

    assert pending.status_code == 200
    matches = pending.json()["pendingMatches"]
    assert len(matches) == 1
    assert matches[0]["subscriptionId"] == subscription["subscriptionId"]
    assert matches[0]["reportId"] == report["reportId"]
    assert matches[0]["reportTrust"]["status"] == "accepted_unique"
    assert matches[0]["reportTrust"]["eligibleForNotification"] is True
    assert matches[0]["notificationEvent"]["deliveryStatus"] == "pending"
    assert matches[0]["notificationEvent"]["containsBookingConfirmation"] is False


def test_source_policy_source_policy_lists_alert_allowed_and_blocked_lanes() -> None:
    client = make_client()

    response = client.get("/v1/source-policy")

    assert response.status_code == 200
    body = response.json()
    records = {record["sourceKind"]: record for record in body["records"]}
    assert body["containsSensitiveRawData"] is False
    assert body["livePortalAutomationAllowed"] is False
    assert body["credentialAccessAllowed"] is False
    assert body["appointmentChangingActionAllowed"] is False
    assert records["community_report"]["canTriggerSlotAlerts"] is True
    assert records["manual_report"]["sourceLane"] == "manual_visible_metadata"
    assert records["manual_report"]["alertEligibility"] == "alert_allowed"
    assert records["public_estimate"]["canTriggerSlotAlerts"] is False
    assert records["public_estimate"]["alertEligibility"] == "context_only"
    assert records["notification_adapter_sandbox"]["alertEligibility"] == "sandbox_only"
    assert records["authorized_partner_api"]["alertEligibility"] == "blocked_pending_authorization"
    assert records["authorized_partner_api"]["requiresWrittenAuthorization"] is True


def test_source_policy_unapproved_sources_and_public_context_cannot_create_slot_alerts() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )

    unapproved = client.post(
        "/v1/slot-reports",
        json=slot_report_payload() | {"sourceKind": "authorized_partner_api"},
    )
    imported = client.post(
        "/v1/public-estimates/import-fixture",
        json={
            "adapterMode": "fixture_replay",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "fixtureText": "Chennai visitor visa wait time: 88 calendar days",
            "parserVersion": "fixture-parser-1",
            "postCity": "Chennai",
            "quarantineByDefault": True,
            "sourceId": "travel_state_global_wait_times",
            "sourceName": "Department of State Global Visa Wait Times",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    context = client.get("/v1/public-context/summary", params={"country": "India"}).json()

    assert unapproved.status_code == 422
    assert imported.status_code == 200
    assert imported.json()["slotAlertTriggerAttempted"] is False
    assert pending == []
    assert context["slotAlertsDelivered"] is False
    assert context["slotAlertTriggerAttempted"] is False
    assert context["sourcePolicy"]["sourceKind"] == "public_estimate"
    assert context["sourcePolicy"]["canTriggerSlotAlerts"] is False


def test_delivery_ack_marks_sent_match_out_of_pending_queue() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    notification_id = client.get("/v1/alert-notifications/pending").json()["pendingMatches"][0]["notificationEvent"][
        "notificationId"
    ]

    ack = client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )
    pending_after_ack = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    audit = client.get(f"/v1/alert-notifications/{notification_id}/delivery-audit")

    assert ack.status_code == 200
    assert ack.json()["notificationEvent"]["deliveryStatus"] == "sent"
    assert ack.json()["deliveryAudit"]["reason"] == "browser_notification_created"
    assert ack.json()["deliveryAudit"]["containsSensitiveRawData"] is False
    assert pending_after_ack == []
    assert audit.status_code == 200
    assert audit.json()["auditEvents"][0]["deliveryStatus"] == "sent"


def test_delivery_ack_marks_suppressed_match_out_of_pending_queue() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    notification_id = client.get("/v1/alert-notifications/pending").json()["pendingMatches"][0]["notificationEvent"][
        "notificationId"
    ]

    ack = client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": False,
            "deliveryStatus": "suppressed",
            "reason": "already_delivered_locally",
        },
    )

    assert ack.status_code == 200
    assert ack.json()["notificationEvent"]["deliveryStatus"] == "suppressed"
    assert ack.json()["deliveryAudit"]["reason"] == "already_delivered_locally"
    assert client.get("/v1/alert-notifications/pending").json()["pendingMatches"] == []


def test_slot_signal_store_persists_reports_subscriptions_pending_and_delivery_audit(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal.sqlite3"
    first_client = make_durable_client(db_path)
    first_client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    created = first_client.post("/v1/slot-reports", json=slot_report_payload()).json()

    fresh_client = make_durable_client(db_path)
    latest = fresh_client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]
    pending = fresh_client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    notification_id = pending[0]["notificationEvent"]["notificationId"]

    ack = fresh_client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )
    final_client = make_durable_client(db_path)

    assert latest[0]["reportId"] == created["reportId"]
    assert pending[0]["reportId"] == created["reportId"]
    assert ack.status_code == 200
    assert final_client.get("/v1/alert-notifications/pending").json()["pendingMatches"] == []
    assert final_client.get(f"/v1/alert-notifications/{notification_id}/delivery-audit").json()["auditEvents"][0][
        "deliveryStatus"
    ] == "sent"


def test_durable_store_persists_subscription_governance_public_estimates_and_contributor_trust(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_governance.sqlite3"
    first_client = make_durable_client(db_path, clock_now=PUBLIC_ESTIMATE_TEST_NOW)
    subscription = first_client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "cooldownMinutes": 45,
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    first_client.patch(
        f"/v1/alert-subscriptions/{subscription['subscriptionId']}",
        json={"active": False, "auditReason": "durable pause", "containsSensitiveRawData": False},
    )
    first_client.post(
        "/v1/slot-reports",
        json=slot_report_payload() | {"contributorId": "contributor:durable-001"},
    )
    first_client.post(
        "/v1/contributors/contributor:durable-001/moderation-notes",
        json={
            "containsSensitiveRawData": False,
            "note": "Local review: durable non-PII moderation note.",
            "reason": "manual_review",
            "reviewStatus": "watch",
        },
    )
    identity = first_client.put(
        "/v1/contributors/contributor:durable-001/identity",
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "contributor-key:durable-001",
            "createdAt": "2026-05-08T08:00:00Z",
            "lastSeenAt": "2026-05-08T08:05:00Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 0,
            "storageScope": "extension_local_storage",
        },
    )
    first_client.post(
        "/v1/public-estimates/snapshots",
        json={
            "availabilityClaim": "public_estimate_not_slot_availability",
            "capturedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "estimateValueDays": 120,
            "freshUntil": "2026-05-09T08:00:00Z",
            "parserStatus": "parsed",
            "parserVersion": "fixture-parser-1",
            "postCity": "Chennai",
            "sourceName": "Public visa wait time estimate",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )

    fresh_client = make_durable_client(db_path, clock_now=PUBLIC_ESTIMATE_TEST_NOW)
    subscriptions = fresh_client.get("/v1/alert-subscriptions").json()
    estimates = fresh_client.get("/v1/public-estimates/latest", params={"country": "India"}).json()
    trust = fresh_client.get("/v1/contributors/contributor:durable-001/trust").json()["trust"]
    fresh_identity = fresh_client.get("/v1/contributors/contributor:durable-001/identity").json()
    moderation_notes = fresh_client.get("/v1/contributors/contributor:durable-001/moderation-notes").json()
    exported = fresh_client.get("/v1/slot-signal/export").json()

    assert identity.status_code == 200
    assert subscriptions["subscriptions"][0]["status"] == "paused"
    assert subscriptions["subscriptions"][0]["cooldownMinutes"] == 45
    assert [event["action"] for event in subscriptions["auditEvents"]] == ["created", "paused"]
    assert estimates["estimates"][0]["availabilityClaim"] == "public_estimate_not_slot_availability"
    assert estimates["estimates"][0]["triggersSlotAlerts"] is False
    assert trust["piiStored"] is False
    assert trust["localIdentitySeen"] is True
    assert trust["identityHealth"] == "new"
    assert trust["identityRotationWarning"] is False
    assert trust["totalReports"] == 1
    assert trust["localReviewStatus"] == "watch"
    assert trust["moderationNoteCount"] == 1
    assert fresh_identity["containsSensitiveRawData"] is False
    assert fresh_identity["identity"]["contributorKeyId"] == "contributor-key:durable-001"
    assert fresh_identity["auditEvents"][0]["action"] == "created"
    assert moderation_notes["containsSensitiveRawData"] is False
    assert moderation_notes["notes"][0]["reason"] == "manual_review"
    assert exported["schemaVersion"] == 6
    assert exported["contributorIdentities"][0]["contributorKeyId"] == "contributor-key:durable-001"
    assert exported["contributorIdentityAuditEvents"][0]["action"] == "created"
    assert exported["publicEstimates"][0]["estimateId"].startswith("public-estimate:")
    assert exported["contributorModerationNotes"][0]["reviewStatus"] == "watch"


def test_contributor_identity_upsert_tracks_rotation_without_pii() -> None:
    client = make_client()

    created = client.put(
        "/v1/contributors/contributor:local-identity-001/identity",
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "contributor-key:local-001",
            "createdAt": "2026-05-08T08:00:00Z",
            "lastSeenAt": "2026-05-08T08:00:10Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 0,
            "storageScope": "extension_local_storage",
        },
    )
    rotated = client.put(
        "/v1/contributors/contributor:local-identity-001/identity",
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "contributor-key:local-002",
            "createdAt": "2026-05-08T08:00:00Z",
            "lastSeenAt": "2026-05-08T08:05:00Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 1,
            "storageScope": "extension_local_storage",
        },
    )
    trust = client.get("/v1/contributors/contributor:local-identity-001/trust")

    assert created.status_code == 200
    assert created.json()["identity"]["identityHealth"] == "new"
    assert created.json()["containsSensitiveRawData"] is False
    assert rotated.status_code == 200
    assert rotated.json()["identity"]["identityHealth"] == "rotated"
    assert rotated.json()["identity"]["rotationWarning"] is True
    assert [event["action"] for event in rotated.json()["auditEvents"]] == ["created", "rotated"]
    assert rotated.json()["auditEvents"][1]["previousContributorKeyId"] == "contributor-key:local-001"
    assert trust.status_code == 200
    assert trust.json()["trust"]["localIdentitySeen"] is True
    assert trust.json()["trust"]["identityHealth"] == "rotated"
    assert trust.json()["trust"]["identityRotationWarning"] is True
    assert trust.json()["trust"]["piiStored"] is False


def test_contributor_identity_rejects_sensitive_or_unstructured_identity_data() -> None:
    client = make_client()

    response = client.put(
        "/v1/contributors/contributor:local-identity-002/identity",
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "person@example.com",
            "createdAt": "2026-05-08T08:00:00Z",
            "lastSeenAt": "2026-05-08T08:05:00Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 0,
            "storageScope": "extension_local_storage",
        },
    )
    extra_field = client.put(
        "/v1/contributors/contributor:local-identity-002/identity",
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "contributor-key:local-003",
            "createdAt": "2026-05-08T08:00:00Z",
            "email": "person@example.com",
            "lastSeenAt": "2026-05-08T08:05:00Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 0,
            "storageScope": "extension_local_storage",
        },
    )

    assert response.status_code == 422
    assert extra_field.status_code == 422


def test_delivery_history_lists_sent_suppressed_and_failed_events() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    notification_id = client.get("/v1/alert-notifications/pending").json()["pendingMatches"][0]["notificationEvent"][
        "notificationId"
    ]
    client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "failed",
            "reason": "browser_create_failed",
        },
    )
    client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:01:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )

    history = client.get("/v1/alert-notifications/delivery-history")

    assert history.status_code == 200
    body = history.json()
    assert body["containsSensitiveRawData"] is False
    assert body["auditEvents"][0]["deliveryStatus"] == "sent"
    assert body["auditEvents"][1]["deliveryStatus"] == "failed"
    assert body["countsByStatus"] == {"failed": 1, "sent": 1, "suppressed": 0}


def test_slot_signal_export_delete_and_retention_controls(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_controls.sqlite3"
    client = make_durable_client(db_path)
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    report = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    exported = client.get("/v1/slot-signal/export")
    deleted = client.delete(f"/v1/slot-signal/reports/{report['reportId']}")
    after_delete = client.get("/v1/slot-signal/export").json()
    dry_run = client.post(
        "/v1/slot-signal/retention/prune",
        json={"cutoffBefore": "2026-12-31T00:00:00Z", "dryRun": True},
    )

    assert exported.status_code == 200
    export_body = exported.json()
    assert export_body["containsSensitiveRawData"] is False
    assert export_body["livePortalRequestMade"] is False
    assert export_body["appointmentChangingActionTaken"] is False
    assert export_body["reports"][0]["reportId"] == report["reportId"]
    assert export_body["pendingMatches"][0]["notificationEvent"]["notificationId"] == pending[0]["notificationEvent"][
        "notificationId"
    ]
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True
    assert deleted.json()["deletedReports"] == 1
    assert deleted.json()["deletedPendingMatches"] == 1
    assert after_delete["reports"] == []
    assert after_delete["pendingMatches"] == []
    assert dry_run.status_code == 200
    assert dry_run.json()["matchedReports"] == 0
    assert dry_run.json()["deletedReports"] == 0


def test_slot_signal_retention_prune_deletes_old_reports_without_deleting_subscriptions(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_prune.sqlite3"
    client = make_durable_client(db_path)
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    old_report = client.post("/v1/slot-reports", json=slot_report_payload() | {"capturedAt": "2026-01-01T00:00:00Z"}).json()
    fresh_report = client.post("/v1/slot-reports", json=slot_report_payload() | {"availableDates": ["2026-06-22"]}).json()

    dry_run = client.post(
        "/v1/slot-signal/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": True},
    )
    prune = client.post(
        "/v1/slot-signal/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": False},
    )
    exported = client.get("/v1/slot-signal/export").json()

    assert dry_run.status_code == 200
    assert dry_run.json()["matchedReports"] == 1
    assert dry_run.json()["deletedReports"] == 0
    assert prune.status_code == 200
    assert prune.json()["deletedReports"] == 1
    assert {report["reportId"] for report in exported["reports"]} == {fresh_report["reportId"]}
    assert old_report["reportId"] not in {report["reportId"] for report in exported["reports"]}
    assert len(exported["subscriptions"]) == 1


def test_slot_signal_admin_controls_require_production_admin_auth(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_production_gate.sqlite3"
    setup_client = make_durable_client(db_path)
    report = setup_client.post("/v1/slot-reports", json=slot_report_payload()).json()
    production_client = TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Production Slot Signal Test",
                audit_db_path=str(db_path),
                environment="production",
            )
        )
    )

    export = production_client.get("/v1/slot-signal/export")
    delete = production_client.delete(f"/v1/slot-signal/reports/{report['reportId']}")
    prune = production_client.post(
        "/v1/slot-signal/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": False},
    )

    assert export.status_code == 401
    assert delete.status_code == 401
    assert prune.status_code == 401


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_slot_signal_store_fails_fast_when_durable_path_is_unavailable_in_deployed_environments(
    environment: str,
    tmp_path: Path,
) -> None:
    unavailable_db_path = tmp_path / "slot_signal_directory.sqlite3"
    unavailable_db_path.mkdir()

    with pytest.raises(RuntimeError, match="Durable slot report store is unavailable"):
        TestClient(
            create_app(
                settings_factory=lambda: Settings(
                    app_name="Slot Signal API Durable Store Fail Fast Test",
                    audit_db_path=str(unavailable_db_path),
                    environment=environment,  # type: ignore[arg-type]
                )
            )
        )


def test_duplicate_report_is_trusted_as_duplicate_and_does_not_double_notify() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )

    first = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    duplicate = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    latest = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]
    low_trust = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "includeLowTrust": True,
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]

    assert duplicate["trust"]["status"] == "accepted_duplicate"
    assert duplicate["trust"]["duplicateOfReportId"] == first["reportId"]
    assert duplicate["trust"]["eligibleForNotification"] is False
    assert duplicate["trust"]["qualityTier"] == "suppressed"
    assert "duplicate_report" in duplicate["trust"]["suppressionReasons"]
    assert [match["reportId"] for match in pending] == [first["reportId"]]
    assert [report["reportId"] for report in latest] == [first["reportId"]]
    assert {report["trust"]["status"] for report in low_trust} == {"accepted_unique", "accepted_duplicate"}


def test_conflicting_report_is_visible_only_when_low_trust_included_and_not_queued() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-07-31",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    first = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    conflicting_payload = slot_report_payload() | {
        "availableDates": ["2026-07-09"],
        "notes": "Different visible date set for same post and visa class.",
    }

    conflict = client.post("/v1/slot-reports", json=conflicting_payload).json()
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    latest = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-07-31",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]
    low_trust = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "includeLowTrust": True,
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-07-31",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]

    assert conflict["trust"]["status"] == "accepted_conflict"
    assert conflict["trust"]["conflictingReportIds"] == [first["reportId"]]
    assert conflict["trust"]["eligibleForNotification"] is False
    assert conflict["trust"]["qualityTier"] == "suppressed"
    assert "conflicting_report" in conflict["trust"]["suppressionReasons"]
    assert [match["reportId"] for match in pending] == [first["reportId"]]
    assert [report["reportId"] for report in latest] == [first["reportId"]]
    assert {report["trust"]["status"] for report in low_trust} == {"accepted_unique", "accepted_conflict"}


def test_stale_report_is_not_queued_and_requires_stale_inclusion_to_read() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    stale_payload = slot_report_payload() | {"capturedAt": "2026-01-01T00:00:00Z"}

    stale = client.post("/v1/slot-reports", json=stale_payload).json()
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    latest_default = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]
    latest_with_stale = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "includeLowTrust": True,
            "includeStale": True,
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]

    assert stale["freshness"] == "stale"
    assert stale["trust"]["status"] == "stale_suppressed"
    assert stale["trust"]["eligibleForNotification"] is False
    assert pending == []
    assert latest_default == []
    assert latest_with_stale[0]["reportId"] == stale["reportId"]


def test_subscription_management_pause_resume_delete_cooldown_and_unsubscribe_audit() -> None:
    client = make_client()
    created = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "cooldownMinutes": 30,
            "country": "India",
            "postCities": ["Chennai", "Hyderabad"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    subscription_id = created["subscriptionId"]

    listed = client.get("/v1/alert-subscriptions")
    paused = client.patch(
        f"/v1/alert-subscriptions/{subscription_id}",
        json={"active": False, "auditReason": "temporary pause", "containsSensitiveRawData": False},
    )
    report_while_paused = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    pending_while_paused = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    resumed = client.patch(
        f"/v1/alert-subscriptions/{subscription_id}",
        json={"active": True, "cooldownMinutes": 20, "auditReason": "resume testing", "containsSensitiveRawData": False},
    )
    pending_after_resume = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    notification_id = pending_after_resume[0]["notificationEvent"]["notificationId"]
    client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        json={
            "acknowledgedAt": "2030-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )
    cooldown_report = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {"availableDates": ["2026-06-25"], "notes": "Visible second city date set.", "postCity": "Hyderabad"},
    ).json()
    pending_during_cooldown = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    deleted = client.delete(
        f"/v1/alert-subscriptions/{subscription_id}",
        params={"auditReason": "user unsubscribed"},
    )
    final_list = client.get("/v1/alert-subscriptions", params={"includeDeleted": True}).json()

    assert listed.status_code == 200
    assert listed.json()["subscriptions"][0]["cooldownMinutes"] == 30
    assert listed.json()["subscriptions"][0]["status"] == "active"
    assert paused.status_code == 200
    assert paused.json()["subscription"]["status"] == "paused"
    assert paused.json()["auditEvent"]["action"] == "paused"
    assert report_while_paused["trust"]["eligibleForNotification"] is True
    assert pending_while_paused == []
    assert resumed.status_code == 200
    assert resumed.json()["subscription"]["status"] == "active"
    assert resumed.json()["subscription"]["cooldownMinutes"] == 20
    assert pending_after_resume[0]["reportId"] == report_while_paused["reportId"]
    assert cooldown_report["trust"]["status"] == "accepted_unique"
    assert cooldown_report["trust"]["eligibleForNotification"] is True
    assert pending_during_cooldown == []
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True
    assert deleted.json()["auditEvent"]["action"] == "deleted"
    assert deleted.json()["removedPendingMatches"] == 0
    assert final_list["subscriptions"][0]["status"] == "deleted"
    assert [event["action"] for event in final_list["auditEvents"]] == ["created", "paused", "resumed", "deleted"]


def test_contributor_reputation_is_aggregate_only_without_pii() -> None:
    client = make_client()
    contributor_id = "contributor:visible-001"
    other_contributor_id = "contributor:visible-002"

    client.post("/v1/slot-reports", json=slot_report_payload() | {"contributorId": contributor_id})
    client.post("/v1/slot-reports", json=slot_report_payload() | {"contributorId": contributor_id})
    client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-07-09"],
            "contributorId": other_contributor_id,
            "notes": "Different visible date set for aggregate conflict review.",
        },
    )

    response = client.get(f"/v1/contributors/{contributor_id}/trust")

    assert response.status_code == 200
    body = response.json()["trust"]
    assert body["contributorId"] == contributor_id
    assert body["piiStored"] is False
    assert body["totalReports"] == 2
    assert body["acceptedUniqueReports"] == 1
    assert body["duplicateReports"] == 1
    assert body["conflictReports"] == 0
    assert body["notificationEligibleReports"] == 1
    assert body["recentReportCount"] == 2
    assert body["reputationStatus"] == "normal"
    assert body["conflictQuorumPolicy"] == {
        "currentIndependentContributors": 2,
        "met": True,
        "requiredIndependentContributors": 2,
    }
    assert "email" not in body
    assert "ipAddress" not in body


def test_public_estimate_context_lane_quarantines_parser_failures_and_never_queues_alerts() -> None:
    client = make_client(clock_now=PUBLIC_ESTIMATE_TEST_NOW)
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    estimate_payload = {
        "availabilityClaim": "public_estimate_not_slot_availability",
        "capturedAt": "2026-05-08T08:00:00Z",
        "containsSensitiveRawData": False,
        "country": "India",
        "estimateLabel": "Visitor visa interview wait time",
        "estimateValueDays": 120,
        "freshUntil": "2026-05-09T08:00:00Z",
        "parserStatus": "parsed",
        "parserVersion": "fixture-parser-1",
        "postCity": "Chennai",
        "sourceName": "Public visa wait time estimate",
        "sourcePermission": "public_estimate_context",
        "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
        "triggersSlotAlerts": False,
        "visaClass": "B1/B2",
    }

    accepted = client.post("/v1/public-estimates/snapshots", json=estimate_payload)
    quarantined = client.post(
        "/v1/public-estimates/snapshots",
        json=estimate_payload | {"parserStatus": "parser_failed", "parserVersion": "fixture-parser-bad"},
    )
    latest = client.get("/v1/public-estimates/latest", params={"country": "India", "postCity": "Chennai"})
    latest_with_quarantine = client.get(
        "/v1/public-estimates/latest",
        params={"country": "India", "includeQuarantined": True, "postCity": "Chennai"},
    )
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    assert accepted.status_code == 200
    assert accepted.json()["snapshot"]["status"] == "accepted"
    assert accepted.json()["snapshot"]["freshnessLabel"] == "fresh"
    assert accepted.json()["snapshot"]["triggersSlotAlerts"] is False
    assert quarantined.status_code == 200
    assert quarantined.json()["snapshot"]["status"] == "quarantined"
    assert quarantined.json()["snapshot"]["quarantineReason"] == "parser_failed"
    assert latest.status_code == 200
    assert latest.json()["estimates"][0]["availabilityClaim"] == "public_estimate_not_slot_availability"
    assert latest.json()["estimates"][0]["triggersSlotAlerts"] is False
    assert latest.json()["quarantinedCount"] == 1
    assert len(latest_with_quarantine.json()["estimates"]) == 2
    assert pending == []


def test_contributor_rate_limit_blocks_spam_and_records_non_pii_abuse_audit() -> None:
    client = make_client()
    contributor_id = "contributor:rate-001"

    for index in range(5):
        response = client.post(
            "/v1/slot-reports",
            json=slot_report_payload()
            | {
                "availableDates": [f"2026-06-{12 + index:02d}"],
                "contributorId": contributor_id,
                "postCity": f"Chennai{index}",
            },
        )
        assert response.status_code == 200

    blocked = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-30"],
            "contributorId": contributor_id,
            "postCity": "Chennai5",
        },
    )
    trust = client.get(f"/v1/contributors/{contributor_id}/trust").json()["trust"]
    abuse_audit = client.get(f"/v1/contributors/{contributor_id}/abuse-audit")

    assert blocked.status_code == 429
    assert blocked.json()["detail"]["action"] == "rate_limited"
    assert blocked.json()["detail"]["containsSensitiveRawData"] is False
    assert trust["rateLimitPolicy"] == {
        "currentWindowReports": 5,
        "limited": True,
        "maxReports": 5,
        "windowHours": 1,
    }
    assert trust["abuseAuditEventCount"] == 6
    assert trust["abuseReviewRequired"] is False
    assert trust["piiStored"] is False
    assert abuse_audit.status_code == 200
    body = abuse_audit.json()
    assert body["containsSensitiveRawData"] is False
    assert [event["action"] for event in body["auditEvents"]][-1] == "rate_limited"
    assert "email" not in str(body).casefold()
    assert "ipaddress" not in str(body).casefold()


def test_contributor_moderation_notes_restrict_without_pii() -> None:
    client = make_client()
    contributor_id = "contributor:review-001"
    client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-12"],
            "contributorId": contributor_id,
        },
    )

    created = client.post(
        f"/v1/contributors/{contributor_id}/moderation-notes",
        json={
            "containsSensitiveRawData": False,
            "note": "Local review: repeated low-confidence reports from visible metadata only.",
            "reason": "rate_limit_review",
            "reviewStatus": "restricted",
        },
    )
    notes = client.get(f"/v1/contributors/{contributor_id}/moderation-notes")
    trust = client.get(f"/v1/contributors/{contributor_id}/trust")
    sensitive = client.post(
        f"/v1/contributors/{contributor_id}/moderation-notes",
        json={
            "containsSensitiveRawData": False,
            "note": "Review contains email person@example.com and OTP.",
            "reason": "manual_review",
            "reviewStatus": "watch",
        },
    )

    assert created.status_code == 200
    assert created.json()["note"]["containsSensitiveRawData"] is False
    assert created.json()["note"]["noteId"].startswith("contributor-note:")
    assert created.json()["note"]["reviewStatus"] == "restricted"
    assert notes.status_code == 200
    assert notes.json()["containsSensitiveRawData"] is False
    assert notes.json()["notes"][0]["reason"] == "rate_limit_review"
    assert trust.json()["trust"]["localReviewStatus"] == "restricted"
    assert trust.json()["trust"]["moderationNoteCount"] == 1
    assert trust.json()["trust"]["reputationStatus"] == "restricted"
    assert trust.json()["trust"]["piiStored"] is False
    assert sensitive.status_code == 422


def test_restricted_contributor_report_is_quality_suppressed_and_not_queued() -> None:
    client = make_client()
    contributor_id = "contributor:quality-001"
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    moderation = client.post(
        f"/v1/contributors/{contributor_id}/moderation-notes",
        json={
            "containsSensitiveRawData": False,
            "note": "Local review: restrict this non-PII contributor key before alerts.",
            "reason": "manual_review",
            "reviewStatus": "restricted",
        },
    )

    report = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-12"],
            "contributorId": contributor_id,
        },
    )
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    latest_default = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]
    latest_review = client.get(
        "/v1/slot-reports/latest",
        params={
            "country": "India",
            "includeLowTrust": True,
            "postCity": "Chennai",
            "targetStartDate": "2026-06-01",
            "targetEndDate": "2026-06-30",
            "visaClass": "B1/B2",
        },
    ).json()["reports"]

    assert moderation.status_code == 200
    assert report.status_code == 200
    trust = report.json()["trust"]
    assert trust["status"] == "accepted_unique"
    assert trust["eligibleForNotification"] is False
    assert trust["qualityTier"] == "suppressed"
    assert trust["qualityScore"] < 65
    assert "local_review_restricted" in trust["qualitySignals"]
    assert trust["suppressionReasons"] == ["restricted_contributor", "low_quality_score"]
    assert pending == []
    assert latest_default == []
    assert [row["reportId"] for row in latest_review] == [report.json()["reportId"]]


def test_independent_corroboration_can_queue_previously_low_quality_unique_report() -> None:
    client = make_client()
    first_contributor_id = "contributor:watch-001"
    second_contributor_id = "contributor:normal-002"
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post(
        f"/v1/contributors/{first_contributor_id}/moderation-notes",
        json={
            "containsSensitiveRawData": False,
            "note": "Local review: watch-only contributor requires corroboration.",
            "reason": "manual_review",
            "reviewStatus": "watch",
        },
    )
    first = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-12"],
            "confidence": "community_report",
            "contributorId": first_contributor_id,
        },
    ).json()
    pending_before = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    duplicate = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-12"],
            "confidence": "community_report",
            "contributorId": second_contributor_id,
        },
    ).json()
    pending_after = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    assert first["trust"]["qualityTier"] == "low"
    assert first["trust"]["eligibleForNotification"] is False
    assert pending_before == []
    assert duplicate["trust"]["status"] == "accepted_duplicate"
    assert pending_after[0]["reportId"] == first["reportId"]
    assert pending_after[0]["reportTrust"]["eligibleForNotification"] is True
    assert pending_after[0]["reportTrust"]["independentContributorCount"] == 2
    assert "independent_corroboration" in pending_after[0]["reportTrust"]["qualitySignals"]


def test_notification_policy_digest_backoff_cleanup_and_last_delivery_display() -> None:
    client = make_client()
    digest_subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "cooldownMinutes": 15,
            "country": "India",
            "deliveryMode": "digest",
            "digestWindowMinutes": 60,
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    digest_report = client.post("/v1/slot-reports", json=slot_report_payload()).json()
    immediate_pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    digest_queue = client.get("/v1/alert-notifications/digest").json()

    assert digest_subscription["deliveryMode"] == "digest"
    assert digest_report["trust"]["eligibleForNotification"] is True
    assert immediate_pending == []
    assert digest_queue["containsSensitiveRawData"] is False
    assert digest_queue["slotAlertsDelivered"] is False
    assert digest_queue["groups"][0]["deliveryMode"] == "digest"
    assert digest_queue["groups"][0]["pendingCount"] == 1
    assert digest_queue["groups"][0]["matches"][0]["deliveryMode"] == "digest"

    immediate_subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "deliveryMode": "immediate",
            "postCities": ["Hyderabad"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-24"],
            "postCity": "Hyderabad",
        },
    )
    retry_notification = client.get("/v1/alert-notifications/pending").json()["pendingMatches"][0][
        "notificationEvent"
    ]["notificationId"]
    client.post(
        f"/v1/alert-notifications/{retry_notification}/delivery-ack",
        json={
            "acknowledgedAt": "2030-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "failed",
            "reason": "browser_create_failed",
        },
    )
    default_backoff_pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    visible_backoff_pending = client.get(
        "/v1/alert-notifications/pending",
        params={"includeBackoff": True},
    ).json()["pendingMatches"]
    sent = client.post(
        f"/v1/alert-notifications/{retry_notification}/delivery-ack",
        json={
            "acknowledgedAt": "2030-05-08T08:02:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )
    subscriptions_after_sent = client.get("/v1/alert-subscriptions", params={"includeDeleted": True}).json()[
        "subscriptions"
    ]

    assert default_backoff_pending == []
    assert visible_backoff_pending[0]["retryAttemptCount"] == 1
    assert visible_backoff_pending[0]["lastDeliveryAttemptAt"] == "2030-05-08T08:00:00Z"
    assert visible_backoff_pending[0]["nextRetryAt"] == "2030-05-08T08:01:00Z"
    assert sent.status_code == 200
    assert next(
        subscription
        for subscription in subscriptions_after_sent
        if subscription["subscriptionId"] == immediate_subscription["subscriptionId"]
    )["lastNotificationAt"] == "2030-05-08T08:02:00Z"


def test_digest_delivery_ack_marks_group_sent_and_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_digest_ack.sqlite3"
    client = make_durable_client(db_path)
    subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "cooldownMinutes": 15,
            "country": "India",
            "deliveryMode": "digest",
            "digestWindowMinutes": 60,
            "postCities": ["Chennai", "Hyderabad"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    client.post("/v1/slot-reports", json=slot_report_payload() | {"availableDates": ["2026-06-12"]})
    client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-24"],
            "postCity": "Hyderabad",
        },
    )

    digest_before = client.get("/v1/alert-notifications/digest").json()
    ack = client.post(
        f"/v1/alert-notifications/digest/{subscription['subscriptionId']}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": False,
            "deliveryStatus": "sent",
            "reason": "digest_summary_sent",
        },
    )
    replay = client.post(
        f"/v1/alert-notifications/digest/{subscription['subscriptionId']}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:01:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": False,
            "deliveryStatus": "sent",
            "reason": "digest_summary_sent",
        },
    )
    fresh_client = make_durable_client(db_path)
    digest_after = fresh_client.get("/v1/alert-notifications/digest").json()
    pending_after = fresh_client.get("/v1/alert-notifications/pending", params={"includeDigest": True}).json()
    history = fresh_client.get("/v1/alert-notifications/delivery-history").json()
    subscriptions_after = fresh_client.get("/v1/alert-subscriptions", params={"includeDeleted": True}).json()[
        "subscriptions"
    ]

    assert digest_before["groups"][0]["pendingCount"] == 2
    assert ack.status_code == 200
    assert ack.json()["containsSensitiveRawData"] is False
    assert ack.json()["acknowledgedCount"] == 2
    assert ack.json()["replayedCount"] == 0
    assert {event["reason"] for event in ack.json()["deliveryAudits"]} == {"digest_summary_sent"}
    assert {event["deliveryStatus"] for event in ack.json()["deliveryAudits"]} == {"sent"}
    assert replay.status_code == 200
    assert replay.json()["acknowledgedCount"] == 0
    assert replay.json()["replayedCount"] == 2
    assert digest_after["groups"] == []
    assert pending_after["pendingMatches"] == []
    assert history["countsByStatus"]["sent"] == 2
    assert {event["reason"] for event in history["auditEvents"]} == {"digest_summary_sent"}
    assert next(
        item for item in subscriptions_after if item["subscriptionId"] == subscription["subscriptionId"]
    )["lastNotificationAt"] == "2026-05-08T08:00:00Z"


def test_digest_delivery_ack_marks_group_suppressed() -> None:
    client = make_client()
    subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "deliveryMode": "digest",
            "digestWindowMinutes": 60,
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    client.post("/v1/slot-reports", json=slot_report_payload())

    suppressed = client.post(
        f"/v1/alert-notifications/digest/{subscription['subscriptionId']}/delivery-ack",
        json={
            "acknowledgedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": False,
            "deliveryStatus": "suppressed",
            "reason": "digest_suppressed_by_user",
        },
    )
    history = client.get("/v1/alert-notifications/delivery-history").json()

    assert suppressed.status_code == 200
    assert suppressed.json()["acknowledgedCount"] == 1
    assert suppressed.json()["deliveryStatus"] == "suppressed"
    assert suppressed.json()["deliveryAudits"][0]["reason"] == "digest_suppressed_by_user"
    assert client.get("/v1/alert-notifications/digest").json()["groups"] == []
    assert history["countsByStatus"] == {"failed": 0, "sent": 0, "suppressed": 1}

    cleanup_subscription = client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Mumbai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    ).json()["subscription"]
    cleanup_report = client.post(
        "/v1/slot-reports",
        json=slot_report_payload()
        | {
            "availableDates": ["2026-06-26"],
            "capturedAt": "2030-05-08T08:00:00Z",
            "postCity": "Mumbai",
        },
    ).json()
    cleanup = client.post(
        "/v1/alert-notifications/pending/cleanup",
        json={
            "checkedAt": "2030-05-08T15:00:00Z",
            "dryRun": False,
        },
    )
    remaining_cleanup_matches = [
        match
        for match in client.get(
            "/v1/alert-notifications/pending",
            params={"includeBackoff": True, "includeDigest": True},
        ).json()["pendingMatches"]
        if match["subscriptionId"] == cleanup_subscription["subscriptionId"]
    ]

    assert cleanup_report["freshUntil"] == "2030-05-08T14:00:00Z"
    assert cleanup.status_code == 200
    assert cleanup.json()["cleanupReason"] == "stale_pending_cleanup"
    assert cleanup.json()["matchedPendingMatches"] >= 1
    assert cleanup.json()["deletedPendingMatches"] >= 1
    assert remaining_cleanup_matches == []


def test_notification_adapter_sandbox_records_email_and_telegram_without_external_delivery() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["email", "telegram"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    pending_before = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    notification_id = pending_before[0]["notificationEvent"]["notificationId"]

    sandbox = client.post(
        "/v1/alert-notifications/adapter-sandbox",
        json={
            "adapterMode": "sandbox_only",
            "channels": ["email", "telegram"],
            "containsSensitiveRawData": False,
            "includeDigest": False,
            "recordedAt": "2026-05-08T08:00:00Z",
        },
    )
    pending_after = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    history = client.get("/v1/alert-notifications/adapter-sandbox/history").json()

    assert sandbox.status_code == 200
    body = sandbox.json()
    assert body["adapterMode"] == "sandbox_only"
    assert body["containsSensitiveRawData"] is False
    assert body["externalNetworkCallAttempted"] is False
    assert body["liveProviderConfigured"] is False
    assert body["slotAlertsDelivered"] is False
    assert body["countsByStatus"] == {"recorded": 2, "skipped": 0, "suppressed": 0}
    assert [delivery["channel"] for delivery in body["deliveries"]] == ["email", "telegram"]
    assert {delivery["status"] for delivery in body["deliveries"]} == {"recorded"}
    assert {delivery["reason"] for delivery in body["deliveries"]} == {"sandbox_payload_recorded"}
    assert all(delivery["notificationId"] == notification_id for delivery in body["deliveries"])
    assert all(delivery["externalNetworkCallAttempted"] is False for delivery in body["deliveries"])
    assert all(delivery["liveProviderConfigured"] is False for delivery in body["deliveries"])
    assert all(delivery["payload"]["containsSensitiveRawData"] is False for delivery in body["deliveries"])
    assert all(delivery["payload"]["containsBookingConfirmation"] is False for delivery in body["deliveries"])
    assert all(delivery["payload"]["availabilityClaim"] == "community_report_not_official_confirmation" for delivery in body["deliveries"])
    assert all(delivery["payload"]["externalNetworkCallAttempted"] is False for delivery in body["deliveries"])
    assert "No appointment action was taken" in body["deliveries"][0]["payload"]["body"]
    assert "password" not in str(body).casefold()
    assert "cookie" not in str(body).casefold()
    assert "otp" not in str(body).casefold()
    assert pending_after[0]["notificationEvent"]["notificationId"] == notification_id
    assert history["countsByStatus"] == {"recorded": 2, "skipped": 0, "suppressed": 0}
    assert [delivery["channel"] for delivery in history["deliveries"]] == ["email", "telegram"]


def test_notification_adapter_sandbox_skips_unsubscribed_external_channels() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())

    sandbox = client.post(
        "/v1/alert-notifications/adapter-sandbox",
        json={
            "adapterMode": "sandbox_only",
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "includeDigest": False,
        },
    )
    invalid_channel = client.post(
        "/v1/alert-notifications/adapter-sandbox",
        json={
            "adapterMode": "sandbox_only",
            "channels": ["browser"],
            "containsSensitiveRawData": False,
            "includeDigest": False,
        },
    )

    assert sandbox.status_code == 200
    body = sandbox.json()
    assert body["countsByStatus"] == {"recorded": 0, "skipped": 1, "suppressed": 0}
    assert body["deliveries"][0]["channel"] == "email"
    assert body["deliveries"][0]["status"] == "skipped"
    assert body["deliveries"][0]["reason"] == "channel_not_subscribed"
    assert body["deliveries"][0]["payload"] is None
    assert invalid_channel.status_code == 422


def test_provider_boundary_slack_sandbox_records_without_webhook_or_external_delivery() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["slack", "browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    pending_before = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    sandbox = client.post(
        "/v1/alert-notifications/adapter-sandbox",
        json={
            "adapterMode": "sandbox_only",
            "channels": ["slack"],
            "containsSensitiveRawData": False,
            "includeDigest": False,
            "recordedAt": "2026-05-08T08:30:00Z",
        },
    )
    pending_after = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    assert sandbox.status_code == 200
    body = sandbox.json()
    assert body["countsByStatus"] == {"recorded": 1, "skipped": 0, "suppressed": 0}
    delivery = body["deliveries"][0]
    assert delivery["channel"] == "slack"
    assert delivery["status"] == "recorded"
    assert delivery["externalNetworkCallAttempted"] is False
    assert delivery["liveProviderConfigured"] is False
    assert delivery["payload"]["providerEndpoint"] == "not_called"
    assert delivery["payload"]["recipientRef"] == "sandbox-recipient:slack:local-reviewer"
    assert delivery["payload"]["containsSensitiveRawData"] is False
    assert delivery["payload"]["containsBookingConfirmation"] is False
    assert "webhook" not in str(body).casefold()
    assert "token" not in str(body).casefold()
    assert pending_after[0]["notificationEvent"]["notificationId"] == pending_before[0]["notificationEvent"]["notificationId"]


def test_delivery_readiness_delivery_readiness_boundary_is_disabled_by_default() -> None:
    client = make_client()

    response = client.get("/v1/alert-notifications/provider-readiness")

    assert response.status_code == 200
    body = response.json()
    assert body["containsSensitiveRawData"] is False
    assert body["providerSafeOutboxEnabled"] is True
    assert body["externalProviderDeliveryEnabled"] is False
    assert body["externalNetworkCallAttempted"] is False
    assert body["liveProviderConfigured"] is False
    assert body["credentialStorageMode"] == "not_configured"
    assert body["deliveryBoundary"] == "browser_digest_primary_provider_outbox_disabled"
    assert body["safeDefaultDeliveryModes"] == ["browser", "digest"]
    assert body["providerChannels"] == ["email", "telegram", "slack"]
    assert "external_provider_delivery_disabled_by_default" in body["blockedReasons"]
    assert body["nextRequiredProof"] == "delivery_readiness_provider_configuration_not_implemented"


def test_delivery_readiness_provider_safe_outbox_records_intent_without_external_send_or_ack() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["email", "slack"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())
    pending_before = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    notification_id = pending_before[0]["notificationEvent"]["notificationId"]

    outbox = client.post(
        "/v1/alert-notifications/provider-outbox",
        json={
            "adapterMode": "provider_safe_outbox",
            "channels": ["email", "slack"],
            "containsSensitiveRawData": False,
            "externalDeliveryEnabled": False,
            "includeDigest": False,
            "recordedAt": "2026-05-08T09:00:00Z",
        },
    )
    pending_after = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]
    delivery_history = client.get("/v1/alert-notifications/delivery-history").json()
    outbox_history = client.get("/v1/alert-notifications/provider-outbox/history").json()

    assert outbox.status_code == 200
    body = outbox.json()
    assert body["adapterMode"] == "provider_safe_outbox"
    assert body["countsByStatus"] == {"queued_disabled": 2, "skipped": 0, "suppressed": 0}
    assert body["externalDeliveryEnabled"] is False
    assert body["externalNetworkCallAttempted"] is False
    assert body["liveProviderConfigured"] is False
    assert body["slotAlertsDelivered"] is False
    assert [delivery["channel"] for delivery in body["deliveries"]] == ["email", "slack"]
    assert all(delivery["status"] == "queued_disabled" for delivery in body["deliveries"])
    assert all(delivery["reason"] == "provider_disabled_by_default" for delivery in body["deliveries"])
    assert all(delivery["notificationId"] == notification_id for delivery in body["deliveries"])
    assert all(delivery["payload"]["providerEndpoint"] == "disabled_by_default" for delivery in body["deliveries"])
    assert all(delivery["payload"]["containsSensitiveRawData"] is False for delivery in body["deliveries"])
    assert all(delivery["payload"]["externalNetworkCallAttempted"] is False for delivery in body["deliveries"])
    assert all(delivery["payload"]["retryBackoffSeconds"] >= 60 for delivery in body["deliveries"])
    assert "password" not in str(body).casefold()
    assert "cookie" not in str(body).casefold()
    assert "token" not in str(body).casefold()
    assert pending_after[0]["notificationEvent"]["notificationId"] == notification_id
    assert delivery_history["auditEvents"] == []
    assert outbox_history["countsByStatus"] == {"queued_disabled": 2, "skipped": 0, "suppressed": 0}
    assert [delivery["channel"] for delivery in outbox_history["deliveries"]] == ["email", "slack"]


def test_delivery_readiness_provider_safe_outbox_skips_unsubscribed_and_rejects_enabled_delivery() -> None:
    client = make_client()
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    client.post("/v1/slot-reports", json=slot_report_payload())

    outbox = client.post(
        "/v1/alert-notifications/provider-outbox",
        json={
            "adapterMode": "provider_safe_outbox",
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "externalDeliveryEnabled": False,
            "includeDigest": False,
        },
    )
    invalid_enabled = client.post(
        "/v1/alert-notifications/provider-outbox",
        json={
            "adapterMode": "provider_safe_outbox",
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "externalDeliveryEnabled": True,
            "includeDigest": False,
        },
    )

    assert outbox.status_code == 200
    assert outbox.json()["countsByStatus"] == {"queued_disabled": 0, "skipped": 1, "suppressed": 0}
    assert outbox.json()["deliveries"][0]["status"] == "skipped"
    assert outbox.json()["deliveries"][0]["reason"] == "channel_not_subscribed"
    assert outbox.json()["deliveries"][0]["payload"] is None
    assert invalid_enabled.status_code == 422


def test_delivery_readiness_provider_safe_outbox_persists_for_durable_store(tmp_path: Path) -> None:
    db_path = tmp_path / "slot_signal_provider_outbox.sqlite3"
    first_client = make_durable_client(db_path)
    first_client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["telegram"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    first_client.post("/v1/slot-reports", json=slot_report_payload())
    outbox = first_client.post(
        "/v1/alert-notifications/provider-outbox",
        json={
            "adapterMode": "provider_safe_outbox",
            "channels": ["telegram"],
            "containsSensitiveRawData": False,
            "externalDeliveryEnabled": False,
            "includeDigest": False,
            "recordedAt": "2026-05-08T09:30:00Z",
        },
    )

    fresh_client = make_durable_client(db_path)
    history = fresh_client.get("/v1/alert-notifications/provider-outbox/history").json()

    assert outbox.status_code == 200
    assert outbox.json()["deliveries"][0]["status"] == "queued_disabled"
    assert history["deliveries"][0]["channel"] == "telegram"
    assert history["deliveries"][0]["status"] == "queued_disabled"
    assert history["externalNetworkCallAttempted"] is False


def test_provider_boundary_public_context_summary_groups_estimates_and_never_generates_alerts() -> None:
    client = make_client(clock_now=PUBLIC_ESTIMATE_TEST_NOW)
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )
    base_payload = {
        "adapterMode": "fixture_replay",
        "containsSensitiveRawData": False,
        "country": "India",
        "estimateLabel": "Visitor visa interview wait time",
        "fixtureText": "Visitor visa interview wait time: 120 days",
        "parserVersion": "fixture-public-estimate-v1",
        "postCity": "Chennai",
        "quarantineByDefault": True,
        "sourceId": "travel_state_global_wait_times",
        "sourceName": "Public visa wait time estimate fixture",
        "sourcePermission": "public_estimate_context",
        "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
        "triggersSlotAlerts": False,
        "visaClass": "B1/B2",
    }
    client.post("/v1/public-estimates/import-fixture", json=base_payload | {"capturedAt": "2026-05-08T08:00:00Z"})
    client.post(
        "/v1/public-estimates/import-fixture",
        json=base_payload
        | {
            "capturedAt": "2026-05-06T08:00:00Z",
            "freshUntil": "2026-05-07T08:00:00Z",
        },
    )
    client.post(
        "/v1/public-estimates/import-fixture",
        json=base_payload
        | {
            "capturedAt": "2026-05-08T09:00:00Z",
            "fixtureText": "Visitor visa wait layout changed: unavailable",
        },
    )

    summary = client.get(
        "/v1/public-context/summary",
        params={"country": "India", "includeQuarantined": True, "postCity": "Chennai", "visaClass": "B1/B2"},
    )
    summary_without_quarantine = client.get(
        "/v1/public-context/summary",
        params={"country": "India", "postCity": "Chennai", "visaClass": "B1/B2"},
    )
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    assert summary.status_code == 200
    body = summary.json()
    assert body["containsSensitiveRawData"] is False
    assert body["liveFetchAttempted"] is False
    assert body["slotAlertsDelivered"] is False
    assert body["slotAlertTriggerAttempted"] is False
    context = body["contexts"][0]
    assert context["availabilityClaim"] == "public_context_not_slot_availability"
    assert context["alertTriggerAllowed"] is False
    assert context["slotAlertTriggerAttempted"] is False
    assert context["recommendedUse"] == "decision_context_only"
    assert context["status"] == "mixed"
    assert context["freshnessLabel"] == "mixed"
    assert context["acceptedEstimateCount"] == 2
    assert context["quarantinedEstimateCount"] == 1
    assert context["staleEstimateCount"] == 1
    assert context["totalEstimateCount"] == 3
    assert context["latestEstimateLabel"] == "Visitor visa interview wait time"
    assert context["latestEstimateValueDays"] == 0
    assert set(context["parserStatuses"]) == {"parsed", "parser_failed", "source_stale"}
    assert context["sourceNames"] == ["Department of State Global Visa Wait Times"]
    assert summary_without_quarantine.json()["contexts"][0]["totalEstimateCount"] == 2
    assert summary_without_quarantine.json()["quarantinedContextCount"] == 1
    assert pending == []


def test_public_estimate_fixture_importer_quarantines_parser_drift_and_never_alerts() -> None:
    client = make_client(clock_now=PUBLIC_ESTIMATE_TEST_NOW)
    client.post(
        "/v1/alert-subscriptions",
        json={
            "active": True,
            "channels": ["browser"],
            "country": "India",
            "postCities": ["Chennai"],
            "targetEndDate": "2026-06-30",
            "targetStartDate": "2026-06-01",
            "visaClasses": ["B1/B2"],
        },
    )

    accepted = client.post(
        "/v1/public-estimates/import-fixture",
        json={
            "adapterMode": "fixture_replay",
            "capturedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "fixtureText": "Visitor visa interview wait time: 120 days",
            "parserVersion": "fixture-public-estimate-v1",
            "postCity": "Chennai",
            "quarantineByDefault": True,
            "sourceId": "travel_state_global_wait_times",
            "sourceName": "Public visa wait time estimate fixture",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )
    stale = client.post(
        "/v1/public-estimates/import-fixture",
        json={
            "adapterMode": "fixture_replay",
            "capturedAt": "2026-05-06T08:00:00Z",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "fixtureText": "Visitor visa interview wait time: 120 days",
            "freshUntil": "2026-05-07T08:00:00Z",
            "parserVersion": "fixture-public-estimate-v1",
            "postCity": "Chennai",
            "quarantineByDefault": True,
            "sourceId": "travel_state_global_wait_times",
            "sourceName": "Public visa wait time estimate fixture",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )
    drifted = client.post(
        "/v1/public-estimates/import-fixture",
        json={
            "adapterMode": "fixture_replay",
            "capturedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "fixtureText": "Visitor visa wait layout changed: unavailable",
            "parserVersion": "fixture-public-estimate-v1",
            "postCity": "Chennai",
            "quarantineByDefault": True,
            "sourceId": "travel_state_global_wait_times",
            "sourceName": "Public visa wait time estimate fixture",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )
    blocked_source = client.post(
        "/v1/public-estimates/import-fixture",
        json={
            "adapterMode": "fixture_replay",
            "capturedAt": "2026-05-08T08:00:00Z",
            "containsSensitiveRawData": False,
            "country": "India",
            "estimateLabel": "Visitor visa interview wait time",
            "fixtureText": "Visitor visa interview wait time: 120 days",
            "parserVersion": "fixture-public-estimate-v1",
            "postCity": "Chennai",
            "quarantineByDefault": True,
            "sourceId": "travel_state_global_wait_times",
            "sourceName": "Unknown estimate fixture",
            "sourcePermission": "public_estimate_context",
            "sourceUrl": "https://example.com/not-allowlisted.html",
            "triggersSlotAlerts": False,
            "visaClass": "B1/B2",
        },
    )
    latest = client.get(
        "/v1/public-estimates/latest",
        params={"country": "India", "includeQuarantined": True, "postCity": "Chennai"},
    ).json()
    pending = client.get("/v1/alert-notifications/pending").json()["pendingMatches"]

    assert accepted.status_code == 200
    assert accepted.json()["allowlistStatus"] == "allowlisted"
    assert accepted.json()["liveFetchAttempted"] is False
    assert accepted.json()["parserDriftDetected"] is False
    assert accepted.json()["slotAlertTriggerAttempted"] is False
    assert accepted.json()["snapshot"]["estimateValueDays"] == 120
    assert accepted.json()["snapshot"]["status"] == "accepted"
    assert accepted.json()["snapshot"]["sourceName"] == "Department of State Global Visa Wait Times"
    assert stale.status_code == 200
    assert stale.json()["parserDriftDetected"] is False
    assert stale.json()["slotAlertTriggerAttempted"] is False
    assert stale.json()["snapshot"]["freshnessLabel"] == "stale"
    assert stale.json()["snapshot"]["parserStatus"] == "source_stale"
    assert stale.json()["snapshot"]["status"] == "accepted"
    assert drifted.status_code == 200
    assert drifted.json()["parserDriftDetected"] is True
    assert drifted.json()["slotAlertTriggerAttempted"] is False
    assert drifted.json()["snapshot"]["status"] == "quarantined"
    assert drifted.json()["snapshot"]["quarantineReason"] == "parser_failed"
    assert blocked_source.status_code == 422
    assert blocked_source.json()["detail"]["allowlistStatus"] == "blocked"
    assert latest["quarantinedCount"] == 1
    assert {estimate["status"] for estimate in latest["estimates"]} == {"accepted", "quarantined"}
    assert pending == []
