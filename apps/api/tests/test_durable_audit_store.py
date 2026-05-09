from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def make_durable_client(db_path: Path) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Durable Test",
                environment="test",
                audit_db_path=str(db_path),
            )
        )
    )


def audit_store_payload() -> dict:
    return {
        "idempotencyKey": "idem:audit_store:durable:audit:001",
        "now": "2026-05-07T22:00:00Z",
        "requestedConsulateIds": ["consulate:mumbai"],
        "requestId": "request:audit_store:durable:audit:001",
        "scenario": "slots_found",
        "traceId": "trace:audit_store:durable:audit:001",
    }


def test_fixture_audit_persists_across_fresh_app_instance(tmp_path: Path) -> None:
    db_path = tmp_path / "audit_store_audit.sqlite3"
    first_client = make_durable_client(db_path)

    created_response = first_client.post("/v1/fixture-e2e/runs", json=audit_store_payload())

    assert created_response.status_code == 200
    created = created_response.json()
    assert db_path.exists()

    fresh_client = make_durable_client(db_path)
    audit_response = fresh_client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/audit")

    assert audit_response.status_code == 200
    audit = audit_response.json()
    assert audit["runId"] == created["run"]["runId"]
    assert [event["auditId"] for event in audit["auditEvents"]] == [
        event["auditId"] for event in created["auditEvents"]
    ]
    assert audit["instrumentation"]["idempotency"]["status"] == "created"


def test_fixture_idempotency_survives_app_restart_without_duplicate_audit_events(tmp_path: Path) -> None:
    db_path = tmp_path / "audit_store_idempotency.sqlite3"
    payload = audit_store_payload()

    created = make_durable_client(db_path).post("/v1/fixture-e2e/runs", json=payload).json()
    replayed = make_durable_client(db_path).post("/v1/fixture-e2e/runs", json=payload).json()

    assert replayed["replayed"] is True
    assert replayed["run"]["runId"] == created["run"]["runId"]
    assert replayed["instrumentation"]["idempotency"]["status"] == "replayed"

    with sqlite3.connect(db_path) as connection:
        run_count = connection.execute("select count(*) from fixture_e2e_runs").fetchone()[0]
        audit_count = connection.execute("select count(*) from fixture_e2e_audit_events").fetchone()[0]

    assert run_count == 1
    assert audit_count == len(created["auditEvents"])


def test_durable_audit_db_stores_safe_json_without_sensitive_raw_values(tmp_path: Path) -> None:
    db_path = tmp_path / "audit_store_safe.sqlite3"
    created = make_durable_client(db_path).post("/v1/fixture-e2e/runs", json=audit_store_payload()).json()

    with sqlite3.connect(db_path) as connection:
        stored_response = connection.execute("select response_json from fixture_e2e_runs").fetchone()[0]
        stored_events = [
            row[0]
            for row in connection.execute(
                "select event_json from fixture_e2e_audit_events order by sequence asc"
            ).fetchall()
        ]

    combined = json.dumps([json.loads(stored_response), *[json.loads(event) for event in stored_events]])
    assert "password=" not in combined.lower()
    assert "portal_password" not in combined.lower()
    assert "access_token" not in combined.lower()
    assert "bearer " not in combined.lower()
    assert "cookie:" not in combined.lower()
    assert all(event["containsSensitiveRawData"] is False for event in created["auditEvents"])
