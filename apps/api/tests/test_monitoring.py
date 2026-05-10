import hashlib

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.services.runtime_monitor import RuntimeMonitor

ADMIN_TOKEN = "monitoring-admin-token"
CLIENT_TOKEN = "monitoring-client-token"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def local_client() -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Monitoring Test",
                environment="test",
            )
        )
    )


def production_client() -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                admin_token_sha256=token_hash(ADMIN_TOKEN),
                allowed_origins=("https://api.slot-signal.test-domain.invalid-replaced.com",),
                app_name="Slot Signal API Production Monitoring Test",
                client_token_sha256=token_hash(CLIENT_TOKEN),
                environment="production",
                production_api_origin="https://api.slot-signal.test-domain.invalid-replaced.com",
            )
        )
    )


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_runtime_monitoring_records_bounded_redacted_runtime_summary() -> None:
    client = local_client()

    client.get("/v1/health")
    client.get("/v1/unknown-route")
    response = client.get("/v1/monitoring/runtime")

    assert response.status_code == 200
    body = response.json()
    assert body["schemaVersion"] == "runtime_monitoring.v1"
    assert body["counters"]["requestsTotal"] >= 2
    assert body["counters"]["clientErrors"] >= 1
    assert body["latency"]["buckets"]
    assert body["retention"] == {
        "eventPolicy": "anomalies_only",
        "maxRecentEvents": 200,
        "storesBodies": False,
        "storesHeaders": False,
        "storesIpAddresses": False,
        "storesQueryStrings": False,
    }
    assert body["featureVector"]["requestVolume"] >= 2
    assert any(event["signal"] == "client_error" for event in body["recentAnomalies"])
    assert "unknown-route" in str(body)
    assert "authorization" not in str(body).casefold()
    assert "user-agent" not in str(body).casefold()


def test_runtime_monitoring_is_admin_only_in_production_and_counts_auth_rejections() -> None:
    client = production_client()

    no_token = client.get("/v1/monitoring/runtime")
    client_token = client.get("/v1/monitoring/runtime", headers=auth(CLIENT_TOKEN))
    admin = client.get("/v1/monitoring/runtime", headers=auth(ADMIN_TOKEN))

    assert no_token.status_code == 401
    assert client_token.status_code == 403
    assert admin.status_code == 200
    body = admin.json()
    assert body["counters"]["authRejections"] >= 2
    assert any(event["signal"] == "auth_rejection" for event in body["recentAnomalies"])
    assert body["retention"]["storesIpAddresses"] is False


def test_runtime_monitoring_marks_scanner_404_pressure_as_watch_not_degraded() -> None:
    monitor = RuntimeMonitor()

    for index in range(25):
        monitor.record_request(
            duration_ms=1.0,
            method="GET",
            route=f"/scanner-path-{index}",
            status_code=404,
        )

    snapshot = monitor.snapshot()

    assert snapshot.redTeamSignals.highErrorRate is True
    assert snapshot.redTeamSignals.serverErrorSpike is False
    assert snapshot.status == "watch"


def test_runtime_monitoring_marks_server_error_spike_as_degraded() -> None:
    monitor = RuntimeMonitor()

    for index in range(3):
        monitor.record_request(
            duration_ms=1.0,
            method="GET",
            route=f"/server-error-{index}",
            status_code=500,
        )

    snapshot = monitor.snapshot()

    assert snapshot.redTeamSignals.serverErrorSpike is True
    assert snapshot.status == "degraded"
