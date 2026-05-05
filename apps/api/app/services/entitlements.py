from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.core.config import Settings
from app.schemas.entitlements import (
    AccessCodeAuditEvent,
    AccessCodeEntitlementRecord,
    AccessCodeIssueRequest,
    AccessCodeTier,
    AccessCodeUpdateRequest,
    AccessCodeUpdateResponse,
    AccessCodeVerifyReason,
    AccessCodeVerifyRequest,
    AccessCodeVerifyResponse,
)

ENTITLEMENT_SCHEMA_VERSION = 1


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _new_id(prefix: str) -> str:
    return f"{prefix}:{uuid4().hex[:20]}"


def access_code_hash(access_code: str) -> str:
    return hashlib.sha256(access_code.strip().encode("utf-8")).hexdigest()


def _tier_allows(actual: AccessCodeTier, required: AccessCodeTier) -> bool:
    order = {"beta": 1, "advanced": 2}
    return order[actual] >= order[required]


class InMemoryEntitlementStore:
    def __init__(self) -> None:
        self._entitlements: dict[str, AccessCodeEntitlementRecord] = {}
        self._entitlement_by_hash: dict[str, str] = {}
        self._audit: list[AccessCodeAuditEvent] = []

    def issue_access_code(self, payload: AccessCodeIssueRequest, now: datetime | None = None) -> AccessCodeEntitlementRecord:
        issued_at = _utc(now or _now())
        expires_at = _utc(payload.expiresAt) if payload.expiresAt else None
        code_hash = access_code_hash(payload.accessCode)
        existing_id = self._entitlement_by_hash.get(code_hash)
        entitlement_id = existing_id or _new_id("entitlement")
        status = "expired" if expires_at and expires_at <= issued_at else "active"
        record = AccessCodeEntitlementRecord.model_validate(
            {
                "accessCodeHash": code_hash,
                "entitlementId": entitlement_id,
                "expiresAt": expires_at,
                "failedAttemptCount": 0,
                "issuedAt": issued_at,
                "lastVerifiedAt": None,
                "notes": payload.notes,
                "rawCodeStored": False,
                "status": status,
                "tier": payload.tier,
            }
        )
        self._entitlements[entitlement_id] = record
        self._entitlement_by_hash[code_hash] = entitlement_id
        self._record_audit(
            action="issued",
            entitlement_id=entitlement_id,
            reason="valid" if status == "active" else "expired",
            tier=record.tier,
            now=issued_at,
        )
        if status == "expired":
            self._record_audit(
                action="expired",
                entitlement_id=entitlement_id,
                reason="expired",
                tier=record.tier,
                now=issued_at,
            )
        return record

    def list_entitlements(self) -> list[AccessCodeEntitlementRecord]:
        return sorted(self._entitlements.values(), key=lambda record: record.issuedAt)

    def update_access_code(
        self,
        entitlement_id: str,
        payload: AccessCodeUpdateRequest,
        now: datetime | None = None,
    ) -> AccessCodeUpdateResponse | None:
        existing = self._entitlements.get(entitlement_id)
        if existing is None:
            return None
        recorded_at = _utc(now or _now())
        status = payload.status or existing.status
        expires_at = _utc(payload.expiresAt) if payload.expiresAt else existing.expiresAt
        if expires_at and expires_at <= recorded_at:
            status = "expired"
        record = existing.model_copy(
            update={
                "expiresAt": expires_at,
                "status": status,
                "tier": payload.tier or existing.tier,
            }
        )
        self._entitlements[entitlement_id] = record
        action = "revoked" if status == "revoked" else "expired" if status == "expired" else "issued"
        reason = "revoked" if status == "revoked" else "expired" if status == "expired" else "valid"
        audit = self._record_audit(
            action=action,
            entitlement_id=entitlement_id,
            reason=payload.auditReason or reason,
            tier=record.tier,
            now=recorded_at,
        )
        return AccessCodeUpdateResponse.model_validate({"auditEvent": audit, "entitlement": record})

    def verify_access_code(
        self,
        payload: AccessCodeVerifyRequest,
        now: datetime | None = None,
    ) -> AccessCodeVerifyResponse:
        checked_at = _utc(now or _now())
        code = payload.accessCode.strip()
        if len(code) < 6:
            audit = self._record_audit(
                action="verify_failed",
                entitlement_id=None,
                reason="malformed",
                tier=None,
                now=checked_at,
            )
            return AccessCodeVerifyResponse.model_validate(
                {"auditEvent": audit, "entitlement": None, "reason": "malformed", "valid": False}
            )
        entitlement_id = self._entitlement_by_hash.get(access_code_hash(code))
        if entitlement_id is None:
            audit = self._record_audit(
                action="verify_failed",
                entitlement_id=None,
                reason="not_found",
                tier=None,
                now=checked_at,
            )
            return AccessCodeVerifyResponse.model_validate(
                {"auditEvent": audit, "entitlement": None, "reason": "not_found", "valid": False}
            )
        record = self._entitlements[entitlement_id]
        reason = self._invalid_reason(record, payload.requiredTier, checked_at)
        if reason:
            updated = record.model_copy(update={"failedAttemptCount": record.failedAttemptCount + 1})
            if reason == "expired" and record.status != "expired":
                updated = updated.model_copy(update={"status": "expired"})
            self._entitlements[entitlement_id] = updated
            audit = self._record_audit(
                action="verify_failed",
                entitlement_id=entitlement_id,
                reason=reason,
                tier=updated.tier,
                now=checked_at,
            )
            return AccessCodeVerifyResponse.model_validate(
                {"auditEvent": audit, "entitlement": updated, "reason": reason, "valid": False}
            )
        updated = record.model_copy(update={"lastVerifiedAt": checked_at})
        self._entitlements[entitlement_id] = updated
        audit = self._record_audit(
            action="verify_success",
            entitlement_id=entitlement_id,
            reason="valid",
            tier=updated.tier,
            now=checked_at,
        )
        return AccessCodeVerifyResponse.model_validate(
            {"auditEvent": audit, "entitlement": updated, "reason": "valid", "valid": True}
        )

    def audit_events(self, entitlement_id: str | None = None) -> list[AccessCodeAuditEvent]:
        events = self._audit
        if entitlement_id is not None:
            events = [event for event in events if event.entitlementId == entitlement_id]
        return sorted(events, key=lambda event: event.recordedAt)

    def health_check(self) -> dict[str, str]:
        return {"detail": f"entitlement store configured; records={len(self._entitlements)}", "status": "ok"}

    def _invalid_reason(
        self,
        record: AccessCodeEntitlementRecord,
        required_tier: AccessCodeTier,
        checked_at: datetime,
    ) -> AccessCodeVerifyReason | None:
        if record.status == "revoked":
            return "revoked"
        if record.status == "expired" or (record.expiresAt and record.expiresAt <= checked_at):
            return "expired"
        if not _tier_allows(record.tier, required_tier):
            return "tier_insufficient"
        return None

    def _record_audit(
        self,
        *,
        action: str,
        entitlement_id: str | None,
        reason: str,
        tier: AccessCodeTier | None,
        now: datetime,
    ) -> AccessCodeAuditEvent:
        event = AccessCodeAuditEvent.model_validate(
            {
                "action": action,
                "auditEventId": _new_id("entitlement-audit"),
                "entitlementId": entitlement_id,
                "reason": reason,
                "recordedAt": now,
                "tier": tier,
            }
        )
        self._audit.append(event)
        return event


class DurableEntitlementStore(InMemoryEntitlementStore):
    def __init__(self, db_path: str) -> None:
        super().__init__()
        self._db_path = db_path if db_path == ":memory:" else str(Path(db_path).expanduser())
        self._ensure_schema()
        self._load_state()

    def issue_access_code(self, payload: AccessCodeIssueRequest, now: datetime | None = None) -> AccessCodeEntitlementRecord:
        audit_start = len(self._audit)
        record = super().issue_access_code(payload, now)
        self._persist_entitlement(record)
        for event in self._audit[audit_start:]:
            self._persist_audit(event)
        return record

    def update_access_code(
        self,
        entitlement_id: str,
        payload: AccessCodeUpdateRequest,
        now: datetime | None = None,
    ) -> AccessCodeUpdateResponse | None:
        audit_start = len(self._audit)
        response = super().update_access_code(entitlement_id, payload, now)
        if response is None:
            return None
        self._persist_entitlement(response.entitlement)
        for event in self._audit[audit_start:]:
            self._persist_audit(event)
        return response

    def verify_access_code(
        self,
        payload: AccessCodeVerifyRequest,
        now: datetime | None = None,
    ) -> AccessCodeVerifyResponse:
        audit_start = len(self._audit)
        response = super().verify_access_code(payload, now)
        if response.entitlement is not None:
            self._persist_entitlement(response.entitlement)
        for event in self._audit[audit_start:]:
            self._persist_audit(event)
        return response

    def health_check(self) -> dict[str, str]:
        with self._connect() as connection:
            count = connection.execute("select count(*) from access_code_entitlements").fetchone()[0]
        return {"detail": f"durable entitlement store configured; schema={ENTITLEMENT_SCHEMA_VERSION}; records={count}", "status": "ok"}

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
                create table if not exists access_code_schema_migrations (
                    version integer primary key,
                    name text not null,
                    applied_at text not null
                )
                """
            )
            connection.execute(
                """
                create table if not exists access_code_entitlements (
                    entitlement_id text primary key,
                    access_code_hash text not null unique,
                    status text not null,
                    tier text not null,
                    issued_at text not null,
                    entitlement_json text not null
                )
                """
            )
            connection.execute(
                """
                create table if not exists access_code_entitlement_audit (
                    audit_event_id text primary key,
                    entitlement_id text,
                    action text not null,
                    recorded_at text not null,
                    audit_json text not null
                )
                """
            )
            connection.execute(
                "create index if not exists access_code_entitlements_hash_idx on access_code_entitlements(access_code_hash)"
            )
            connection.execute(
                "create index if not exists access_code_entitlement_audit_lookup_idx on access_code_entitlement_audit(entitlement_id, recorded_at)"
            )
            connection.execute(
                """
                insert or ignore into access_code_schema_migrations (version, name, applied_at)
                values (?, ?, ?)
                """,
                (ENTITLEMENT_SCHEMA_VERSION, "access_code_entitlements", _now().isoformat()),
            )

    def _load_state(self) -> None:
        with self._connect() as connection:
            records = [
                AccessCodeEntitlementRecord.model_validate_json(row["entitlement_json"])
                for row in connection.execute("select entitlement_json from access_code_entitlements order by issued_at asc")
            ]
            self._entitlements = {record.entitlementId: record for record in records}
            self._entitlement_by_hash = {record.accessCodeHash: record.entitlementId for record in records}
            self._audit = [
                AccessCodeAuditEvent.model_validate_json(row["audit_json"])
                for row in connection.execute("select audit_json from access_code_entitlement_audit order by recorded_at asc")
            ]

    def _persist_entitlement(self, record: AccessCodeEntitlementRecord) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                insert or replace into access_code_entitlements (
                    entitlement_id,
                    access_code_hash,
                    status,
                    tier,
                    issued_at,
                    entitlement_json
                )
                values (?, ?, ?, ?, ?, ?)
                """,
                (
                    record.entitlementId,
                    record.accessCodeHash,
                    record.status,
                    record.tier,
                    record.issuedAt.isoformat(),
                    record.model_dump_json(),
                ),
            )

    def _persist_audit(self, event: AccessCodeAuditEvent) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                insert or ignore into access_code_entitlement_audit (
                    audit_event_id,
                    entitlement_id,
                    action,
                    recorded_at,
                    audit_json
                )
                values (?, ?, ?, ?, ?)
                """,
                (
                    event.auditEventId,
                    event.entitlementId,
                    event.action,
                    event.recordedAt.isoformat(),
                    event.model_dump_json(),
                ),
            )


def create_entitlement_store(settings: Settings | None = None) -> InMemoryEntitlementStore:
    db_path = (settings.entitlement_db_path or settings.audit_db_path) if settings else None
    if db_path:
        try:
            return DurableEntitlementStore(db_path)
        except (OSError, sqlite3.DatabaseError) as error:
            if settings and settings.environment in {"staging", "production"}:
                raise RuntimeError(
                    "Durable entitlement store is unavailable; refusing in-memory fallback in staging/production."
                ) from error
            return InMemoryEntitlementStore()
    return InMemoryEntitlementStore()
