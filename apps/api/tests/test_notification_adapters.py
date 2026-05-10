from datetime import datetime, timezone

from app.notifications.adapters import (
    create_fixture_notification_dispatch,
    create_notification_preferences,
    create_telegram_command_audit,
)
from app.schemas.domain import NotificationEvent


NOW = datetime(2026, 5, 7, 20, 0, tzinfo=timezone.utc)


def fixture_queue_state() -> dict:
    return {
        "generatedAt": NOW.isoformat(),
        "latestSnapshot": {
            "snapshotId": "snapshot:notification:fixture:001",
            "candidates": [
                {
                    "appointmentDate": "2026-06-15",
                    "appointmentTime": "09:30",
                    "appointmentType": "consular",
                    "bookingAction": "open_official_page_only",
                    "candidateId": "candidate:notification:fixture:001",
                    "confidence": "high",
                    "consulateId": "consulate:mumbai",
                    "consulateName": "Fixture Consulate",
                    "detectedAt": NOW.isoformat(),
                    "piiIncluded": False,
                    "portalTarget": "ais_usvisa_info",
                    "rank": 1,
                    "snapshotId": "snapshot:notification:fixture:001",
                    "sourceKind": "fixture",
                }
            ],
        },
        "bookingAssistSession": None,
    }


def test_fixture_notification_dispatch_is_safe() -> None:
    dispatch = create_fixture_notification_dispatch(
        idempotency_key="idem:notification:notify:py",
        now=NOW,
        preferences=create_notification_preferences(browser=True, telegram=True, email=False, now=NOW),
        queue_state=fixture_queue_state(),
        trace_id="trace:notification:notify:py",
    )

    NotificationEvent.model_validate(dispatch["notification"])
    assert dispatch["notification"]["eventType"] == "availability_detected"
    assert dispatch["notification"]["containsBookingConfirmation"] is False
    assert dispatch["auditEvent"]["action"] == "notification_queued"

    browser_delivery = next(item for item in dispatch["deliveries"] if item["channel"] == "browser")
    assert browser_delivery["status"] == "sent"
    assert browser_delivery["safeMessage"]["bookingLanguageStatus"] == "candidate_not_booked"

    telegram_delivery = next(item for item in dispatch["deliveries"] if item["channel"] == "telegram")
    assert telegram_delivery["status"] == "suppressed"
    assert telegram_delivery["reason"] == "adapter_not_configured"

    email_delivery = next(item for item in dispatch["deliveries"] if item["channel"] == "email")
    assert email_delivery["status"] == "suppressed"
    assert email_delivery["reason"] == "channel_disabled"

    joined_copy = f"{browser_delivery['safeMessage']['title']} {browser_delivery['safeMessage']['body']}".lower()
    for unsafe_phrase in ["booked", "booking confirmed", "appointment changed", "reserved", "auto"]:
        assert unsafe_phrase not in joined_copy


def test_telegram_commands_are_audited_and_limited() -> None:
    status = create_telegram_command_audit(
        command="status",
        idempotency_key="idem:notification:telegram:status",
        now=NOW,
        trace_id="trace:notification:telegram:status",
    )
    assert status["allowed"] is True
    assert status["auditEvent"]["result"] == "accepted"

    open_browser = create_telegram_command_audit(
        command="open_browser",
        idempotency_key="idem:notification:telegram:open",
        now=NOW,
        trace_id="trace:notification:telegram:open",
    )
    assert open_browser["allowed"] is False
    assert open_browser["auditEvent"]["result"] == "rejected"

    confirm_booking = create_telegram_command_audit(
        command="confirm_booking",
        idempotency_key="idem:notification:telegram:book",
        now=NOW,
        trace_id="trace:notification:telegram:book",
    )
    assert confirm_booking["allowed"] is False
    assert confirm_booking["auditEvent"]["reason"] == "policy_blocked"
