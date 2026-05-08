from __future__ import annotations

import json
import smtplib
import ssl
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any
from urllib import request as urllib_request

from app.core.config import Settings
from app.schemas.provider_delivery import (
    ProviderDeliveryDispatchAuditEvent,
    ProviderDeliveryDispatchCreate,
    ProviderDeliveryDispatchResponse,
    ProviderDeliveryDispatchResult,
    ProviderDeliveryV2ReadinessResponse,
)
from app.schemas.slot_reports import ProviderOutboxDelivery

PROVIDER_RETRY_BACKOFF_SECONDS = 300


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_suffix(value: str | None) -> str:
    if not value:
        return "missing"
    return "".join(character if character.isalnum() or character in "._:-" else ":" for character in value)[:64]


def _dispatch_one(
    *,
    delivery: ProviderOutboxDelivery,
    payload: ProviderDeliveryDispatchCreate,
    recorded_at: datetime,
    settings: Settings,
) -> ProviderDeliveryDispatchResult:
    if not payload.explicitConsent:
        return _result(
            channel=delivery.channel,
            delivery=delivery,
            external_network_call_attempted=False,
            payload=payload,
            provider_failure_code=None,
            provider_message_id=None,
            reason="consent_missing",
            recorded_at=recorded_at,
            settings=settings,
            status="skipped",
        )
    if payload.dryRun or settings.provider_delivery_mode == "dry_run":
        return _result(
            channel=delivery.channel,
            delivery=delivery,
            external_network_call_attempted=False,
            payload=payload,
            provider_failure_code=None,
            provider_message_id=f"dry-run:{_safe_suffix(delivery.outboxDeliveryId)}",
            reason="dry_run_only",
            recorded_at=recorded_at,
            settings=settings,
            status="dry_run_recorded",
        )
    if settings.provider_delivery_mode != "live":
        return _result(
            channel=delivery.channel,
            delivery=delivery,
            external_network_call_attempted=False,
            payload=payload,
            provider_failure_code=None,
            provider_message_id=None,
            reason="provider_mode_disabled",
            recorded_at=recorded_at,
            settings=settings,
            status="blocked_not_configured",
        )
    if not settings.provider_channel_configured(delivery.channel) or delivery.payload is None:
        return _result(
            channel=delivery.channel,
            delivery=delivery,
            external_network_call_attempted=False,
            payload=payload,
            provider_failure_code=None,
            provider_message_id=None,
            reason="provider_channel_not_configured",
            recorded_at=recorded_at,
            settings=settings,
            status="blocked_not_configured",
        )

    try:
        provider_message_id = _send_live(delivery, settings)
    except Exception as error:
        return _result(
            channel=delivery.channel,
            delivery=delivery,
            external_network_call_attempted=True,
            payload=payload,
            provider_failure_code=_provider_failure_code(error),
            provider_message_id=None,
            reason="provider_send_failed",
            recorded_at=recorded_at,
            settings=settings,
            status="failed",
        )
    return _result(
        channel=delivery.channel,
        delivery=delivery,
        external_network_call_attempted=True,
        payload=payload,
        provider_failure_code=None,
        provider_message_id=provider_message_id,
        reason="provider_send_succeeded",
        recorded_at=recorded_at,
        settings=settings,
        status="sent",
    )


def _result(
    *,
    channel: str,
    delivery: ProviderOutboxDelivery | None,
    external_network_call_attempted: bool,
    payload: ProviderDeliveryDispatchCreate,
    provider_failure_code: str | None,
    provider_message_id: str | None,
    reason: str,
    recorded_at: datetime,
    settings: Settings,
    status: str,
) -> ProviderDeliveryDispatchResult:
    audit = ProviderDeliveryDispatchAuditEvent.model_validate(
        {
            "auditId": f"provider-audit:{_safe_suffix(delivery.outboxDeliveryId if delivery else reason)}:{_safe_suffix(channel)}",
            "channel": channel,
            "consentChecked": payload.explicitConsent,
            "containsSensitiveRawData": False,
            "externalNetworkCallAttempted": external_network_call_attempted,
            "notificationId": delivery.notificationId if delivery else None,
            "outboxDeliveryId": delivery.outboxDeliveryId if delivery else None,
            "providerFailureCode": provider_failure_code,
            "providerDeliveryMode": settings.provider_delivery_mode,
            "reason": reason,
            "recordedAt": recorded_at,
            "retryBackoffSeconds": PROVIDER_RETRY_BACKOFF_SECONDS,
            "status": status,
            "unsubscribeAction": payload.unsubscribeAction,
        }
    )
    return ProviderDeliveryDispatchResult.model_validate(
        {
            "auditEvent": audit,
            "channel": channel,
            "containsSensitiveRawData": False,
            "externalNetworkCallAttempted": external_network_call_attempted,
            "notificationId": delivery.notificationId if delivery else None,
            "outboxDeliveryId": delivery.outboxDeliveryId if delivery else None,
            "providerFailureCode": provider_failure_code,
            "providerMessageId": provider_message_id,
            "reason": reason,
            "status": status,
        }
    )


def _safe_provider_text(delivery: ProviderOutboxDelivery) -> str:
    payload = delivery.payload
    if payload is None:
        return "A community visa slot report matched your saved filter. Open the tracker to review."
    dates = ", ".join(date.isoformat() for date in payload.matchedDates)
    return (
        f"{payload.title}\n\n"
        f"{payload.postCity} {payload.visaClass}: {dates}\n"
        f"{payload.body}\n\n"
        "Open the tracker to review. No appointment was booked or changed.\n"
        "Unsubscribe: pause or delete this filter in the extension."
    )


def _provider_failure_code(error: Exception) -> str:
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return "smtp_auth_failed"
    if isinstance(error, smtplib.SMTPConnectError):
        return "smtp_connect_failed"
    if isinstance(error, smtplib.SMTPServerDisconnected):
        return "smtp_server_disconnected"
    if isinstance(error, smtplib.SMTPRecipientsRefused):
        return "smtp_recipients_refused"
    if isinstance(error, smtplib.SMTPSenderRefused):
        return "smtp_sender_refused"
    if isinstance(error, smtplib.SMTPResponseException):
        return f"smtp_response_{error.smtp_code}"
    if isinstance(error, TimeoutError):
        return "network_timeout"
    if isinstance(error, ConnectionRefusedError):
        return "connection_refused"
    if isinstance(error, ssl.SSLError):
        return "tls_failed"
    if isinstance(error, OSError):
        return "network_error"
    return "provider_exception"


def _send_live(delivery: ProviderOutboxDelivery, settings: Settings) -> str:
    if delivery.channel == "email":
        return _send_email(delivery, settings)
    if delivery.channel == "telegram":
        return _send_telegram(delivery, settings)
    if delivery.channel == "slack":
        return _send_slack(delivery, settings)
    raise ValueError(f"Unsupported provider channel: {delivery.channel}")


def _send_email(delivery: ProviderOutboxDelivery, settings: Settings) -> str:
    message = EmailMessage()
    message["From"] = settings.email_from or ""
    message["To"] = settings.email_to or ""
    message["Subject"] = "Community visa slot report"
    message.set_content(_safe_provider_text(delivery))
    context = ssl.create_default_context()
    with smtplib.SMTP(settings.smtp_host or "", settings.smtp_port, timeout=10) as smtp:
        smtp.starttls(context=context)
        if settings.smtp_username and settings.smtp_password:
            smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(message)
    return f"email:{_safe_suffix(delivery.outboxDeliveryId)}"


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
    request = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=10) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw or "{}")


def _send_telegram(delivery: ProviderOutboxDelivery, settings: Settings) -> str:
    response = _post_json(
        f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
        {
            "chat_id": settings.telegram_chat_id,
            "disable_web_page_preview": True,
            "text": _safe_provider_text(delivery),
        },
    )
    return f"telegram:{_safe_suffix(str(response.get('result', {}).get('message_id', delivery.outboxDeliveryId)))}"


def _send_slack(delivery: ProviderOutboxDelivery, settings: Settings) -> str:
    response = _post_json(
        "https://slack.com/api/chat.postMessage",
        {
            "channel": settings.slack_channel_id,
            "text": _safe_provider_text(delivery),
            "unfurl_links": False,
            "unfurl_media": False,
        },
        headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
    )
    return f"slack:{_safe_suffix(str(response.get('ts', delivery.outboxDeliveryId)))}"
