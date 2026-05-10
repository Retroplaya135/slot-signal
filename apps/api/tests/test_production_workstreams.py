from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


ADMIN_TOKEN = "production_boundary-admin-token"
CLIENT_TOKEN = "production_boundary-client-token"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def production_client(*, provider_delivery_mode: str = "dry_run", **settings_overrides: object) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                admin_token_sha256=token_hash(ADMIN_TOKEN),
                allowed_origins=("https://app.slot-signal.test",),
                app_name="Slot Signal API Production Workstream Test",
                client_token_sha256=token_hash(CLIENT_TOKEN),
                environment="production",
                production_api_origin="https://api.slot-signal.test",
                provider_delivery_mode=provider_delivery_mode,  # type: ignore[arg-type]
                **settings_overrides,
            )
        )
    )


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def slot_report_payload() -> dict:
    return {
        "availableDates": ["2026-06-18", "2026-06-12"],
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


def subscription_payload() -> dict:
    return {
        "active": True,
        "channels": ["browser", "email", "telegram", "slack"],
        "country": "India",
        "postCities": ["Chennai"],
        "targetEndDate": "2026-06-30",
        "targetStartDate": "2026-06-01",
        "visaClasses": ["B1/B2"],
    }


def provider_outbox_payload() -> dict:
    return {
        "adapterMode": "provider_safe_outbox",
        "channels": ["email", "telegram", "slack"],
        "containsSensitiveRawData": False,
        "externalDeliveryEnabled": False,
        "includeDigest": False,
    }


def test_production_mutations_require_client_or_admin_token() -> None:
    client = production_client()

    unauthenticated = client.post("/v1/slot-reports", json=slot_report_payload())
    wrong_token = client.post("/v1/slot-reports", headers=auth("wrong"), json=slot_report_payload())
    authenticated = client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload())

    assert unauthenticated.status_code == 401
    assert wrong_token.status_code == 401
    assert authenticated.status_code == 200
    assert authenticated.json()["credentialDataIncluded"] is False
    assert authenticated.json()["portalAutomationUsed"] is False


def test_production_admin_controls_require_admin_token() -> None:
    client = production_client()
    created = client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload()).json()

    no_token = client.get("/v1/slot-signal/export")
    client_token = client.get("/v1/slot-signal/export", headers=auth(CLIENT_TOKEN))
    admin_token = client.get("/v1/slot-signal/export", headers=auth(ADMIN_TOKEN))

    assert no_token.status_code == 401
    assert client_token.status_code == 403
    assert admin_token.status_code == 200
    assert created["reportId"] in {report["reportId"] for report in admin_token.json()["reports"]}


def test_production_sensitive_read_endpoints_require_token() -> None:
    client = production_client()
    contributor_id = "contributor:prod-read-001"
    subscription = client.post(
        "/v1/alert-subscriptions",
        headers=auth(CLIENT_TOKEN),
        json=subscription_payload(),
    ).json()["subscription"]
    client.post(
        "/v1/slot-reports",
        headers=auth(CLIENT_TOKEN),
        json=slot_report_payload() | {"contributorId": contributor_id},
    )
    notification_id = client.get(
        "/v1/alert-notifications/pending",
        headers=auth(CLIENT_TOKEN),
    ).json()["pendingMatches"][0]["notificationEvent"]["notificationId"]
    client.post(
        f"/v1/alert-notifications/{notification_id}/delivery-ack",
        headers=auth(CLIENT_TOKEN),
        json={
            "containsSensitiveRawData": False,
            "deliveryAttemptedInBrowser": True,
            "deliveryStatus": "sent",
            "reason": "browser_notification_created",
        },
    )
    client.put(
        f"/v1/contributors/{contributor_id}/identity",
        headers=auth(CLIENT_TOKEN),
        json={
            "containsSensitiveRawData": False,
            "contributorKeyId": "contributor-key:prod-read-001",
            "createdAt": "2026-05-08T08:00:00Z",
            "lastSeenAt": "2026-05-08T08:05:00Z",
            "piiStored": False,
            "proofKind": "opaque_local_key",
            "rotationCount": 0,
            "storageScope": "extension_local_storage",
        },
    )
    client.post(
        f"/v1/contributors/{contributor_id}/moderation-notes",
        headers=auth(ADMIN_TOKEN),
        json={
            "containsSensitiveRawData": False,
            "note": "Admin review note without PII.",
            "reason": "manual_review",
            "reviewStatus": "watch",
        },
    )
    client.post(
        "/v1/alert-notifications/adapter-sandbox",
        headers=auth(ADMIN_TOKEN),
        json={"adapterMode": "sandbox_only", "channels": ["email"], "containsSensitiveRawData": False},
    )
    client.post(
        "/v1/alert-notifications/provider-outbox",
        headers=auth(ADMIN_TOKEN),
        json=provider_outbox_payload(),
    )

    client_read_paths = [
        "/v1/slot-reports/latest",
        "/v1/alert-subscriptions",
        f"/v1/alert-subscriptions/{subscription['subscriptionId']}/matches",
        f"/v1/contributors/{contributor_id}/trust",
        f"/v1/contributors/{contributor_id}/identity",
        "/v1/public-estimates/latest",
        "/v1/public-context/summary",
        "/v1/alert-notifications/pending",
        "/v1/alert-notifications/digest",
        f"/v1/alert-notifications/{notification_id}/delivery-audit",
        "/v1/alert-notifications/delivery-history",
    ]
    admin_read_paths = [
        f"/v1/contributors/{contributor_id}/abuse-audit",
        f"/v1/contributors/{contributor_id}/moderation-notes",
        "/v1/alert-notifications/adapter-sandbox/history",
        "/v1/alert-notifications/provider-readiness",
        "/v1/alert-notifications/provider-outbox/history",
    ]

    for path in client_read_paths:
        assert client.get(path).status_code == 401, path
        assert client.get(path, headers=auth("wrong")).status_code == 401, path
        assert client.get(path, headers=auth(CLIENT_TOKEN)).status_code == 200, path
        assert client.get(path, headers=auth(ADMIN_TOKEN)).status_code == 200, path

    for path in admin_read_paths:
        assert client.get(path).status_code == 401, path
        assert client.get(path, headers=auth(CLIENT_TOKEN)).status_code == 403, path
        assert client.get(path, headers=auth(ADMIN_TOKEN)).status_code == 200, path


def test_provider_delivery_dry_run_dispatches_from_safe_outbox_without_network() -> None:
    client = production_client(provider_delivery_mode="dry_run")
    client.post("/v1/alert-subscriptions", headers=auth(CLIENT_TOKEN), json=subscription_payload())
    client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload())
    outbox = client.post(
        "/v1/alert-notifications/provider-outbox",
        headers=auth(ADMIN_TOKEN),
        json=provider_outbox_payload(),
    )

    readiness = client.get("/v1/provider-delivery/readiness", headers=auth(ADMIN_TOKEN))
    dispatch = client.post(
        "/v1/provider-delivery/dispatch",
        headers=auth(ADMIN_TOKEN),
        json={
            "channels": ["email", "telegram", "slack"],
            "containsSensitiveRawData": False,
            "dryRun": True,
            "explicitConsent": True,
            "unsubscribeAction": "pause_or_delete_filter",
        },
    )

    assert outbox.status_code == 200
    assert readiness.status_code == 200
    assert readiness.json()["providerDeliveryMode"] == "dry_run"
    assert readiness.json()["storesProviderRecipients"] is False
    assert dispatch.status_code == 200
    body = dispatch.json()
    assert body["dryRun"] is True
    assert body["externalNetworkCallAttempted"] is False
    assert body["slotAlertsDelivered"] is False
    assert {result["status"] for result in body["deliveryResults"]} == {"dry_run_recorded"}
    assert all(result["auditEvent"]["consentChecked"] is True for result in body["deliveryResults"])
    assert all(result["auditEvent"]["unsubscribeAction"] == "pause_or_delete_filter" for result in body["deliveryResults"])


def test_provider_delivery_live_mode_blocks_unconfigured_channels_without_network() -> None:
    client = production_client(provider_delivery_mode="live")
    client.post("/v1/alert-subscriptions", headers=auth(CLIENT_TOKEN), json=subscription_payload())
    client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload())
    client.post(
        "/v1/alert-notifications/provider-outbox",
        headers=auth(ADMIN_TOKEN),
        json=provider_outbox_payload(),
    )

    response = client.post(
        "/v1/provider-delivery/dispatch",
        headers=auth(ADMIN_TOKEN),
        json={
            "channels": ["email", "telegram", "slack"],
            "containsSensitiveRawData": False,
            "dryRun": False,
            "explicitConsent": True,
            "unsubscribeAction": "pause_or_delete_filter",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["providerDeliveryMode"] == "live"
    assert body["externalNetworkCallAttempted"] is False
    assert body["slotAlertsDelivered"] is False
    assert {result["status"] for result in body["deliveryResults"]} == {"blocked_not_configured"}
    assert {result["reason"] for result in body["deliveryResults"]} == {"provider_channel_not_configured"}


def test_provider_delivery_missing_outbox_id_returns_safe_skip_result() -> None:
    client = production_client(provider_delivery_mode="live")

    response = client.post(
        "/v1/provider-delivery/dispatch",
        headers=auth(ADMIN_TOKEN),
        json={
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "dryRun": False,
            "explicitConsent": True,
            "outboxDeliveryIds": ["outbox:does-not-exist"],
            "unsubscribeAction": "pause_or_delete_filter",
        },
    )

    assert response.status_code == 200
    result = response.json()["deliveryResults"][0]
    assert result["status"] == "skipped"
    assert result["reason"] == "outbox_not_found"
    assert result["providerFailureCode"] is None
    assert result["auditEvent"]["providerFailureCode"] is None


def test_provider_delivery_live_email_failure_returns_safe_failure_code() -> None:
    client = production_client(
        provider_delivery_mode="live",
        email_from="alerts@example.com",
        email_to="reviewer@example.com",
        smtp_host="127.0.0.1",
        smtp_port=1,
    )
    client.post("/v1/alert-subscriptions", headers=auth(CLIENT_TOKEN), json=subscription_payload())
    client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload())
    outbox = client.post(
        "/v1/alert-notifications/provider-outbox",
        headers=auth(ADMIN_TOKEN),
        json=provider_outbox_payload() | {"channels": ["email"]},
    )

    response = client.post(
        "/v1/provider-delivery/dispatch",
        headers=auth(ADMIN_TOKEN),
        json={
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "dryRun": False,
            "explicitConsent": True,
            "outboxDeliveryIds": [
                delivery["outboxDeliveryId"]
                for delivery in outbox.json()["deliveries"]
                if delivery["channel"] == "email"
            ],
            "unsubscribeAction": "pause_or_delete_filter",
        },
    )

    assert response.status_code == 200
    result = response.json()["deliveryResults"][0]
    assert result["status"] == "failed"
    assert result["reason"] == "provider_send_failed"
    assert result["externalNetworkCallAttempted"] is True
    assert result["providerFailureCode"] in {"connection_refused", "network_error"}
    assert result["auditEvent"]["providerFailureCode"] == result["providerFailureCode"]
    assert result["providerMessageId"] is None


def test_provider_delivery_rejects_missing_explicit_consent() -> None:
    client = production_client(provider_delivery_mode="dry_run")
    client.post("/v1/alert-subscriptions", headers=auth(CLIENT_TOKEN), json=subscription_payload())
    client.post("/v1/slot-reports", headers=auth(CLIENT_TOKEN), json=slot_report_payload())
    client.post(
        "/v1/alert-notifications/provider-outbox",
        headers=auth(ADMIN_TOKEN),
        json=provider_outbox_payload(),
    )

    response = client.post(
        "/v1/provider-delivery/dispatch",
        headers=auth(ADMIN_TOKEN),
        json={
            "channels": ["email"],
            "containsSensitiveRawData": False,
            "dryRun": True,
            "explicitConsent": False,
            "unsubscribeAction": "pause_or_delete_filter",
        },
    )

    assert response.status_code == 200
    assert response.json()["deliveryResults"][0]["status"] == "skipped"
    assert response.json()["deliveryResults"][0]["reason"] == "consent_missing"
