from __future__ import annotations

import hashlib
import hmac
from typing import Literal

from fastapi import HTTPException, Request

from app.core.config import Settings

AuthRole = Literal["admin", "client", "anonymous"]


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "").strip()
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _token_matches(token: str | None, expected_sha256: str | None) -> bool:
    if not token or not expected_sha256:
        return False
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return hmac.compare_digest(digest, expected_sha256.lower())


def resolve_auth_role(request: Request) -> AuthRole:
    settings: Settings = request.app.state.settings
    token = _bearer_token(request)
    if _token_matches(token, settings.admin_token_sha256):
        return "admin"
    if _token_matches(token, settings.client_token_sha256):
        return "client"
    return "anonymous"


def require_client_or_admin_auth(request: Request) -> AuthRole:
    settings: Settings = request.app.state.settings
    if not settings.auth_required:
        return "client"
    role = resolve_auth_role(request)
    if role in {"admin", "client"}:
        return role
    raise HTTPException(
        status_code=401,
        detail="Bearer client or admin token is required for this production API action.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_admin_auth(request: Request) -> AuthRole:
    settings: Settings = request.app.state.settings
    if not settings.auth_required:
        return "admin"
    role = resolve_auth_role(request)
    if role == "admin":
        return role
    if role == "client":
        raise HTTPException(status_code=403, detail="Admin token is required for this production API action.")
    raise HTTPException(
        status_code=401,
        detail="Bearer admin token is required for this production API action.",
        headers={"WWW-Authenticate": "Bearer"},
    )
