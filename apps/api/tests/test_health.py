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


def test_health_returns_health_contract_safe_status() -> None:
    client = make_client()

    response = client.get("/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "Slot Signal API Test"
    assert body["environment"] == "test"
    assert body["live_portal_enabled"] is False
    assert body["checks"]["database"]["status"] == "not_configured"
    assert body["checks"]["queue"]["status"] == "not_configured"
    assert body["checks"]["portal_adapter"]["status"] == "disabled"
    assert body["checks"]["notifications"]["status"] == "disabled"


def test_openapi_exposes_safe_fixture_and_slot_signal_routes() -> None:
    schema = create_app().openapi()

    assert "/v1/alert-subscriptions" in schema["paths"]
    assert "/v1/alert-subscriptions/{subscription_id}/matches" in schema["paths"]
    assert "/v1/alert-notifications/pending" in schema["paths"]
    assert "/v1/health" in schema["paths"]
    assert "/v1/fixture-e2e/runs" in schema["paths"]
    assert "/v1/fixture-e2e/runs/{run_id}/audit" in schema["paths"]
    assert "/v1/slot-reports" in schema["paths"]
    assert "/v1/slot-reports/latest" in schema["paths"]
    assert "health-read_health" in {
        operation["operationId"]
        for path in schema["paths"].values()
        for operation in path.values()
    }
    assert all("portal" not in path for path in schema["paths"])
