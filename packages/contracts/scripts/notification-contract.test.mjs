import assert from "node:assert/strict";
import {
  createAdapterFixtureBundle,
  createFixtureNotificationDispatch,
  createNotificationPreferences,
  createTelegramCommandAudit,
  deriveVisaQueueState,
  mergeQueueRecords
} from "../dist/index.js";

const now = new Date("2026-05-07T20:00:00.000Z");
const queueBundle = createAdapterFixtureBundle({
  idempotencyKey: "idem:notification:fixture:001",
  now,
  requestId: "request:notification:fixture:001",
  traceId: "trace:notification:fixture:001"
});
const state = deriveVisaQueueState({
  generatedAt: now.toISOString(),
  permissionState: "missing",
  records: mergeQueueRecords([], queueBundle.records, now),
  restartRecovery: "indexeddb_loaded"
});

const preferences = createNotificationPreferences({
  browser: true,
  email: false,
  telegram: true
});
const dispatch = createFixtureNotificationDispatch({
  idempotencyKey: "idem:notification:notify:001",
  now,
  preferences,
  queueState: state,
  traceId: "trace:notification:notify:001"
});

assert.equal(dispatch.notification.eventType, "availability_detected", "fixture candidate should create an availability notification");
assert.equal(dispatch.notification.containsBookingConfirmation, false, "notification event cannot contain booking confirmation");
assert.equal(dispatch.auditEvent.action, "notification_queued", "notification dispatch should be audited");
assert.equal(dispatch.auditEvent.containsSensitiveRawData, false, "notification audit must be redacted");

const browserDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "browser");
assert.equal(browserDelivery?.status, "sent", "enabled browser fixture delivery should be sent");
assert.equal(browserDelivery?.containsBookingConfirmation, false, "browser delivery must not imply booking confirmation");
assert.equal(browserDelivery?.safeMessage.bookingLanguageStatus, "candidate_not_booked");

const telegramDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "telegram");
assert.equal(telegramDelivery?.status, "suppressed", "Telegram stays skeleton-gated until configured");
assert.equal(telegramDelivery?.reason, "adapter_not_configured", "Telegram skeleton should be explicit");

const emailDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "email");
assert.equal(emailDelivery?.status, "suppressed", "disabled email channel should be suppressed");
assert.equal(emailDelivery?.reason, "channel_disabled");

const joinedCopy = `${browserDelivery?.safeMessage.title} ${browserDelivery?.safeMessage.body}`.toLowerCase();
for (const unsafePhrase of ["booked", "booking confirmed", "appointment changed", "reserved", "auto"]) {
  assert.equal(joinedCopy.includes(unsafePhrase), false, `notification copy should not contain ${unsafePhrase}`);
}

const statusAudit = createTelegramCommandAudit({
  command: "status",
  idempotencyKey: "idem:notification:telegram:status",
  now,
  traceId: "trace:notification:telegram:status"
});
assert.equal(statusAudit.allowed, true, "Telegram status command should be allowed as read-only");
assert.equal(statusAudit.auditEvent.result, "accepted");

const openAudit = createTelegramCommandAudit({
  command: "open_browser",
  idempotencyKey: "idem:notification:telegram:open",
  now,
  traceId: "trace:notification:telegram:open"
});
assert.equal(openAudit.allowed, false, "Telegram cannot execute browser-only actions");
assert.equal(openAudit.auditEvent.result, "rejected");

const finalBookingAudit = createTelegramCommandAudit({
  command: "confirm_booking",
  idempotencyKey: "idem:notification:telegram:book",
  now,
  traceId: "trace:notification:telegram:book"
});
assert.equal(finalBookingAudit.allowed, false, "Telegram cannot confirm appointment-changing actions");
assert.equal(finalBookingAudit.auditEvent.reason, "policy_blocked");

console.log("Notification contract tests passed.");
