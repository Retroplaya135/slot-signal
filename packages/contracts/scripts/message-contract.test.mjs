import assert from "node:assert/strict";
import {
  DEBUG_EXPORT_SCHEMA_VERSION,
  createClientErrorEnvelope,
  createEnvelope,
  createFixtureNotificationDispatch,
  createNotificationPreferences,
  createQueueFixtureBundle,
  deriveVisaQueueState,
  isExtensionMessage,
  MIN_SAFE_CHECK_INTERVAL_MINUTES,
  mergeQueueRecords,
  parseExtensionMessage
} from "../dist/index.js";

const statusRequest = createEnvelope({
  actor: "popup",
  payload: { reason: "popup_opened" },
  type: "extension.status.requested"
});

assert.equal(isExtensionMessage(statusRequest), true, "created envelope should validate");
assert.equal(parseExtensionMessage(statusRequest).ok, true, "created envelope should parse");
assert.equal(statusRequest.version, 1, "version should be stable");
assert.ok(statusRequest.traceId.length >= 8, "traceId should be present");

const missingEnvelopeFields = parseExtensionMessage({
  payload: { reason: "popup_opened" },
  type: "extension.status.requested"
});
assert.equal(missingEnvelopeFields.ok, false, "bare message should be rejected");

for (const actor of ["popup", "sidepanel", "options", "content_script"]) {
  const malformed = parseExtensionMessage({
    actor,
    id: `msg:${actor}:loop02`,
    payload: { reason: "manual_refresh" },
    traceId: `trace:${actor}:loop02`,
    type: "extension.status.requested",
    version: 1
  });
  assert.equal(malformed.ok, false, `${actor} message without createdAt/idempotencyKey should be rejected`);
}

const arbitraryContentInstruction = parseExtensionMessage({
  ...createEnvelope({
    actor: "content_script",
    payload: {
      origin: "https://ais.usvisa-info.com",
      path: "/en-ca/niv",
      stage: "scaffold_only",
      supported: true
    },
    type: "visa.portal.context_detected"
  }),
  payload: {
    origin: "https://ais.usvisa-info.com",
    path: "/en-ca/niv",
    selector: "form[action*=appointment]",
    stage: "scaffold_only",
    supported: true
  }
});
assert.equal(arbitraryContentInstruction.ok, false, "content script selector instructions should be rejected");

const unsupportedPortalOrigin = parseExtensionMessage({
  ...createEnvelope({
    actor: "content_script",
    payload: {
      origin: "https://ais.usvisa-info.com",
      path: "/en-ca/niv",
      stage: "scaffold_only",
      supported: true
    },
    type: "visa.portal.context_detected"
  }),
  payload: {
    origin: "https://example.com",
    path: "/en-ca/niv",
    stage: "scaffold_only",
    supported: true
  }
});
assert.equal(unsupportedPortalOrigin.ok, false, "unsupported portal origins should be rejected");

const validCooldown = createEnvelope({
  actor: "service_worker",
  payload: {
    detail: "Cooldown stays at or above the safe policy.",
    minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
    reason: "fixture_mode"
  },
  type: "visa.availability.cooldown_started"
});
const tooFastCheck = parseExtensionMessage({
  ...validCooldown,
  payload: {
    ...validCooldown.payload,
    minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES - 1
  }
});
assert.equal(tooFastCheck.ok, false, "cooldown below the minimum interval should be rejected");

const fixtureBundle = createQueueFixtureBundle({
  idempotencyKey: "idem:message:queue:001",
  now: new Date("2026-05-07T17:15:00.000Z"),
  traceId: "trace:message:queue:001"
});
const queueState = deriveVisaQueueState({
  generatedAt: "2026-05-07T17:15:00.000Z",
  permissionState: "missing",
  records: mergeQueueRecords([], fixtureBundle.records),
  restartRecovery: "indexeddb_loaded"
});
const queueStateResponse = createEnvelope({
  actor: "service_worker",
  payload: queueState,
  type: "visa.queue.state_responded"
});
assert.equal(isExtensionMessage(queueStateResponse), true, "queue state response should validate");

const debugExportResponse = createEnvelope({
  actor: "service_worker",
  payload: {
    bannedFieldScan: {
      checkedFieldPatterns: ["password", "credential", "secret", "token", "cookie", "rawPortalPayload"],
      findings: []
    },
    containsSensitiveRawData: false,
    debugSafety: {
      bannedFieldFindingCount: 0,
      containsSensitiveRawData: false,
      generatedAt: "2026-05-07T17:15:00.000Z",
      includesPortalPageDump: false,
      includesPrivateAuthData: false,
      redactionLevel: "no_secrets",
      schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION,
      userShareable: true
    },
    exportedAt: "2026-05-07T17:15:00.000Z",
    generatedBy: "service_worker",
    notificationSpamGuard: queueState.notificationSpamGuard,
    observability: queueState.observability,
    queueState,
    redactionLevel: "no_secrets",
    retentionPolicy: queueState.retentionPolicy,
    schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION
  },
  type: "visa.debug.export_responded"
});
assert.equal(isExtensionMessage(debugExportResponse), true, "debug export response should validate");

const unsafeDebugExport = parseExtensionMessage({
  ...debugExportResponse,
  payload: {
    ...debugExportResponse.payload,
    containsSensitiveRawData: true
  }
});
assert.equal(unsafeDebugExport.ok, false, "debug export must not include sensitive raw data");

const debugExportFinding = parseExtensionMessage({
  ...debugExportResponse,
  payload: {
    ...debugExportResponse.payload,
    bannedFieldScan: {
      ...debugExportResponse.payload.bannedFieldScan,
      findings: ["password"]
    }
  }
});
assert.equal(debugExportFinding.ok, false, "debug export must fail closed on banned field findings");

const notificationDispatch = createFixtureNotificationDispatch({
  idempotencyKey: "idem:message:notification:001",
  now: new Date("2026-05-07T17:16:00.000Z"),
  preferences: createNotificationPreferences({ browser: true, telegram: false, email: false }),
  queueState,
  traceId: "trace:message:notification:001"
});
const notificationRequest = createEnvelope({
  actor: "options",
  payload: {
    requestedAt: "2026-05-07T17:16:00.000Z",
    source: "options"
  },
  type: "visa.notification.test_requested"
});
assert.equal(isExtensionMessage(notificationRequest), true, "notification request should validate");

const notificationResponse = createEnvelope({
  actor: "service_worker",
  payload: notificationDispatch,
  type: "visa.notification.delivery_responded"
});
assert.equal(isExtensionMessage(notificationResponse), true, "notification delivery response should validate");

const unsafeNotificationResponse = parseExtensionMessage({
  ...notificationResponse,
  payload: {
    ...notificationResponse.payload,
    notification: {
      ...notificationResponse.payload.notification,
      containsBookingConfirmation: true
    }
  }
});
assert.equal(unsafeNotificationResponse.ok, false, "notification response cannot contain booking confirmation");

const unsafeQueueState = parseExtensionMessage({
  ...queueStateResponse,
  payload: {
    ...queueStateResponse.payload,
    cooldown: {
      ...queueStateResponse.payload.cooldown,
      minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES - 1
    }
  }
});
assert.equal(unsafeQueueState.ok, false, "queue state cannot lower cooldown policy");

const liveCheckAttempt = parseExtensionMessage({
  ...createEnvelope({
    actor: "popup",
    payload: {
      livePortalChecksEnabled: false,
      reason: "manual_check",
      requestedAt: new Date().toISOString(),
      source: "popup"
    },
    type: "visa.availability.check_requested"
  }),
  payload: {
    livePortalChecksEnabled: true,
    reason: "manual_check",
    requestedAt: new Date().toISOString(),
    source: "popup"
  }
});
assert.equal(liveCheckAttempt.ok, false, "live portal check attempts should be rejected");

const unsafeBookingRequest = parseExtensionMessage({
  ...statusRequest,
  type: "visa.booking.finalize_requested"
});
assert.equal(unsafeBookingRequest.ok, false, "unlisted appointment-changing requests should be rejected");

const clientError = createClientErrorEnvelope({
  actor: "service_worker",
  code: "unsupported_action",
  message: "Unsupported action."
});
assert.equal(clientError.type, "error.client_reported", "client errors should use a structured envelope");

console.log("Message contract tests passed.");
