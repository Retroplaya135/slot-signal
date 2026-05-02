from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from app.schemas.domain import ContractId, ContractModel

AccessCodeTier = Literal["beta", "advanced"]
AccessCodeStatus = Literal["active", "revoked", "expired"]
AccessCodeAuditAction = Literal[
    "issued",
    "verify_success",
    "verify_failed",
    "revoked",
    "expired",
]
AccessCodeVerifyReason = Literal[
    "valid",
    "malformed",
    "not_found",
    "revoked",
    "expired",
    "tier_insufficient",
]


class AccessCodeIssueRequest(ContractModel):
    accessCode: str = Field(min_length=6, max_length=160)
    expiresAt: datetime | None = None
    notes: str | None = Field(default=None, max_length=240)
    tier: AccessCodeTier = "beta"

    @field_validator("accessCode")
    @classmethod
    def reject_blank_or_whitespace_code(cls, value: str) -> str:
        normalized = value.strip()
        if len(normalized) < 6:
            raise ValueError("accessCode must contain at least 6 non-whitespace characters")
        return normalized


class AccessCodeUpdateRequest(ContractModel):
    auditReason: str | None = Field(default=None, max_length=240)
    expiresAt: datetime | None = None
    status: AccessCodeStatus | None = None
    tier: AccessCodeTier | None = None


class AccessCodeVerifyRequest(ContractModel):
    accessCode: str = Field(min_length=1, max_length=160)
    requiredTier: AccessCodeTier = "beta"


class AccessCodeEntitlementRecord(ContractModel):
    accessCodeHash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    entitlementId: ContractId
    expiresAt: datetime | None = None
    failedAttemptCount: int = Field(default=0, ge=0, le=100000)
    issuedAt: datetime
    lastVerifiedAt: datetime | None = None
    notes: str | None = Field(default=None, max_length=240)
    rawCodeStored: Literal[False]
    status: AccessCodeStatus
    tier: AccessCodeTier


class AccessCodeAuditEvent(ContractModel):
    action: AccessCodeAuditAction
    auditEventId: ContractId
    entitlementId: ContractId | None = None
    reason: AccessCodeVerifyReason | str
    recordedAt: datetime
    tier: AccessCodeTier | None = None


class AccessCodeIssueResponse(ContractModel):
    entitlement: AccessCodeEntitlementRecord


class AccessCodeListResponse(ContractModel):
    containsRawAccessCodes: Literal[False]
    entitlements: list[AccessCodeEntitlementRecord] = Field(max_length=500)


class AccessCodeUpdateResponse(ContractModel):
    auditEvent: AccessCodeAuditEvent
    entitlement: AccessCodeEntitlementRecord


class AccessCodeVerifyResponse(ContractModel):
    auditEvent: AccessCodeAuditEvent
    entitlement: AccessCodeEntitlementRecord | None = None
    reason: AccessCodeVerifyReason
    valid: bool


class AccessCodeAuditResponse(ContractModel):
    auditEvents: list[AccessCodeAuditEvent] = Field(max_length=1000)
    containsRawAccessCodes: Literal[False]
