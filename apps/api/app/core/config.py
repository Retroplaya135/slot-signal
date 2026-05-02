import os
from datetime import datetime
from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field


Environment = Literal["local", "test", "staging", "production"]
ProviderDeliveryMode = Literal["disabled", "dry_run", "live"]


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    app_name: str = "Slot Signal API"
    api_version: str = "0.1.0"
    api_v1_prefix: str = "/v1"
    environment: Environment = "local"
    live_portal_enabled: Literal[False] = False
    database_enabled: Literal[False] = False
    audit_db_path: str | None = None
    audit_retention_days: int = Field(default=30, ge=1, le=365)
    queue_enabled: Literal[False] = False
    allowed_origins: tuple[str, ...] = Field(default_factory=tuple)
    admin_token_sha256: str | None = None
    client_token_sha256: str | None = None
    provider_delivery_mode: ProviderDeliveryMode = "disabled"
    production_api_origin: str | None = None
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: str | None = None
    email_from: str | None = None
    email_to: str | None = None
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    slack_bot_token: str | None = None
    slack_channel_id: str | None = None
    entitlement_required: bool = False
    entitlement_db_path: str | None = None
    clock_now: datetime | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            app_name=os.getenv("SLOT_SIGNAL_API_APP_NAME", cls.model_fields["app_name"].default),
            api_version=os.getenv(
                "SLOT_SIGNAL_API_VERSION", cls.model_fields["api_version"].default
            ),
            api_v1_prefix=os.getenv(
                "SLOT_SIGNAL_API_V1_PREFIX", cls.model_fields["api_v1_prefix"].default
            ),
            environment=_read_environment(),
            audit_db_path=_read_optional_path("SLOT_SIGNAL_AUDIT_DB_PATH"),
            audit_retention_days=_read_int(
                "SLOT_SIGNAL_AUDIT_RETENTION_DAYS",
                cls.model_fields["audit_retention_days"].default,
            ),
            allowed_origins=_read_csv("SLOT_SIGNAL_API_ALLOWED_ORIGINS"),
            admin_token_sha256=_read_optional_secret("SLOT_SIGNAL_API_ADMIN_TOKEN_SHA256"),
            client_token_sha256=_read_optional_secret("SLOT_SIGNAL_API_CLIENT_TOKEN_SHA256"),
            provider_delivery_mode=_read_provider_delivery_mode(),
            production_api_origin=_read_origin("SLOT_SIGNAL_PRODUCTION_API_ORIGIN"),
            smtp_host=_read_optional_secret("SLOT_SIGNAL_SMTP_HOST"),
            smtp_port=_read_int("SLOT_SIGNAL_SMTP_PORT", cls.model_fields["smtp_port"].default),
            smtp_username=_read_optional_secret("SLOT_SIGNAL_SMTP_USERNAME"),
            smtp_password=_read_optional_secret("SLOT_SIGNAL_SMTP_PASSWORD"),
            email_from=_read_optional_secret("SLOT_SIGNAL_EMAIL_FROM"),
            email_to=_read_optional_secret("SLOT_SIGNAL_EMAIL_TO"),
            telegram_bot_token=_read_optional_secret("SLOT_SIGNAL_TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=_read_optional_secret("SLOT_SIGNAL_TELEGRAM_CHAT_ID"),
            slack_bot_token=_read_optional_secret("SLOT_SIGNAL_SLACK_BOT_TOKEN"),
            slack_channel_id=_read_optional_secret("SLOT_SIGNAL_SLACK_CHANNEL_ID"),
            entitlement_required=_read_bool("SLOT_SIGNAL_ENTITLEMENT_REQUIRED", False),
            entitlement_db_path=_read_optional_path("SLOT_SIGNAL_ENTITLEMENT_DB_PATH"),
        )
        settings.validate_production_configuration()
        return settings

    @property
    def auth_required(self) -> bool:
        return self.environment in {"staging", "production"}

    @property
    def production_configuration_ready(self) -> bool:
        if self.environment != "production":
            return True
        try:
            self.validate_production_configuration()
        except ValueError:
            return False
        return True

    @property
    def provider_delivery_enabled(self) -> bool:
        return self.provider_delivery_mode == "live"

    def provider_channel_configured(self, channel: str) -> bool:
        if channel == "email":
            return all([self.smtp_host, self.email_from, self.email_to])
        if channel == "telegram":
            return bool(self.telegram_bot_token and self.telegram_chat_id)
        if channel == "slack":
            return bool(self.slack_bot_token and self.slack_channel_id)
        return False

    def validate_production_configuration(self) -> None:
        if self.environment != "production":
            return
        if not self.admin_token_sha256 or not _looks_like_sha256(self.admin_token_sha256):
            raise ValueError("SLOT_SIGNAL_API_ADMIN_TOKEN_SHA256 must be a SHA-256 hex digest in production.")
        if not self.client_token_sha256 or not _looks_like_sha256(self.client_token_sha256):
            raise ValueError("SLOT_SIGNAL_API_CLIENT_TOKEN_SHA256 must be a SHA-256 hex digest in production.")
        if not self.production_api_origin:
            raise ValueError("SLOT_SIGNAL_PRODUCTION_API_ORIGIN is required in production.")
        if self.allowed_origins:
            for origin in self.allowed_origins:
                _validate_https_origin(origin, key="SLOT_SIGNAL_API_ALLOWED_ORIGINS")
        else:
            raise ValueError("SLOT_SIGNAL_API_ALLOWED_ORIGINS must include the production extension origin.")
        if self.provider_delivery_mode == "live":
            configured = [channel for channel in ("email", "telegram", "slack") if self.provider_channel_configured(channel)]
            if not configured:
                raise ValueError("At least one provider channel must be configured when SLOT_SIGNAL_PROVIDER_DELIVERY_MODE=live.")
        if self.entitlement_required and not (self.entitlement_db_path or self.audit_db_path):
            raise ValueError("SLOT_SIGNAL_ENTITLEMENT_DB_PATH or SLOT_SIGNAL_AUDIT_DB_PATH is required when entitlement is required.")


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


def _read_origin(key: str) -> str | None:
    raw = os.getenv(key, "").strip().rstrip("/")
    if not raw:
        return None
    _validate_https_origin(raw, key=key)
    return raw


def _read_provider_delivery_mode() -> ProviderDeliveryMode:
    raw = os.getenv("SLOT_SIGNAL_PROVIDER_DELIVERY_MODE", "disabled").strip().lower()
    allowed: set[ProviderDeliveryMode] = {"disabled", "dry_run", "live"}
    if raw not in allowed:
        raise ValueError("SLOT_SIGNAL_PROVIDER_DELIVERY_MODE must be disabled, dry_run, or live.")
    return raw  # type: ignore[return-value]


def _looks_like_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdefABCDEF" for character in value)


def _validate_https_origin(origin: str, *, key: str) -> None:
    parsed = urlparse(origin)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError(f"{key} must contain HTTPS origins only.")
    if parsed.username or parsed.password:
        raise ValueError(f"{key} origins must not include credentials.")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError(f"{key} values must be origins only, with no path, query, or fragment.")
    hostname = parsed.hostname or ""
    if hostname in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        raise ValueError(f"{key} must not include localhost origins in production configuration.")
    if "*" in hostname:
        raise ValueError(f"{key} must not include wildcard origins.")
    if hostname == "ais.usvisa-info.com" or hostname.endswith(".ais.usvisa-info.com"):
        raise ValueError(f"{key} must not target AIS hosts.")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
