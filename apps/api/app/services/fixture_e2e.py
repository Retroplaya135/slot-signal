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


def _span(stage: FixtureE2EInstrumentationSpan.model_fields["stage"].annotation, now: datetime, index: int) -> FixtureE2EInstrumentationSpan:
    started_at = now + timedelta(milliseconds=index)
    finished_at = started_at + timedelta(milliseconds=1)
    return FixtureE2EInstrumentationSpan.model_validate(
        {
            "durationMs": 1,
            "finishedAt": finished_at,
            "result": "succeeded" if stage != "request_validated" else "accepted",
            "spanId": f"span:fixture_e2e:{index}:{stage}",
            "stage": stage,
            "startedAt": started_at,
        }
    )


def _policy(now: datetime, request_id: str) -> CheckPolicy:
    return CheckPolicy.model_validate(
        {
            "allowAutomatedBooking": False,
            "cooldownOnResults": ["http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty", "empty_response"],
            "createdAt": now,
            "livePortalChecksEnabled": False,
            "maxChecksPerDay": 24,
            "minCheckIntervalMinutes": MIN_SAFE_CHECK_INTERVAL_MINUTES,
            "mode": "fixture_only",
            "piiStorage": "none",
            "policyId": f"policy:fixture_e2e:{_safe_suffix(request_id)}",
            "requireVisibleUserConfirmation": True,
        }
    )


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


def _instrumentation(payload: FixtureE2ERunRequest, now: datetime, status: str, replayed_run_id: str | None = None) -> FixtureE2EInstrumentation:
    stages = [
        "request_validated",
        "adapter_completed",
        "notification_dispatched",
        "booking_assist_prepared",
        "audit_persisted",
    ]
    return FixtureE2EInstrumentation.model_validate(
        {
            "idempotency": FixtureE2EIdempotencyState.model_validate(
                {
                    "key": payload.idempotencyKey,
                    "replayedRunId": replayed_run_id,
                    "status": status,
                }
            ),
            "spans": [_span(stage, now, index) for index, stage in enumerate(stages, start=1)],
        }
    )


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


def execute_fixture_e2e_run(payload: FixtureE2ERunRequest, store: FixtureE2EStore) -> FixtureE2ERunResponse:
    existing = store.get_by_idempotency(payload.idempotencyKey)
    if existing:
        return _as_replayed(existing)

    run_started_at = payload.now or _now()
    suffix = _safe_suffix(payload.idempotencyKey)
    request = _availability_request(payload, run_started_at)
    adapter_bundle = FixtureVisaAvailabilityAdapter().run(
        now=run_started_at,
        policy=_policy(run_started_at, payload.requestId),
        request=request,
        scenario=payload.scenario,
    )

    session = None
    if adapter_bundle.snapshot and adapter_bundle.snapshot.candidates:
        candidate = adapter_bundle.snapshot.candidates[0]
        session = _booking_assist_session(payload, adapter_bundle.snapshot.snapshotId, candidate.candidateId, run_started_at)

    notification_dispatch = _notification_dispatch(
        idempotency_key=payload.idempotencyKey,
        now=run_started_at,
        session=session,
        snapshot=adapter_bundle.snapshot,
        trace_id=payload.traceId,
    )
    check_audit = _audit_event(
        action="check_requested",
        actor_type="test_harness",
        idempotency_key=payload.idempotencyKey,
        occurred_at=run_started_at,
        reason="manual_check",
        result="accepted",
        safe_summary="Fixture workflow request accepted in a controlled test environment.",
        source="test_harness",
        suffix=suffix,
        trace_id=payload.traceId,
    )
    audit_events = [check_audit, adapter_bundle.auditEvent]
    if notification_dispatch:
        audit_events.append(notification_dispatch.auditEvent)
    if session:
        audit_events.append(
            _audit_event(
                action="booking_assist_opened",
                actor_type="backend",
                idempotency_key=payload.idempotencyKey,
                occurred_at=_add_minutes(run_started_at, 3),
                reason="slots_found",
                result="accepted",
                safe_summary="Booking-assist session prepared for user review; no appointment-changing action was taken.",
                source="api",
                suffix=suffix,
                trace_id=payload.traceId,
            )
        )

    response = FixtureE2ERunResponse.model_validate(
        {
            "adapterRun": adapter_bundle.runResult,
            "appointmentChangingActionTaken": False,
            "auditEvents": audit_events,
            "bookingAssistSession": session,
            "instrumentation": _instrumentation(payload, run_started_at, "created"),
            "livePortalRequestMade": False,
            "notificationDispatch": notification_dispatch,
            "replayed": False,
            "run": FixtureE2ERun.model_validate(
                {
                    "createdAt": run_started_at,
                    "idempotencyKey": payload.idempotencyKey,
                    "runId": f"run:fixture_e2e:{suffix}",
                    "scenario": payload.scenario,
                    "status": "completed" if adapter_bundle.classification == "success" else "policy_blocked",
                    "traceId": payload.traceId,
                }
            ),
            "snapshot": adapter_bundle.snapshot,
        }
    )
    saved = store.save(response)
    if saved is not response:
        return _as_replayed(saved)
    return saved


def read_fixture_e2e_audit(run_id: str, store: FixtureE2EStore) -> FixtureE2EAuditReadResponse | None:
    response = store.get_by_run_id(run_id)
    if not response:
        return None
    return FixtureE2EAuditReadResponse.model_validate(
        {
            "auditEvents": response.auditEvents,
            "instrumentation": response.instrumentation,
            "runId": response.run.runId,
        }
    )
