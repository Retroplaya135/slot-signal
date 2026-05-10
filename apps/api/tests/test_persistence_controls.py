from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def make_client(db_path: Path, *, environment: str = "test", retention_days: int = 30) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Persistence Test",
                audit_db_path=str(db_path),
                audit_retention_days=retention_days,
                environment=environment,  # type: ignore[arg-type]
            )
        )
    )


def payload(suffix: str, now: str) -> dict:
    return {
        "idempotencyKey": f"idem:retention_controls:persistence:{suffix}",
        "now": now,
        "requestedConsulateIds": ["consulate:mumbai"],
        "requestId": f"request:retention_controls:persistence:{suffix}",
        "scenario": "slots_found",
        "traceId": f"trace:retention_controls:persistence:{suffix}",
    }


def test_schema_version_table_records_retention_controls_migration(tmp_path: Path) -> None:
    db_path = tmp_path / "schema_version.sqlite3"
    client = make_client(db_path)

    health = client.get("/v1/health")

    assert health.status_code == 200
    assert "schema=2" in health.json()["checks"]["database"]["detail"]
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "select version, name from schema_migrations order by version asc"
        ).fetchall()
    assert rows == [(1, "audit_store_fixture_audit_store"), (2, "retention_controls_retention_delete_controls")]


def test_redacted_export_endpoint_returns_safe_audit_package(tmp_path: Path) -> None:
    db_path = tmp_path / "export.sqlite3"
    client = make_client(db_path)
    created = client.post("/v1/fixture-e2e/runs", json=payload("export", "2026-05-07T22:00:00Z")).json()

    exported = client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/export")

    assert exported.status_code == 200
    body = exported.json()
    assert body["runId"] == created["run"]["runId"]
    assert body["schemaVersion"] == 2
    assert body["containsSensitiveRawData"] is False
    assert body["livePortalRequestMade"] is False
    assert body["appointmentChangingActionTaken"] is False
    assert [event["auditId"] for event in body["auditEvents"]] == [
        event["auditId"] for event in created["auditEvents"]
    ]
    serialized = json.dumps(body).lower()
    assert "response_json" not in serialized
    assert "password=" not in serialized
    assert "access_token" not in serialized
    assert "bearer " not in serialized


def test_delete_endpoint_removes_run_and_cascades_audit_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "delete.sqlite3"
    client = make_client(db_path)
    created = client.post("/v1/fixture-e2e/runs", json=payload("delete", "2026-05-07T22:00:00Z")).json()

    deleted = client.delete(f"/v1/fixture-e2e/runs/{created['run']['runId']}")

    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True
    assert deleted.json()["deletedRuns"] == 1
    assert deleted.json()["deletedAuditEvents"] == len(created["auditEvents"])
    assert client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/audit").status_code == 404


def test_retention_prune_dry_run_and_delete_old_runs_only(tmp_path: Path) -> None:
    db_path = tmp_path / "retention_prune.sqlite3"
    client = make_client(db_path)
    old_run = client.post("/v1/fixture-e2e/runs", json=payload("old", "2026-01-01T00:00:00Z")).json()
    fresh_run = client.post("/v1/fixture-e2e/runs", json=payload("fresh", "2026-05-07T22:00:00Z")).json()

    dry_run = client.post(
        "/v1/fixture-e2e/audit/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": True},
    )
    prune = client.post(
        "/v1/fixture-e2e/audit/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": False},
    )

    assert dry_run.status_code == 200
    assert dry_run.json()["matchedRuns"] == 1
    assert dry_run.json()["deletedRuns"] == 0
    assert prune.status_code == 200
    assert prune.json()["deletedRuns"] == 1
    assert prune.json()["deletedAuditEvents"] == len(old_run["auditEvents"])
    assert client.get(f"/v1/fixture-e2e/runs/{old_run['run']['runId']}/audit").status_code == 404
    assert client.get(f"/v1/fixture-e2e/runs/{fresh_run['run']['runId']}/audit").status_code == 200


def test_persistence_admin_controls_require_production_admin_auth(tmp_path: Path) -> None:
    db_path = tmp_path / "production_gate.sqlite3"
    setup_client = make_client(db_path, environment="test")
    created = setup_client.post("/v1/fixture-e2e/runs", json=payload("prod-gate", "2026-05-07T22:00:00Z")).json()
    production_client = make_client(db_path, environment="production")

    export = production_client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/export")
    delete = production_client.delete(f"/v1/fixture-e2e/runs/{created['run']['runId']}")
    prune = production_client.post(
        "/v1/fixture-e2e/audit/retention/prune",
        json={"cutoffBefore": "2026-03-01T00:00:00Z", "dryRun": False},
    )

    assert export.status_code == 401
    assert delete.status_code == 401
    assert prune.status_code == 401
