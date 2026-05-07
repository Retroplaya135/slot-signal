from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from app.schemas.domain import (
    MIN_SAFE_CHECK_INTERVAL_MINUTES,
    AdapterRunResult,
    AuditEvent,
    AvailabilityCheckRequest,
    AvailabilitySnapshot,
    CheckPolicy,
    SlotCandidate,
)

AdapterClassification = Literal[
    "success",
    "no_slots",
    "retry",
    "cooldown",
    "auth_required",
    "parser_mismatch",
    "policy_blocked",
]
FixtureAdapterScenario = Literal[
    "slots_found",
    "no_slots",
    "http_403",
    "http_429",
    "auth_redirect",
    "parser_mismatch",
    "repeated_empty",
    "empty_response",
    "network_error",
    "policy_blocked",
]


@dataclass(frozen=True)
class AdapterRunBundle:
    adapterId: str
    classification: AdapterClassification
    request: AvailabilityCheckRequest
    runResult: AdapterRunResult
    snapshot: AvailabilitySnapshot | None
    auditEvent: AuditEvent


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _add_minutes(value: datetime, minutes: int) -> datetime:
    return value + timedelta(minutes=minutes)


def _safe_suffix(value: str) -> str:
    return "".join(character if character.isalnum() or character in "._:-" else ":" for character in value)[:64]


def _cooldown_minutes_for_scenario(scenario: FixtureAdapterScenario, policy: CheckPolicy) -> int:
    if scenario == "http_429":
        return max(60, policy.minCheckIntervalMinutes)
    if scenario in {"http_403", "auth_redirect", "parser_mismatch"}:
        return max(30, policy.minCheckIntervalMinutes)
    return policy.minCheckIntervalMinutes


def _build_snapshot(
    *,
    captured_at: datetime,
    policy: CheckPolicy,
    request: AvailabilityCheckRequest,
    scenario: Literal["slots_found", "no_slots"],
) -> AvailabilitySnapshot:
    suffix = _safe_suffix(request.requestId)
    snapshot_id = f"snapshot:source_adapter:{suffix}:{scenario}"
    candidates = []
    if scenario == "slots_found":
        candidates.append(
            SlotCandidate.model_validate(
                {
                    "appointmentDate": "2026-06-15",
                    "appointmentTime": "09:30",
                    "appointmentType": "consular",
                    "bookingAction": "open_official_page_only",
                    "candidateId": f"candidate:source_adapter:{suffix}:001",
                    "confidence": "high",
                    "consulateId": request.requestedConsulateIds[0],
                    "consulateName": "Fixture Consulate",
                    "detectedAt": captured_at,
                    "piiIncluded": False,
                    "portalTarget": request.portalTarget,
                    "rank": 1,
                    "snapshotId": snapshot_id,
                    "sourceKind": request.sourceKind,
                }
            )
        )

    return AvailabilitySnapshot.model_validate(
        {
            "auditEventId": f"audit:source_adapter:{suffix}:{scenario}",
            "candidates": candidates,
            "capturedAt": captured_at,
            "livePortalRequestMade": False,
            "minNextCheckMinutes": policy.minCheckIntervalMinutes,
            "nextAllowedCheckAt": _add_minutes(captured_at, policy.minCheckIntervalMinutes),
            "portalTarget": request.portalTarget,
            "requestId": request.requestId,
            "resultReason": scenario,
            "snapshotId": snapshot_id,
            "sourceKind": request.sourceKind,
            "status": scenario,
        }
    )


def _build_run_result(
    *,
    finished_at: datetime,
    policy: CheckPolicy,
    request: AvailabilityCheckRequest,
    scenario: FixtureAdapterScenario,
    snapshot: AvailabilitySnapshot | None,
) -> AdapterRunResult:
    status_by_scenario = {
        "auth_redirect": "failed",
        "empty_response": "cooldown",
        "http_403": "cooldown",
        "http_429": "cooldown",
        "network_error": "failed",
        "no_slots": "no_slots",
        "parser_mismatch": "failed",
        "policy_blocked": "failed",
        "repeated_empty": "cooldown",
        "slots_found": "succeeded",
    }
    http_status_by_scenario = {"http_403": 403, "http_429": 429}
    cooldown_minutes = None if scenario == "policy_blocked" else _cooldown_minutes_for_scenario(scenario, policy)
    next_allowed = snapshot.nextAllowedCheckAt if snapshot else (_add_minutes(finished_at, cooldown_minutes) if cooldown_minutes else None)

    return AdapterRunResult.model_validate(
        {
            "cooldownMinutes": cooldown_minutes,
            "finishedAt": finished_at,
            "httpStatus": http_status_by_scenario.get(scenario),
            "livePortalRequestMade": False,
            "nextAllowedCheckAt": next_allowed,
            "requestId": request.requestId,
            "resultReason": scenario,
            "retryable": scenario in {"http_429", "network_error", "repeated_empty", "empty_response"},
            "runId": f"run:source_adapter:{_safe_suffix(request.requestId)}:{scenario}",
            "snapshotId": snapshot.snapshotId if snapshot else None,
            "sourceKind": request.sourceKind,
            "startedAt": finished_at - timedelta(seconds=1),
            "status": status_by_scenario[scenario],
            "traceId": request.traceId,
        }
    )


