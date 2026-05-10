from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings
from app.schemas.fixture_e2e import FixtureE2ERunRequest
from app.main import create_app
from app.services.fixture_e2e import execute_fixture_e2e_run
from app.storage.fixture_e2e_store import DurableFixtureE2EStore


def make_client(db_path: Path) -> TestClient:
    return TestClient(
        create_app(
            settings_factory=lambda: Settings(
                app_name="Slot Signal API Persistence Destruction Test",
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


def test_corrupt_durable_db_degrades_health_and_blocks_fixture_writes(tmp_path: Path) -> None:
    db_path = tmp_path / "corrupt.sqlite3"
    db_path.write_text("this is not a sqlite database", encoding="utf-8")

    client = make_client(db_path)
    health = client.get("/v1/health")
    created = client.post("/v1/fixture-e2e/runs", json=audit_store_payload())

    assert health.status_code == 200
    assert health.json()["checks"]["database"]["status"] == "degraded"
    assert "unavailable" in health.json()["checks"]["database"]["detail"]
    assert str(db_path) not in health.json()["checks"]["database"]["detail"]
    assert created.status_code == 503
    assert created.json()["detail"] == "Durable fixture audit store is unavailable."


def test_partial_audit_event_failure_rolls_back_run_row(tmp_path: Path) -> None:
    db_path = tmp_path / "atomicity.sqlite3"
    store = DurableFixtureE2EStore(str(db_path))
    response = execute_fixture_e2e_run(FixtureE2ERunRequest.model_validate(audit_store_payload()), store)
    duplicate_audit_response = response.model_copy(
        update={
            "auditEvents": [response.auditEvents[1], response.auditEvents[1]],
            "run": response.run.model_copy(update={"runId": "run:audit_store:atomicity:duplicate"}),
        }
    )

    try:
        store.save(duplicate_audit_response)
    except sqlite3.IntegrityError:
        pass

    with sqlite3.connect(db_path) as connection:
        run_ids = [
            row[0]
            for row in connection.execute(
                "select run_id from fixture_e2e_runs order by run_id asc"
            ).fetchall()
        ]

    assert run_ids == [response.run.runId]


def test_schema_damage_after_start_degrades_health_and_blocks_reads(tmp_path: Path) -> None:
    db_path = tmp_path / "schema_damage.sqlite3"
    client = make_client(db_path)
    created = client.post("/v1/fixture-e2e/runs", json=audit_store_payload()).json()
    with sqlite3.connect(db_path) as connection:
        connection.execute("drop table fixture_e2e_runs")

    health = client.get("/v1/health")
    audit = client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/audit")

    assert health.status_code == 200
    assert health.json()["checks"]["database"]["status"] == "degraded"
    assert audit.status_code == 503


def test_concurrent_same_idempotency_key_creates_one_durable_run(tmp_path: Path) -> None:
    db_path = tmp_path / "concurrent_idempotency.sqlite3"

    def post_once() -> dict:
        response = make_client(db_path).post("/v1/fixture-e2e/runs", json=audit_store_payload())
        assert response.status_code == 200
        return response.json()

    with ThreadPoolExecutor(max_workers=4) as executor:
        responses = list(executor.map(lambda _: post_once(), range(4)))

    assert {response["run"]["runId"] for response in responses} == {"run:fixture_e2e:idem:audit_store:durable:audit:001"}
    assert sum(1 for response in responses if response["replayed"] is False) == 1
    with sqlite3.connect(db_path) as connection:
        run_count = connection.execute("select count(*) from fixture_e2e_runs").fetchone()[0]
        audit_count = connection.execute("select count(*) from fixture_e2e_audit_events").fetchone()[0]
    assert run_count == 1
    assert audit_count == len(responses[0]["auditEvents"])


def test_retention_delete_removes_run_and_cascades_audit_events(tmp_path: Path) -> None:
    db_path = tmp_path / "retention.sqlite3"
    client = make_client(db_path)
    created = client.post("/v1/fixture-e2e/runs", json=audit_store_payload()).json()
    store = DurableFixtureE2EStore(str(db_path))

    deleted = store.delete_run(created["run"]["runId"])

    assert deleted is True
    assert client.get(f"/v1/fixture-e2e/runs/{created['run']['runId']}/audit").status_code == 404
    with sqlite3.connect(db_path) as connection:
        run_count = connection.execute("select count(*) from fixture_e2e_runs").fetchone()[0]
        audit_count = connection.execute("select count(*) from fixture_e2e_audit_events").fetchone()[0]
    assert run_count == 0
    assert audit_count == 0
