import assert from "node:assert/strict";
import {
  createFixtureNotificationDispatch,
  createWorkflowFixtureBundle,
  deriveVisaQueueState,
  mergeQueueRecords
} from "../dist/index.js";

const now = new Date("2026-05-07T21:00:00.000Z");
const traceId = "trace:fixture_e2e:e2e:001";
const idempotencyKey = "idem:fixture_e2e:e2e:001";

const bundle = createWorkflowFixtureBundle({
  idempotencyKey,
  now,
  requestId: "request:fixture_e2e:e2e:001",
  traceId
});

const records = mergeQueueRecords([], bundle.records, now);
const state = deriveVisaQueueState({
  generatedAt: now.toISOString(),
  permissionState: "missing",
  records,
  restartRecovery: "indexeddb_loaded"
});

assert.equal(state.latestSnapshot?.candidates.length, 1, "fixture should expose exactly one candidate");
assert.ok(state.bookingAssistSession, "fixture should prepare a booking-assist session");
assert.equal(state.bookingAssistSession?.candidateId, state.latestSnapshot?.candidates[0]?.candidateId);
assert.equal(state.bookingAssistSession?.allowBookingConfirmation, false);
assert.equal(state.bookingAssistSession?.autoSubmitAllowed, false);
assert.equal(state.bookingAssistSession?.visibleUserActionRequired, true);
assert.equal(state.bookingAssistSession?.finalConfirmationAuthority, "user_in_browser");

const dispatch = createFixtureNotificationDispatch({
  idempotencyKey: "idem:fixture_e2e:notification:001",
  now,
  queueState: state,
  traceId: "trace:fixture_e2e:notification:001"
});

assert.equal(dispatch.notification.relatedSessionId, state.bookingAssistSession?.sessionId);
assert.equal(dispatch.notification.relatedSnapshotId, state.latestSnapshot?.snapshotId);
assert.equal(dispatch.notification.eventType, "availability_detected");
assert.equal(dispatch.notification.containsBookingConfirmation, false);

const browserDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "browser");
assert.equal(browserDelivery?.status, "sent");
assert.equal(browserDelivery?.safeMessage.messageIntent, "alert_only");
assert.equal(browserDelivery?.safeMessage.containsBookingConfirmation, false);

const auditActions = new Set(state.auditEvents.map((event) => event.action));
assert.ok(auditActions.has("check_requested"), "workflow should audit check request receipt");
assert.ok(auditActions.has("snapshot_recorded"), "workflow should audit fixture snapshot recording");
assert.ok(auditActions.has("booking_assist_opened"), "workflow should audit booking-assist preparation");
assert.equal(state.auditEvents.every((event) => event.containsSensitiveRawData === false), true);
assert.equal(state.auditEvents.every((event) => event.traceId === traceId), true);

const replayed = mergeQueueRecords(records, bundle.records, new Date("2026-05-07T21:01:00.000Z"));
const replayedState = deriveVisaQueueState({
  generatedAt: "2026-05-07T21:01:00.000Z",
  permissionState: "missing",
  records: replayed,
  restartRecovery: "indexeddb_loaded"
});

assert.equal(replayedState.snapshots.length, 1, "idempotent replay should not duplicate snapshots");
assert.equal(replayedState.bookingAssistSession?.sessionId, state.bookingAssistSession?.sessionId);
assert.ok(replayedState.duplicateSuppressedCount >= 1, "idempotent replay should record duplicate suppression");

console.log("Workflow contract tests passed.");
