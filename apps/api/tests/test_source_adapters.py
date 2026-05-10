from datetime import datetime, timezone

from app.adapters.source import (
    FixtureVisaAvailabilityAdapter,
    PublicReferenceAvailabilityAdapter,
    classify_adapter_run_result,
)
from app.schemas.domain import (
    MIN_SAFE_CHECK_INTERVAL_MINUTES,
    AvailabilityCheckRequest,
    CheckPolicy,
)


NOW = datetime(2026, 5, 7, 19, 10, tzinfo=timezone.utc)


def policy() -> CheckPolicy:
    return CheckPolicy.model_validate(
        {
            "allowAutomatedBooking": False,
            "cooldownOnResults": ["http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty", "empty_response"],
            "createdAt": NOW,
            "livePortalChecksEnabled": False,
            "maxChecksPerDay": 24,
            "minCheckIntervalMinutes": MIN_SAFE_CHECK_INTERVAL_MINUTES,
            "mode": "fixture_only",
            "piiStorage": "none",
            "policyId": "policy:source_adapter:fixture-only",
            "requireVisibleUserConfirmation": True,
        }
    )


def request(source_kind: str = "fixture") -> AvailabilityCheckRequest:
    return AvailabilityCheckRequest.model_validate(
        {
            "createdAt": NOW,
            "idempotencyKey": f"idem:source_adapter:{source_kind}:001",
            "livePortalChecksEnabled": False,
            "policyId": "policy:source_adapter:fixture-only",
            "portalTarget": "ais_usvisa_info",
            "requestId": f"request:source_adapter:{source_kind}:001",
            "requestedConsulateIds": ["consulate:mumbai"],
            "source": "service_worker",
            "sourceKind": source_kind,
            "traceId": f"trace:source_adapter:{source_kind}:001",
            "userConsent": "visible_session_only",
        }
    )


def test_fixture_adapter_slots_found_is_safe() -> None:
    bundle = FixtureVisaAvailabilityAdapter().run(policy=policy(), request=request(), now=NOW, scenario="slots_found")

    assert bundle.classification == "success"
    assert bundle.runResult.livePortalRequestMade is False
    assert bundle.snapshot is not None
    assert len(bundle.snapshot.candidates) == 1
    assert bundle.snapshot.candidates[0].bookingAction == "open_official_page_only"
    assert bundle.auditEvent.containsSensitiveRawData is False


def test_fixture_adapter_no_slots_does_not_fabricate_candidates() -> None:
    bundle = FixtureVisaAvailabilityAdapter().run(policy=policy(), request=request(), now=NOW, scenario="no_slots")

    assert bundle.classification == "no_slots"
    assert bundle.snapshot is not None
    assert bundle.snapshot.candidates == []
    assert bundle.runResult.retryable is False


def test_fixture_adapter_cooldown_and_failure_classification() -> None:
    adapter = FixtureVisaAvailabilityAdapter()

    rate_limited = adapter.run(policy=policy(), request=request(), now=NOW, scenario="http_429")
    assert rate_limited.classification == "cooldown"
    assert rate_limited.runResult.httpStatus == 429
    assert rate_limited.runResult.cooldownMinutes is not None
    assert rate_limited.runResult.cooldownMinutes >= 60

    auth_required = adapter.run(policy=policy(), request=request(), now=NOW, scenario="auth_redirect")
    assert auth_required.classification == "auth_required"
    assert auth_required.runResult.retryable is False

    parser_mismatch = adapter.run(policy=policy(), request=request(), now=NOW, scenario="parser_mismatch")
    assert parser_mismatch.classification == "parser_mismatch"
    assert parser_mismatch.snapshot is None

    retry = adapter.run(policy=policy(), request=request(), now=NOW, scenario="network_error")
    assert retry.classification == "retry"
    assert retry.runResult.nextAllowedCheckAt is not None


def test_fixture_adapter_blocks_wrong_source_kind() -> None:
    bundle = FixtureVisaAvailabilityAdapter().run(policy=policy(), request=request("public_reference"), now=NOW)

    assert bundle.classification == "policy_blocked"
    assert bundle.runResult.livePortalRequestMade is False
    assert classify_adapter_run_result(bundle.runResult) == "policy_blocked"


def test_public_reference_adapter_is_placeholder_gated() -> None:
    bundle = PublicReferenceAvailabilityAdapter().run(policy=policy(), request=request("public_reference"), now=NOW)

    assert bundle.classification == "policy_blocked"
    assert bundle.runResult.sourceKind == "public_reference"
    assert bundle.runResult.livePortalRequestMade is False
    assert bundle.snapshot is None
