from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from app.schemas.domain import AuditEvent, NotificationEvent

NotificationCommand = Literal["status", "open_browser", "confirm_booking"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_suffix(value: str) -> str:
    return "".join(character if character.isalnum() or character in "._:-" else ":" for character in value)[:64]


def create_notification_preferences(
    *,
    browser: bool = True,
    telegram: bool = False,
    email: bool = False,
    now: datetime | None = None,
) -> dict:
    created_at = now or _now()
    return {
        "allowExternalActions": False,
        "channels": {
            "browser": browser,
            "email": email,
            "telegram": telegram,
        },
        "containsSensitiveRawData": False,
        "createdAt": created_at.isoformat(),
        "includeBookingContext": True,
        "preferenceId": "notification:preferences:notification",
        "redactionLevel": "no_secrets",
        "telegramCommandScope": "status_only",
    }


def _safe_message(queue_state: dict) -> dict:
    latest_snapshot = queue_state.get("latestSnapshot") or {}
    candidates = latest_snapshot.get("candidates") or []
    candidate = candidates[0] if candidates else None
    location = candidate.get("consulateName") if candidate else "configured location"
    appointment = "the fixture window"
    if candidate:
        appointment = candidate.get("appointmentDate", "the fixture window")
        if candidate.get("appointmentTime"):
            appointment = f"{appointment} {candidate['appointmentTime']}"

    message = {
        "actionLabel": "Review candidate",
        "body": f"Candidate found for {location} on {appointment}. Review it in the tracker. No appointment action was taken.",
        "bookingLanguageStatus": "candidate_not_booked",
        "containsBookingConfirmation": False,
        "containsSensitiveRawData": False,
        "messageIntent": "alert_only",
        "title": "Visa appointment candidate found",
    }
    joined = f"{message['title']} {message['body']}".lower()
    for phrase in ["booked", "booking confirmed", "appointment changed", "reserved", "auto"]:
        if phrase in joined:
            raise ValueError(f"Notification copy contains unsafe phrase: {phrase}")
    return message


def _notification_event(*, now: datetime, queue_state: dict, trace_id: str) -> dict:
    latest_snapshot = queue_state.get("latestSnapshot") or {}
    snapshot_id = latest_snapshot.get("snapshotId")
    candidates = latest_snapshot.get("candidates") or []
    payload = {
        "channel": "browser",
        "containsBookingConfirmation": False,
        "createdAt": now,
        "deliveryStatus": "pending",
        "eventType": "availability_detected" if candidates else "check_failed",
        "messageIntent": "alert_only",
        "notificationId": f"notification:notification:{_safe_suffix(snapshot_id or queue_state.get('generatedAt', 'generated'))}",
        "redactionLevel": "no_secrets",
        "relatedSessionId": (queue_state.get("bookingAssistSession") or {}).get("sessionId"),
        "relatedSnapshotId": snapshot_id,
        "traceId": trace_id,
    }
    return NotificationEvent.model_validate(payload).model_dump(mode="json")


def _delivery(*, channel: str, enabled: bool, notification: dict, now: datetime, safe_message: dict) -> dict:
    status = "suppressed"
    reason = "channel_disabled"
    provider_message_id = None
    if enabled and channel == "browser":
        status = "sent"
        reason = "delivered"
        provider_message_id = f"browser:{_safe_suffix(notification['notificationId'])}"
    elif enabled:
        reason = "adapter_not_configured"

    return {
        "attemptedAt": now.isoformat(),
        "channel": channel,
        "containsBookingConfirmation": False,
        "containsSensitiveRawData": False,
        "deliveryId": f"delivery:notification:{channel}:{_safe_suffix(notification['notificationId'])}",
        "notificationId": notification["notificationId"],
        "providerMessageId": provider_message_id,
        "reason": reason,
        "safeMessage": safe_message,
        "status": status,
    }


def _audit_event(*, idempotency_key: str, now: datetime, notification: dict, trace_id: str) -> dict:
    payload = {
        "action": "notification_queued",
        "actorType": "notification",
        "auditId": f"audit:notification:{_safe_suffix(notification['notificationId'])}",
        "containsSensitiveRawData": False,
        "idempotencyKey": idempotency_key,
        "occurredAt": now,
        "reason": "slots_found",
        "redactionLevel": "no_secrets",
        "result": "accepted",
        "safeSummary": "Fixture candidate notification queued without booking-confirmation language.",
        "source": "service_worker",
        "traceId": trace_id,
    }
    return AuditEvent.model_validate(payload).model_dump(mode="json")


def create_fixture_notification_dispatch(
    *,
    idempotency_key: str,
    queue_state: dict,
    trace_id: str,
    preferences: dict | None = None,
    now: datetime | None = None,
) -> dict:
    attempted_at = now or _now()
    prefs = preferences or create_notification_preferences(now=attempted_at)
    notification = _notification_event(now=attempted_at, queue_state=queue_state, trace_id=trace_id)
    safe_message = _safe_message(queue_state)
    deliveries = [
        _delivery(channel="browser", enabled=bool(prefs["channels"]["browser"]), notification=notification, now=attempted_at, safe_message=safe_message),
        _delivery(channel="telegram", enabled=bool(prefs["channels"]["telegram"]), notification=notification, now=attempted_at, safe_message=safe_message),
        _delivery(channel="email", enabled=bool(prefs["channels"]["email"]), notification=notification, now=attempted_at, safe_message=safe_message),
    ]
    return {
        "auditEvent": _audit_event(idempotency_key=idempotency_key, now=attempted_at, notification=notification, trace_id=trace_id),
        "deliveries": deliveries,
        "notification": notification,
    }


def create_telegram_command_audit(
    *,
    command: NotificationCommand,
    idempotency_key: str,
    trace_id: str,
    now: datetime | None = None,
) -> dict:
    occurred_at = now or _now()
    allowed = command == "status"
    reason = "status_only"
    if command == "open_browser":
        reason = "browser_only_action"
    elif command == "confirm_booking":
        reason = "appointment_action_blocked"

    audit = AuditEvent.model_validate(
        {
            "action": "check_requested" if allowed else "policy_rejected",
            "actorType": "notification",
            "auditId": f"audit:notification:telegram:{_safe_suffix(command)}:{_safe_suffix(idempotency_key)}",
            "containsSensitiveRawData": False,
            "idempotencyKey": idempotency_key,
            "occurredAt": occurred_at,
            "reason": "manual_check" if allowed else "policy_blocked",
            "redactionLevel": "no_secrets",
            "result": "accepted" if allowed else "rejected",
            "safeSummary": "Telegram status command audited as read-only."
            if allowed
            else "Telegram command rejected because browser or appointment-changing authority stays in the browser.",
            "source": "api",
            "traceId": trace_id,
        }
    ).model_dump(mode="json")

    return {
        "allowed": allowed,
        "auditEvent": audit,
        "command": command,
        "reason": reason,
    }
