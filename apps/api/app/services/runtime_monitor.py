from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from time import perf_counter

from app.schemas.monitoring import (
    RuntimeAnomalyEvent,
    RuntimeFeatureVector,
    RuntimeLatencySummary,
    RuntimeMonitoringResponse,
    RuntimeMonitorCounters,
    RuntimeMonitorRetention,
    RuntimeRedTeamSignals,
    RuntimeRouteSummary,
)

SLOW_REQUEST_THRESHOLD_MS = 750.0
MAX_RECENT_ANOMALIES = 200
MAX_ROUTE_SUMMARIES = 50
LATENCY_BUCKETS = (
    ("lt_50", 0.0, 50.0),
    ("50_100", 50.0, 100.0),
    ("100_250", 100.0, 250.0),
    ("250_500", 250.0, 500.0),
    ("500_1000", 500.0, 1000.0),
    ("gte_1000", 1000.0, float("inf")),
)


@dataclass
class _RouteStats:
    max_ms: float = 0.0
    slow_requests: int = 0
    total: int = 0
    total_ms: float = 0.0


class RuntimeMonitor:
    def __init__(
        self,
        *,
        max_recent_anomalies: int = MAX_RECENT_ANOMALIES,
        slow_threshold_ms: float = SLOW_REQUEST_THRESHOLD_MS,
    ) -> None:
        self._started_at = datetime.now(timezone.utc)
        self._started_perf = perf_counter()
        self._max_recent_anomalies = max_recent_anomalies
        self._slow_threshold_ms = slow_threshold_ms
        self._lock = Lock()
        self._recent_anomalies: deque[RuntimeAnomalyEvent] = deque(maxlen=max_recent_anomalies)
        self._route_stats: dict[tuple[str, str], _RouteStats] = {}
        self._latency_buckets = {name: 0 for name, _, _ in LATENCY_BUCKETS}
        self._status_classes = {name: 0 for name in ("1xx", "2xx", "3xx", "4xx", "5xx")}
        self._auth_rejections = 0
        self._client_errors = 0
        self._max_ms = 0.0
        self._min_ms: float | None = None
        self._rate_limited = 0
        self._requests_total = 0
        self._server_errors = 0
        self._slow_requests = 0
        self._total_ms = 0.0

    @property
    def started_at(self) -> datetime:
        return self._started_at

    def record_request(self, *, duration_ms: float, method: str, route: str, status_code: int) -> None:
        safe_route = _safe_route(route)
        safe_method = method.upper()[:12]
        signal = _signal_for(status_code=status_code, duration_ms=duration_ms, slow_threshold_ms=self._slow_threshold_ms)
        with self._lock:
            self._requests_total += 1
            self._total_ms += duration_ms
            self._max_ms = max(self._max_ms, duration_ms)
            self._min_ms = duration_ms if self._min_ms is None else min(self._min_ms, duration_ms)
            self._latency_buckets[_latency_bucket(duration_ms)] += 1

            status_class = f"{status_code // 100}xx"
            if status_class in self._status_classes:
                self._status_classes[status_class] += 1
            if status_code in {401, 403}:
                self._auth_rejections += 1
            if status_code == 429:
                self._rate_limited += 1
            if 400 <= status_code < 500:
                self._client_errors += 1
            if status_code >= 500:
                self._server_errors += 1
            if duration_ms >= self._slow_threshold_ms:
                self._slow_requests += 1

            route_key = (safe_method, safe_route)
            stats = self._route_stats.setdefault(route_key, _RouteStats())
            stats.total += 1
            stats.total_ms += duration_ms
            stats.max_ms = max(stats.max_ms, duration_ms)
            if duration_ms >= self._slow_threshold_ms:
                stats.slow_requests += 1

            if signal:
                self._recent_anomalies.append(
                    RuntimeAnomalyEvent.model_validate(
                        {
                            "durationMs": round(duration_ms, 2),
                            "method": safe_method,
                            "occurredAt": datetime.now(timezone.utc),
                            "route": safe_route,
                            "signal": signal,
                            "statusCode": status_code,
                        }
                    )
                )

    def snapshot(self) -> RuntimeMonitoringResponse:
        with self._lock:
            total = self._requests_total
            average_ms = self._total_ms / total if total else 0.0
            auth_rejection_rate = self._auth_rejections / total if total else 0.0
            error_rate = (self._client_errors + self._server_errors) / total if total else 0.0
            rate_limit_rate = self._rate_limited / total if total else 0.0
            slow_request_rate = self._slow_requests / total if total else 0.0
            red_team = RuntimeRedTeamSignals.model_validate(
                {
                    "authProbeSuspected": self._auth_rejections >= 10 and auth_rejection_rate >= 0.2,
                    "highErrorRate": total >= 20 and error_rate >= 0.2,
                    "rateLimitPressure": self._rate_limited >= 5 and rate_limit_rate >= 0.1,
                    "serverErrorSpike": self._server_errors >= 3,
                    "slowPathPressure": total >= 20 and slow_request_rate >= 0.25,
                }
            )
            route_summaries = [
                RuntimeRouteSummary.model_validate(
                    {
                        "averageMs": round(stats.total_ms / stats.total, 2) if stats.total else 0.0,
                        "maxMs": round(stats.max_ms, 2),
                        "method": method,
                        "route": route,
                        "slowRequests": stats.slow_requests,
                        "total": stats.total,
                    }
                )
                for (method, route), stats in sorted(
                    self._route_stats.items(),
                    key=lambda item: item[1].total,
                    reverse=True,
                )[:MAX_ROUTE_SUMMARIES]
            ]
            status = _status_from_signals(red_team)
            return RuntimeMonitoringResponse.model_validate(
                {
                    "counters": RuntimeMonitorCounters.model_validate(
                        {
                            "authRejections": self._auth_rejections,
                            "clientErrors": self._client_errors,
                            "rateLimited": self._rate_limited,
                            "requestsTotal": total,
                            "serverErrors": self._server_errors,
                            "slowRequests": self._slow_requests,
                            "statusClasses": dict(self._status_classes),
                        }
                    ),
                    "featureVector": RuntimeFeatureVector.model_validate(
                        {
                            "authRejectionRate": round(auth_rejection_rate, 6),
                            "errorRate": round(error_rate, 6),
                            "rateLimitRate": round(rate_limit_rate, 6),
                            "requestVolume": total,
                            "slowRequestRate": round(slow_request_rate, 6),
                        }
                    ),
                    "generatedAt": datetime.now(timezone.utc),
                    "latency": RuntimeLatencySummary.model_validate(
                        {
                            "averageMs": round(average_ms, 2),
                            "buckets": dict(self._latency_buckets),
                            "maxMs": round(self._max_ms, 2),
                            "minMs": round(self._min_ms or 0.0, 2),
                            "slowThresholdMs": self._slow_threshold_ms,
                        }
                    ),
                    "recentAnomalies": list(self._recent_anomalies),
                    "redTeamSignals": red_team,
                    "retention": RuntimeMonitorRetention.model_validate(
                        {
                            "eventPolicy": "anomalies_only",
                            "maxRecentEvents": self._max_recent_anomalies,
                            "storesBodies": False,
                            "storesHeaders": False,
                            "storesIpAddresses": False,
                            "storesQueryStrings": False,
                        }
                    ),
                    "routeSummaries": route_summaries,
                    "schemaVersion": "runtime_monitoring.v1",
                    "serviceUptimeSeconds": round(perf_counter() - self._started_perf, 2),
                    "status": status,
                }
            )


def _latency_bucket(duration_ms: float) -> str:
    for name, lower, upper in LATENCY_BUCKETS:
        if lower <= duration_ms < upper:
            return name
    return "gte_1000"


def _safe_route(route: str) -> str:
    value = route.strip() or "unknown_route"
    if "?" in value:
        value = value.split("?", 1)[0]
    return value[:160]


def _signal_for(*, duration_ms: float, slow_threshold_ms: float, status_code: int) -> str | None:
    if status_code in {401, 403}:
        return "auth_rejection"
    if status_code == 429:
        return "rate_limited"
    if status_code >= 500:
        return "server_error"
    if 400 <= status_code < 500:
        return "client_error"
    if duration_ms >= slow_threshold_ms:
        return "slow_request"
    return None


def _status_from_signals(signals: RuntimeRedTeamSignals) -> str:
    if signals.serverErrorSpike:
        return "degraded"
    if signals.authProbeSuspected or signals.rateLimitPressure or signals.slowPathPressure:
        return "watch"
    if signals.highErrorRate:
        return "watch"
    return "ok"
