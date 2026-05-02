import os
from datetime import datetime
from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field


Environment = Literal["local", "test", "staging", "production"]
ProviderDeliveryMode = Literal["disabled", "dry_run", "live"]


def _read_environment() -> Environment:
    raw = os.getenv("SLOT_SIGNAL_API_ENV", "local").strip().lower()
    allowed: set[Environment] = {"local", "test", "staging", "production"}
    if raw not in allowed:
        raise ValueError(
            "SLOT_SIGNAL_API_ENV must be one of local, test, staging, or production."
        )
    return raw  # type: ignore[return-value]


def _read_csv(key: str) -> tuple[str, ...]:
    raw = os.getenv(key, "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _read_optional_secret(key: str) -> str | None:
    raw = os.getenv(key, "").strip()
    return raw or None


def _read_optional_path(key: str) -> str | None:
    raw = os.getenv(key, "").strip()
    return raw or None


def _read_int(key: str, default: int) -> int:
    raw = os.getenv(key, "").strip()
    return int(raw) if raw else default


def _read_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{key} must be a boolean value.")


def _read_provider_delivery_mode() -> ProviderDeliveryMode:
    raw = os.getenv("SLOT_SIGNAL_PROVIDER_DELIVERY_MODE", "disabled").strip().lower()
    allowed: set[ProviderDeliveryMode] = {"disabled", "dry_run", "live"}
    if raw not in allowed:
        raise ValueError("SLOT_SIGNAL_PROVIDER_DELIVERY_MODE must be disabled, dry_run, or live.")
    return raw  # type: ignore[return-value]


def _looks_like_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdefABCDEF" for character in value)


