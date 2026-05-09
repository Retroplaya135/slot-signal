import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.domain import (
    DOMAIN_CONTRACT_MODELS,
    MIN_SAFE_CHECK_INTERVAL_MINUTES,
    AdapterRunResult,
    AuditEvent,
    AvailabilityCheckRequest,
    AvailabilitySnapshot,
    BookingAssistSession,
    CheckPolicy,
    NotificationEvent,
    SlotCandidate,
)


ROOT = Path(__file__).resolve().parents[3]
EXAMPLES = json.loads((ROOT / "packages/contracts/examples/domain-valid.json").read_text())
FIELD_MAP = json.loads((ROOT / "packages/contracts/src/domain-field-map.json").read_text())


def test_pydantic_contract_fields_match_shared_field_map() -> None:
    assert sorted(DOMAIN_CONTRACT_MODELS) == sorted(FIELD_MAP)
    for contract_name, model in DOMAIN_CONTRACT_MODELS.items():
        assert list(model.model_fields) == FIELD_MAP[contract_name]


def test_shared_examples_validate_in_pydantic() -> None:
    for contract_name, payload in EXAMPLES["contracts"].items():
        DOMAIN_CONTRACT_MODELS[contract_name].model_validate(payload)


def test_required_adapter_failure_reasons_are_representable() -> None:
    expected = {"http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty"}
    actual = set()
    for payload in EXAMPLES["adapterFailureResults"]:
        result = AdapterRunResult.model_validate(payload)
        actual.add(result.resultReason)

    assert actual == expected


@pytest.mark.parametrize(
    ("model", "contract_name", "field", "unsafe_value"),
    [
        (CheckPolicy, "CheckPolicy", "minCheckIntervalMinutes", MIN_SAFE_CHECK_INTERVAL_MINUTES - 1),
        (CheckPolicy, "CheckPolicy", "livePortalChecksEnabled", True),
        (CheckPolicy, "CheckPolicy", "allowAutomatedBooking", True),
        (AvailabilityCheckRequest, "AvailabilityCheckRequest", "livePortalChecksEnabled", True),
        (BookingAssistSession, "BookingAssistSession", "allowBookingConfirmation", True),
        (BookingAssistSession, "BookingAssistSession", "autoSubmitAllowed", True),
        (NotificationEvent, "NotificationEvent", "containsBookingConfirmation", True),
        (AuditEvent, "AuditEvent", "containsSensitiveRawData", True),
        (AdapterRunResult, "AdapterRunResult", "livePortalRequestMade", True),
        (SlotCandidate, "SlotCandidate", "bookingAction", "submit_booking"),
        (AvailabilitySnapshot, "AvailabilitySnapshot", "minNextCheckMinutes", MIN_SAFE_CHECK_INTERVAL_MINUTES - 1),
    ],
)
def test_contract_fixture_contracts_reject_unsafe_values(model, contract_name: str, field: str, unsafe_value) -> None:
    payload = dict(EXAMPLES["contracts"][contract_name])
    payload[field] = unsafe_value

    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_booking_assist_rejects_non_ais_url() -> None:
    payload = dict(EXAMPLES["contracts"]["BookingAssistSession"])
    payload["officialUrl"] = "https://example.com/book"

    with pytest.raises(ValidationError):
        BookingAssistSession.model_validate(payload)


def test_contracts_forbid_extra_fields() -> None:
    for contract_name, model in DOMAIN_CONTRACT_MODELS.items():
        payload = dict(EXAMPLES["contracts"][contract_name])
        payload["unsafeExtraField"] = "must be rejected"

        with pytest.raises(ValidationError):
            model.model_validate(payload)


def test_contract_field_names_do_not_invite_raw_secret_storage() -> None:
    banned_pattern = re.compile(r"(password|credential|secret|token)", re.IGNORECASE)
    for contract_name, fields in FIELD_MAP.items():
        for field in fields:
            assert not banned_pattern.search(field), f"{contract_name}.{field} should not be a raw secret field"
