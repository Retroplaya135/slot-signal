from __future__ import annotations

import sqlite3
from datetime import datetime
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol

from app.core.config import Settings
from app.schemas.fixture_e2e import FixtureE2ERunResponse

CURRENT_SCHEMA_VERSION = 2


class FixtureE2EStore(Protocol):
    def get_by_idempotency(self, key: str) -> FixtureE2ERunResponse | None:
        ...

    def get_by_run_id(self, run_id: str) -> FixtureE2ERunResponse | None:
        ...

    def save(self, response: FixtureE2ERunResponse) -> FixtureE2ERunResponse:
        ...

    def delete_run(self, run_id: str) -> bool:
        ...

    def delete_run_with_counts(self, run_id: str) -> dict[str, int | bool]:
        ...

    def export_run(self, run_id: str) -> FixtureE2ERunResponse | None:
        ...

    def prune_before(self, cutoff: datetime, dry_run: bool) -> dict[str, int]:
        ...

    def schema_version(self) -> int:
        ...


class FixtureE2EStoreUnavailableError(RuntimeError):
    pass


UNAVAILABLE_DETAIL = "durable audit store unavailable; check local database file and permissions."


class InMemoryFixtureE2EStore:
    def __init__(self) -> None:
        self._runs_by_idempotency: dict[str, FixtureE2ERunResponse] = {}
        self._runs_by_id: dict[str, FixtureE2ERunResponse] = {}

    def get_by_idempotency(self, key: str) -> FixtureE2ERunResponse | None:
        return self._runs_by_idempotency.get(key)

    def get_by_run_id(self, run_id: str) -> FixtureE2ERunResponse | None:
        return self._runs_by_id.get(run_id)

    def save(self, response: FixtureE2ERunResponse) -> FixtureE2ERunResponse:
        self._runs_by_idempotency[response.run.idempotencyKey] = response
        self._runs_by_id[response.run.runId] = response
        return response

    def delete_run(self, run_id: str) -> bool:
        response = self._runs_by_id.pop(run_id, None)
        if not response:
            return False
        self._runs_by_idempotency.pop(response.run.idempotencyKey, None)
        return True

    def delete_run_with_counts(self, run_id: str) -> dict[str, int | bool]:
        existing = self._runs_by_id.get(run_id)
        if not existing:
            return {"deleted": False, "deletedAuditEvents": 0, "deletedRuns": 0}
        deleted = self.delete_run(run_id)
        return {
            "deleted": deleted,
            "deletedAuditEvents": len(existing.auditEvents) if deleted else 0,
            "deletedRuns": 1 if deleted else 0,
        }

    def export_run(self, run_id: str) -> FixtureE2ERunResponse | None:
        return self.get_by_run_id(run_id)

    def prune_before(self, cutoff: datetime, dry_run: bool) -> dict[str, int]:
        matched = [
            response
            for response in self._runs_by_id.values()
            if response.run.createdAt < cutoff
        ]
        audit_count = sum(len(response.auditEvents) for response in matched)
        if not dry_run:
            for response in matched:
                self.delete_run(response.run.runId)
        return {
            "deletedAuditEvents": audit_count if not dry_run else 0,
            "deletedRuns": len(matched) if not dry_run else 0,
            "matchedRuns": len(matched),
        }

    def schema_version(self) -> int:
        return 0


class UnavailableFixtureE2EStore:
    def __init__(self) -> None:
        self._detail = UNAVAILABLE_DETAIL

    def get_by_idempotency(self, key: str) -> FixtureE2ERunResponse | None:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def get_by_run_id(self, run_id: str) -> FixtureE2ERunResponse | None:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def save(self, response: FixtureE2ERunResponse) -> FixtureE2ERunResponse:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def delete_run(self, run_id: str) -> bool:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def delete_run_with_counts(self, run_id: str) -> dict[str, int | bool]:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def export_run(self, run_id: str) -> FixtureE2ERunResponse | None:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def prune_before(self, cutoff: datetime, dry_run: bool) -> dict[str, int]:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def schema_version(self) -> int:
        raise FixtureE2EStoreUnavailableError(self._detail)

    def health_check(self) -> dict[str, str]:
        return {"status": "degraded", "detail": self._detail}


class DurableFixtureE2EStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path if db_path == ":memory:" else str(Path(db_path).expanduser())
        self._ensure_schema()

    @property
    def db_path(self) -> str:
        return self._db_path

    def get_by_idempotency(self, key: str) -> FixtureE2ERunResponse | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "select response_json from fixture_e2e_runs where idempotency_key = ?",
                    (key,),
                ).fetchone()
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return _response_from_row(row)

    def get_by_run_id(self, run_id: str) -> FixtureE2ERunResponse | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "select response_json from fixture_e2e_runs where run_id = ?",
                    (run_id,),
                ).fetchone()
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return _response_from_row(row)

    def save(self, response: FixtureE2ERunResponse) -> FixtureE2ERunResponse:
        existing = self.get_by_idempotency(response.run.idempotencyKey)
        if existing:
            return existing

        response_json = response.model_dump_json()
        with self._connect() as connection:
            try:
                connection.execute(
                    """
                    insert into fixture_e2e_runs (
                        run_id,
                        idempotency_key,
                        request_id,
                        trace_id,
                        scenario,
                        created_at,
                        updated_at,
                        response_json
                    )
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        response.run.runId,
                        response.run.idempotencyKey,
                        None,
                        response.run.traceId,
                        response.run.scenario,
                        response.run.createdAt.isoformat(),
                        response.run.createdAt.isoformat(),
                        response_json,
                    ),
                )
                connection.executemany(
                    """
                    insert into fixture_e2e_audit_events (
                        audit_id,
                        run_id,
                        sequence,
                        action,
                        trace_id,
                        idempotency_key,
                        occurred_at,
                        event_json
                    )
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            event.auditId,
                            response.run.runId,
                            index,
                            event.action,
                            event.traceId,
                            event.idempotencyKey,
                            event.occurredAt.isoformat(),
                            event.model_dump_json(),
                        )
                        for index, event in enumerate(response.auditEvents, start=1)
                    ],
                )
            except sqlite3.IntegrityError:
                connection.rollback()
                replay = self.get_by_idempotency(response.run.idempotencyKey)
                if replay:
                    return replay
                raise
            except sqlite3.DatabaseError as error:
                raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return response

    def delete_run(self, run_id: str) -> bool:
        try:
            with self._connect() as connection:
                cursor = connection.execute("delete from fixture_e2e_runs where run_id = ?", (run_id,))
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return cursor.rowcount > 0

    def delete_run_with_counts(self, run_id: str) -> dict[str, int | bool]:
        try:
            with self._connect() as connection:
                run_count = connection.execute(
                    "select count(*) from fixture_e2e_runs where run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                audit_count = connection.execute(
                    "select count(*) from fixture_e2e_audit_events where run_id = ?",
                    (run_id,),
                ).fetchone()[0]
                if run_count:
                    connection.execute("delete from fixture_e2e_runs where run_id = ?", (run_id,))
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return {
            "deleted": bool(run_count),
            "deletedAuditEvents": audit_count if run_count else 0,
            "deletedRuns": 1 if run_count else 0,
        }

    def export_run(self, run_id: str) -> FixtureE2ERunResponse | None:
        return self.get_by_run_id(run_id)

    def prune_before(self, cutoff: datetime, dry_run: bool) -> dict[str, int]:
        cutoff_value = cutoff.isoformat()
        try:
            with self._connect() as connection:
                run_ids = [
                    row["run_id"]
                    for row in connection.execute(
                        "select run_id from fixture_e2e_runs where created_at < ? order by created_at asc",
                        (cutoff_value,),
                    ).fetchall()
                ]
                audit_count = _count_audit_events(connection, run_ids)
                if run_ids and not dry_run:
                    connection.executemany("delete from fixture_e2e_runs where run_id = ?", [(run_id,) for run_id in run_ids])
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return {
            "deletedAuditEvents": audit_count if not dry_run else 0,
            "deletedRuns": len(run_ids) if not dry_run else 0,
            "matchedRuns": len(run_ids),
        }

    def schema_version(self) -> int:
        try:
            with self._connect() as connection:
                row = connection.execute("select max(version) as version from schema_migrations").fetchone()
        except sqlite3.DatabaseError as error:
            raise FixtureE2EStoreUnavailableError(UNAVAILABLE_DETAIL) from error
        return int(row["version"] or 0)

    def health_check(self) -> dict[str, str]:
        try:
            with self._connect() as connection:
                run_count = connection.execute("select count(*) from fixture_e2e_runs").fetchone()[0]
                schema_version = connection.execute("select max(version) as version from schema_migrations").fetchone()["version"]
        except sqlite3.DatabaseError:
            return {"status": "degraded", "detail": UNAVAILABLE_DETAIL}
        return {
            "status": "ok",
            "detail": f"durable SQLite audit store configured; schema={schema_version}; fixture runs={run_count}",
        }

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("pragma foreign_keys = on")
        connection.execute("pragma busy_timeout = 5000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _ensure_schema(self) -> None:
        if self._db_path != ":memory:":
            Path(self._db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                create table if not exists schema_migrations (
                    version integer primary key,
                    name text not null,
                    applied_at text not null
                )
                """
            )
            connection.execute(
                """
                create table if not exists fixture_e2e_runs (
                    run_id text primary key,
                    idempotency_key text not null unique,
                    request_id text,
                    trace_id text not null,
                    scenario text not null,
                    created_at text not null,
                    updated_at text not null,
                    response_json text not null
                )
                """
            )
            connection.execute(
                """
                create table if not exists fixture_e2e_audit_events (
                    event_row_id integer primary key autoincrement,
                    audit_id text not null,
                    run_id text not null references fixture_e2e_runs(run_id) on delete cascade,
                    sequence integer not null,
                    action text not null,
                    trace_id text not null,
                    idempotency_key text not null,
                    occurred_at text not null,
                    event_json text not null,
                    unique(run_id, sequence),
                    unique(run_id, audit_id)
                )
                """
            )
            if _audit_events_need_v2_migration(connection):
                _migrate_audit_events_to_v2(connection)
            connection.execute(
                "create index if not exists fixture_e2e_runs_trace_id_idx on fixture_e2e_runs(trace_id)"
            )
            connection.execute(
                "create index if not exists fixture_e2e_audit_events_run_id_idx on fixture_e2e_audit_events(run_id)"
            )
            _record_schema_migration(connection, 1, "audit_store_fixture_audit_store")
            _record_schema_migration(connection, 2, "retention_controls_retention_delete_controls")


def create_fixture_e2e_store(settings: Settings) -> FixtureE2EStore:
    if settings.audit_db_path:
        try:
            return DurableFixtureE2EStore(settings.audit_db_path)
        except (OSError, sqlite3.DatabaseError):
            return UnavailableFixtureE2EStore()
    return InMemoryFixtureE2EStore()


def _response_from_row(row: sqlite3.Row | None) -> FixtureE2ERunResponse | None:
    if row is None:
        return None
    return FixtureE2ERunResponse.model_validate_json(row["response_json"])


def _audit_events_need_v2_migration(connection: sqlite3.Connection) -> bool:
    columns = connection.execute("pragma table_info(fixture_e2e_audit_events)").fetchall()
    return any(column["name"] == "audit_id" and column["pk"] == 1 for column in columns)


def _migrate_audit_events_to_v2(connection: sqlite3.Connection) -> None:
    connection.execute("alter table fixture_e2e_audit_events rename to fixture_e2e_audit_events_v1")
    connection.execute(
        """
        create table fixture_e2e_audit_events (
            event_row_id integer primary key autoincrement,
            audit_id text not null,
            run_id text not null references fixture_e2e_runs(run_id) on delete cascade,
            sequence integer not null,
            action text not null,
            trace_id text not null,
            idempotency_key text not null,
            occurred_at text not null,
            event_json text not null,
            unique(run_id, sequence),
            unique(run_id, audit_id)
        )
        """
    )
    connection.execute(
        """
        insert into fixture_e2e_audit_events (
            audit_id,
            run_id,
            sequence,
            action,
            trace_id,
            idempotency_key,
            occurred_at,
            event_json
        )
        select
            audit_id,
            run_id,
            sequence,
            action,
            trace_id,
            idempotency_key,
            occurred_at,
            event_json
        from fixture_e2e_audit_events_v1
        """
    )
    connection.execute("drop table fixture_e2e_audit_events_v1")


def _record_schema_migration(connection: sqlite3.Connection, version: int, name: str) -> None:
    connection.execute(
        """
        insert or ignore into schema_migrations (version, name, applied_at)
        values (?, ?, ?)
        """,
        (version, name, datetime.now().isoformat()),
    )


def _count_audit_events(connection: sqlite3.Connection, run_ids: list[str]) -> int:
    if not run_ids:
        return 0
    placeholders = ", ".join("?" for _ in run_ids)
    return int(
        connection.execute(
            f"select count(*) from fixture_e2e_audit_events where run_id in ({placeholders})",
            run_ids,
        ).fetchone()[0]
    )
