from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.adapters.source import FixtureVisaAvailabilityAdapter
from app.notifications.adapters import create_fixture_notification_dispatch, create_notification_preferences
from app.schemas.domain import (
    MIN_SAFE_CHECK_INTERVAL_MINUTES,
    AuditEvent,
    AvailabilityCheckRequest,
    BookingAssistSession,
    CheckPolicy,
)
from app.schemas.fixture_e2e import (
    FixtureE2EAuditReadResponse,
    FixtureE2EIdempotencyState,
    FixtureE2EInstrumentation,
    FixtureE2EInstrumentationSpan,
    FixtureE2ERun,
    FixtureE2ERunRequest,
    FixtureE2ERunResponse,
    NotificationDispatchBundle,
)
from app.storage.fixture_e2e_store import FixtureE2EStore


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _add_minutes(value: datetime, minutes: int) -> datetime:
    return value + timedelta(minutes=minutes)


def _safe_suffix(value: str) -> str:
    return "".join(character if character.isalnum() or character in "._:-" else ":" for character in value)[:64]


def _availability_request(payload: FixtureE2ERunRequest, now: datetime) -> AvailabilityCheckRequest:
    return AvailabilityCheckRequest.model_validate(
        {
            "createdAt": now,
            "idempotencyKey": payload.idempotencyKey,
            "livePortalChecksEnabled": False,
            "policyId": f"policy:fixture_e2e:{_safe_suffix(payload.requestId)}",
            "portalTarget": "ais_usvisa_info",
            "requestId": payload.requestId,
            "requestedConsulateIds": payload.requestedConsulateIds,
            "source": "test_harness",
            "sourceKind": "fixture",
            "traceId": payload.traceId,
            "userConsent": "visible_session_only",
        }
    )


def _audit_event(
    *,
    action: str,
    actor_type: str,
    idempotency_key: str,
    occurred_at: datetime,
    reason: str,
    result: str,
    safe_summary: str,
    source: str,
    suffix: str,
    trace_id: str,
) -> AuditEvent:
    return AuditEvent.model_validate(
        {
            "action": action,
            "actorType": actor_type,
            "auditId": f"audit:fixture_e2e:{suffix}:{action}",
            "containsSensitiveRawData": False,
            "idempotencyKey": idempotency_key,
            "occurredAt": occurred_at,
            "reason": reason,
            "redactionLevel": "no_secrets",
            "result": result,
            "safeSummary": safe_summary,
            "source": source,
            "traceId": trace_id,
        }
    )


def _booking_assist_session(payload: FixtureE2ERunRequest, snapshot_id: str, candidate_id: str, now: datetime) -> BookingAssistSession:
    suffix = _safe_suffix(payload.idempotencyKey)
    return BookingAssistSession.model_validate(
        {
            "allowBookingConfirmation": False,
            "autoSubmitAllowed": False,
            "candidateId": candidate_id,
            "createdAt": _add_minutes(now, 2),
            "expiresAt": _add_minutes(now, 17),
            "finalConfirmationAuthority": "user_in_browser",
            "officialUrl": "https://ais.usvisa-info.com/en-ca/niv/schedule/fixture/appointment",
            "sessionId": f"session:fixture_e2e:{suffix}:assist",
            "snapshotId": snapshot_id,
            "status": "prepared",
            "traceId": payload.traceId,
            "visibleUserActionRequired": True,
        }
    )


def _notification_dispatch(
    *,
    idempotency_key: str,
    now: datetime,
    session: BookingAssistSession | None,
    snapshot: object | None,
    trace_id: str,
) -> NotificationDispatchBundle | None:
    if snapshot is None:
        return None
    snapshot_payload = snapshot.model_dump(mode="json")
    dispatch = create_fixture_notification_dispatch(
        idempotency_key=idempotency_key,
        now=now,
        preferences=create_notification_preferences(browser=True, telegram=True, email=False, now=now),
        queue_state={
            "bookingAssistSession": session.model_dump(mode="json") if session else None,
            "generatedAt": now.isoformat(),
            "latestSnapshot": snapshot_payload,
        },
        trace_id=trace_id,
    )
    return NotificationDispatchBundle.model_validate(dispatch)


def _as_replayed(response: FixtureE2ERunResponse) -> FixtureE2ERunResponse:
    return response.model_copy(
        update={
            "instrumentation": response.instrumentation.model_copy(
                update={
                    "idempotency": FixtureE2EIdempotencyState.model_validate(
                        {
                            "key": response.run.idempotencyKey,
                            "replayedRunId": response.run.runId,
                            "status": "replayed",
                        }
                    )
                }
            ),
            "replayed": True,
        }
    )


