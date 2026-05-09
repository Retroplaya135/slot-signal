from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


NOW = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)


def make_client(*, db_path: Path | None = None, entitlement_required: bool = False) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="US Visa Entitlement API Test",
                audit_db_path=str(db_path) if db_path else None,
                clock_now=NOW,
                entitlement_required=entitlement_required,
                environment="test",
            )
        )
    )


def issue_code(client: TestClient, code: str = "beta-code-123456") -> dict:
    response = client.post(
        "/v1/entitlements/access-codes",
        json={
            "accessCode": code,
            "expiresAt": (NOW + timedelta(days=14)).isoformat().replace("+00:00", "Z"),
            "notes": "issued for controlled beta",
            "tier": "beta",
        },
    )
    assert response.status_code == 200
    return response.json()["entitlement"]


def test_admin_can_issue_access_code_without_storing_raw_code() -> None:
    client = make_client()

    entitlement = issue_code(client)
    state = client.get("/v1/entitlements/access-codes")

    assert entitlement["entitlementId"].startswith("entitlement:")
    assert entitlement["accessCodeHash"] != "beta-code-123456"
    assert len(entitlement["accessCodeHash"]) == 64
    assert entitlement["rawCodeStored"] is False
    assert entitlement["status"] == "active"
    assert entitlement["tier"] == "beta"
    assert state.status_code == 200
    assert state.json()["entitlements"][0]["rawCodeStored"] is False


def test_client_can_verify_valid_code_and_audit_success() -> None:
    client = make_client()
    entitlement = issue_code(client, "beta-code-valid")

    response = client.post(
        "/v1/entitlements/access-codes/verify",
        json={"accessCode": "beta-code-valid", "requiredTier": "beta"},
    )
    audit = client.get(f"/v1/entitlements/access-codes/{entitlement['entitlementId']}/audit")

    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["entitlement"]["entitlementId"] == entitlement["entitlementId"]
    assert audit.status_code == 200
    assert audit.json()["auditEvents"][-1]["action"] == "verify_success"


def test_revoked_expired_and_malformed_codes_fail_with_audit() -> None:
    client = make_client()
    active = issue_code(client, "beta-code-revoked")
    client.patch(
        f"/v1/entitlements/access-codes/{active['entitlementId']}",
        json={"status": "revoked", "auditReason": "operator revoked beta access"},
    )
    expired_response = client.post(
        "/v1/entitlements/access-codes",
        json={
            "accessCode": "beta-code-expired",
            "expiresAt": (NOW - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
            "tier": "beta",
        },
    )
    assert expired_response.status_code == 200

    revoked = client.post("/v1/entitlements/access-codes/verify", json={"accessCode": "beta-code-revoked"})
    expired = client.post("/v1/entitlements/access-codes/verify", json={"accessCode": "beta-code-expired"})
    malformed = client.post("/v1/entitlements/access-codes/verify", json={"accessCode": "short"})

    assert revoked.status_code == 200
    assert revoked.json()["valid"] is False
    assert revoked.json()["reason"] == "revoked"
    assert expired.status_code == 200
    assert expired.json()["valid"] is False
    assert expired.json()["reason"] == "expired"
    assert malformed.status_code == 200
    assert malformed.json()["valid"] is False
    assert malformed.json()["reason"] == "malformed"
    assert client.get("/v1/entitlements/access-codes/audit").json()["containsRawAccessCodes"] is False


def test_entitlement_required_endpoint_rejects_missing_code_and_accepts_valid_code() -> None:
    client = make_client(entitlement_required=True)
    issue_code(client, "beta-code-export")

    missing = client.get("/v1/slot-signal/export")
    valid = client.get("/v1/slot-signal/export", headers={"X-Slot-Signal-Access-Code": "beta-code-export"})

    assert missing.status_code == 403
    assert missing.json()["detail"] == "Valid beta or advanced entitlement is required for this action."
    assert valid.status_code == 200
    assert valid.json()["containsSensitiveRawData"] is False


def test_durable_entitlements_survive_restart(tmp_path: Path) -> None:
    db_path = tmp_path / "slot-signal.sqlite3"
    first = make_client(db_path=db_path)
    entitlement = issue_code(first, "beta-code-durable")

    second = make_client(db_path=db_path)
    verify = second.post("/v1/entitlements/access-codes/verify", json={"accessCode": "beta-code-durable"})
    audit = second.get(f"/v1/entitlements/access-codes/{entitlement['entitlementId']}/audit")

    assert verify.status_code == 200
    assert verify.json()["valid"] is True
    assert audit.status_code == 200
    assert audit.json()["auditEvents"]
