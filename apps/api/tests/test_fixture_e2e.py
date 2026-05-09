from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def make_client() -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Test",
                environment="test",
            )
        )
    )


def fixture_e2e_payload() -> dict:
    return {
        "idempotencyKey": "idem:fixture_e2e:e2e:api:001",
        "now": "2026-05-07T21:00:00Z",
        "requestedConsulateIds": ["consulate:mumbai"],
        "requestId": "request:fixture_e2e:e2e:api:001",
        "scenario": "slots_found",
        "traceId": "trace:fixture_e2e:e2e:api:001",
    }


def test_fixture_e2e_run_creates_notification_assist_and_audit_flow() -> None:
    client = make_client()

    response = client.post("/v1/fixture-e2e/runs", json=fixture_e2e_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["replayed"] is False
    assert body["livePortalRequestMade"] is False
    assert body["appointmentChangingActionTaken"] is False
    assert body["run"]["scenario"] == "slots_found"
    assert body["run"]["status"] == "completed"
    assert body["snapshot"]["candidates"][0]["bookingAction"] == "open_official_page_only"
    assert body["bookingAssistSession"]["candidateId"] == body["snapshot"]["candidates"][0]["candidateId"]
    assert body["bookingAssistSession"]["autoSubmitAllowed"] is False
    assert body["bookingAssistSession"]["allowBookingConfirmation"] is False
    assert body["bookingAssistSession"]["visibleUserActionRequired"] is True
    assert body["notificationDispatch"]["notification"]["relatedSessionId"] == body["bookingAssistSession"]["sessionId"]
    assert body["notificationDispatch"]["deliveries"][0]["containsBookingConfirmation"] is False

    actions = [event["action"] for event in body["auditEvents"]]
    assert actions == [
        "check_requested",
        "snapshot_recorded",
        "notification_queued",
        "booking_assist_opened",
    ]
    assert all(event["containsSensitiveRawData"] is False for event in body["auditEvents"])
    assert all(event["traceId"] == "trace:fixture_e2e:e2e:api:001" for event in body["auditEvents"])

    stages = [span["stage"] for span in body["instrumentation"]["spans"]]
    assert stages == [
        "request_validated",
        "adapter_completed",
        "notification_dispatched",
        "booking_assist_prepared",
        "audit_persisted",
    ]
    assert body["instrumentation"]["idempotency"]["status"] == "created"


def test_fixture_e2e_run_is_idempotent_and_does_not_duplicate_audit_events() -> None:
    client = make_client()
    payload = fixture_e2e_payload()

    first = client.post("/v1/fixture-e2e/runs", json=payload).json()
    second = client.post("/v1/fixture-e2e/runs", json=payload).json()

    assert second["replayed"] is True
    assert second["run"]["runId"] == first["run"]["runId"]
    assert second["bookingAssistSession"]["sessionId"] == first["bookingAssistSession"]["sessionId"]
    assert [event["auditId"] for event in second["auditEvents"]] == [event["auditId"] for event in first["auditEvents"]]
    assert second["instrumentation"]["idempotency"]["status"] == "replayed"


def test_fixture_e2e_audit_read_endpoint_returns_persisted_trace() -> None:
    client = make_client()
    created = client.post("/v1/fixture-e2e/runs", json=fixture_e2e_payload()).json()

    response = client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/audit")

    assert response.status_code == 200
    body = response.json()
    assert body["runId"] == created["run"]["runId"]
    assert [event["action"] for event in body["auditEvents"]] == [
        "check_requested",
        "snapshot_recorded",
        "notification_queued",
        "booking_assist_opened",
    ]
    assert body["instrumentation"]["spans"][-1]["stage"] == "audit_persisted"
