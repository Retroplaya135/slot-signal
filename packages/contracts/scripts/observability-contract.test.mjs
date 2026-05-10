import assert from "node:assert/strict";
import {
  DEBUG_EXPORT_SCHEMA_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  createFixtureNotificationDispatch,
  createWorkflowFixtureBundle,
  createStructuredObservabilityEvent,
  deriveVisaQueueState,
  mergeQueueRecords
} from "../dist/index.js";

const now = new Date("2026-05-07T23:00:00.000Z");
const traceId = "trace:observability:observability:001";
const idempotencyKey = "idem:observability:observability:001";

const fixture = createWorkflowFixtureBundle({
  idempotencyKey,
  now,
  requestId: "request:observability:observability:001",
  traceId
});

const firstState = deriveVisaQueueState({
  generatedAt: now.toISOString(),
  permissionState: "missing",
  records: mergeQueueRecords([], fixture.records, now),
  restartRecovery: "indexeddb_loaded"
});

assert.equal(firstState.retentionPolicy.schemaVersion, OBSERVABILITY_SCHEMA_VERSION);
assert.equal(firstState.retentionPolicy.debugExportIncludesPageDumps, false);
assert.equal(firstState.retentionPolicy.debugExportIncludesPrivateAuthData, false);
assert.equal(firstState.retentionPolicy.quarantineInvalidRecords, true);
assert.equal(firstState.retentionPolicy.localQueueRetentionRecords, firstState.integrity?.retentionLimit ?? 200);

assert.equal(firstState.notificationSpamGuard.schemaVersion, OBSERVABILITY_SCHEMA_VERSION);
assert.equal(firstState.notificationSpamGuard.status, "ready");
assert.equal(firstState.notificationSpamGuard.minimumIntervalMinutes, 15);
assert.equal(firstState.notificationSpamGuard.containsSensitiveRawData, false);

assert.equal(firstState.observability.schemaVersion, OBSERVABILITY_SCHEMA_VERSION);
assert.equal(firstState.observability.logFormat, "json");
assert.equal(firstState.observability.traceCoverage, "all_records_with_trace");
assert.equal(firstState.observability.missingTraceCount, 0);
assert.equal(firstState.observability.containsSensitiveRawData, false);
assert.ok(firstState.observability.traceIds.includes(traceId), "queue state should expose trace id coverage");

const dispatch = createFixtureNotificationDispatch({
  idempotencyKey: "idem:observability:notification:001",
  now,
  queueState: firstState,
  traceId: "trace:observability:notification:001"
});
const stateWithNotification = deriveVisaQueueState({
  generatedAt: "2026-05-07T23:01:00.000Z",
  permissionState: "missing",
  records: mergeQueueRecords(firstState.snapshots.length ? mergeQueueRecords([], fixture.records, now) : [], [
    {
      createdAt: dispatch.notification.createdAt,
      idempotencyKey: "idem:observability:notification:001",
      key: `notification:${dispatch.notification.notificationId}`,
      kind: "notification",
      payload: dispatch.notification,
      traceId: "trace:observability:notification:001"
    }
  ]),
  restartRecovery: "indexeddb_loaded"
});

assert.equal(stateWithNotification.notificationSpamGuard.status, "guarded");
assert.equal(stateWithNotification.notificationSpamGuard.reason, "within_minimum_interval");
assert.equal(stateWithNotification.notificationSpamGuard.lastNotificationAt, dispatch.notification.createdAt);
assert.ok(stateWithNotification.notificationSpamGuard.nextAllowedNotificationAt, "guard should expose next allowed notification time");

const event = createStructuredObservabilityEvent({
  component: "service_worker",
  eventName: "debug.export.generated",
  idempotencyKey,
  metadata: {
    queueDepth: stateWithNotification.queueDepth,
    permissionState: stateWithNotification.permissionState,
    spamGuardStatus: stateWithNotification.notificationSpamGuard.status
  },
  occurredAt: now.toISOString(),
  reason: "manual_debug_export",
  result: "succeeded",
  safeSummary: "Redacted debug export generated for user review.",
  severity: "info",
  traceId
});

assert.equal(event.schemaVersion, OBSERVABILITY_SCHEMA_VERSION);
assert.equal(event.logFormat, "json");
assert.equal(event.containsSensitiveRawData, false);
assert.equal(event.redactionLevel, "no_secrets");
assert.equal(event.metadata.permissionState, "missing");

const debugPayload = {
  bannedFieldScan: {
    checkedFieldPatterns: ["password", "credential", "secret", "token", "cookie", "rawPortalPayload"],
    findings: []
  },
  containsSensitiveRawData: false,
  debugSafety: {
    bannedFieldFindingCount: 0,
    containsSensitiveRawData: false,
    generatedAt: now.toISOString(),
    includesPortalPageDump: false,
    includesPrivateAuthData: false,
    redactionLevel: "no_secrets",
    schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION,
    userShareable: true
  },
  exportedAt: now.toISOString(),
  generatedBy: "service_worker",
  notificationSpamGuard: stateWithNotification.notificationSpamGuard,
  observability: stateWithNotification.observability,
  queueState: stateWithNotification,
  redactionLevel: "no_secrets",
  retentionPolicy: stateWithNotification.retentionPolicy,
  schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION
};

assert.equal(debugPayload.debugSafety.userShareable, true);
assert.equal(debugPayload.debugSafety.includesPortalPageDump, false);
assert.equal(debugPayload.debugSafety.includesPrivateAuthData, false);

console.log("Observability contract tests passed.");
