import assert from "node:assert/strict";
import {
  MIN_SAFE_CHECK_INTERVAL_MINUTES,
  QUEUE_RETENTION_LIMIT,
  compactQueueRecords,
  createQueueFixtureBundle,
  deriveVisaQueueState,
  mergeQueueRecords,
  parseQueueRecordsForIntegrity
} from "../dist/index.js";

const now = new Date("2026-05-07T17:00:00.000Z");
const bundle = createQueueFixtureBundle({
  idempotencyKey: "idem:queue_fixture:fixture:001",
  now,
  traceId: "trace:queue_fixture:fixture:001"
});

assert.equal(bundle.records.length, 6, "fixture bundle should contain request, run, snapshot, assist, notification, audit");

const firstMerge = mergeQueueRecords([], bundle.records, now);
const firstState = deriveVisaQueueState({
  generatedAt: now.toISOString(),
  permissionState: "missing",
  records: firstMerge,
  restartRecovery: "empty_initialized"
});

assert.equal(firstState.snapshots.length, 1, "fixture snapshot should be visible");
assert.equal(firstState.latestSnapshot?.candidates.length, 1, "fixture candidate should be visible");
assert.equal(firstState.cooldown.active, true, "fixture snapshot should create active cooldown");
assert.equal(firstState.cooldown.minimumIntervalMinutes, MIN_SAFE_CHECK_INTERVAL_MINUTES);
assert.equal(firstState.backendStatus, "offline_fixture");
assert.equal(firstState.permissionState, "missing");

const duplicateMerge = mergeQueueRecords(firstMerge, bundle.records, new Date("2026-05-07T17:01:00.000Z"));
const duplicateState = deriveVisaQueueState({
  generatedAt: "2026-05-07T17:01:00.000Z",
  permissionState: "missing",
  records: duplicateMerge,
  restartRecovery: "indexeddb_loaded"
});

assert.equal(duplicateState.snapshots.length, 1, "duplicate fixture replay should not duplicate snapshots");
assert.ok(duplicateState.duplicateSuppressedCount >= 1, "duplicate replay should be counted");
assert.equal(duplicateState.restartRecovery, "indexeddb_loaded", "state should be derivable after simulated restart");
assert.equal(duplicateState.latestSnapshot?.livePortalRequestMade, false, "fixture state should not claim live portal calls");
assert.equal(duplicateState.bookingAssistSession?.allowBookingConfirmation, false, "assist stays no-submit");

const alternateBundle = createQueueFixtureBundle({
  idempotencyKey: "idem:queue_fixture:fixture:alternate",
  now,
  requestId: "request:queue_fixture:alternate",
  traceId: "trace:queue_fixture:fixture:alternate"
});
const alternateMerge = mergeQueueRecords(firstMerge, alternateBundle.records, new Date("2026-05-07T17:02:00.000Z"));
const alternateState = deriveVisaQueueState({
  generatedAt: "2026-05-07T17:02:00.000Z",
  permissionState: "missing",
  records: alternateMerge,
  restartRecovery: "indexeddb_loaded"
});
assert.equal(alternateState.snapshots.length, 1, "alternate request with same snapshot id should not duplicate snapshots");
assert.ok(alternateState.duplicateSuppressedCount >= 1, "alternate replay should expose suppressed duplicate records");

const corruptRecord = {
  ...bundle.records[0],
  payload: {
    ...bundle.records[0].payload,
    livePortalChecksEnabled: true
  }
};
const integrityResult = parseQueueRecordsForIntegrity({
  existingQuarantineCount: 2,
  now: new Date("2026-05-07T17:03:00.000Z"),
  rawRecords: [...bundle.records, corruptRecord]
});
assert.equal(integrityResult.records.length, 6, "valid records should survive corrupt record quarantine");
assert.equal(integrityResult.corruptRecords.length, 1, "corrupt record should be quarantined");
assert.equal(integrityResult.integrity.corruptRecordCount, 1, "current corrupt count should be visible");
assert.equal(integrityResult.integrity.quarantineStoreCount, 3, "existing quarantine count should be preserved");

const oversizedRecords = Array.from({ length: QUEUE_RETENTION_LIMIT + 5 }, (_, index) => {
  return {
    ...bundle.records[0],
    createdAt: new Date(now.getTime() + index * 1000).toISOString(),
    key: `request:retention:${String(index).padStart(3, "0")}`
  };
});
const compacted = compactQueueRecords(oversizedRecords);
assert.equal(compacted.records.length, QUEUE_RETENTION_LIMIT, "queue compaction should enforce retention limit");
assert.equal(compacted.compactedRecordCount, 5, "queue compaction should report removed records");

const afterCooldownState = deriveVisaQueueState({
  generatedAt: "2026-05-07T17:30:00.000Z",
  integrity: integrityResult.integrity,
  permissionState: "missing",
  records: duplicateMerge,
  restartRecovery: "indexeddb_loaded"
});
assert.equal(afterCooldownState.cooldown.active, false, "cooldown should expire from stored timestamp");
assert.equal(afterCooldownState.integrity?.corruptRecordCount, 1, "queue integrity should be included when provided");

console.log("Queue contract tests passed.");
