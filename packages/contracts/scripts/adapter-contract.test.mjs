import assert from "node:assert/strict";
import {
  AvailabilityCheckRequestSchema,
  CheckPolicySchema,
  FixtureVisaAvailabilityAdapter,
  MIN_SAFE_CHECK_INTERVAL_MINUTES,
  PublicReferenceAvailabilityAdapter,
  classifyAdapterRunResult,
  createAdapterFixtureBundle,
  deriveVisaQueueState,
  mergeQueueRecords
} from "../dist/index.js";

const now = new Date("2026-05-07T19:10:00.000Z");
const policy = CheckPolicySchema.parse({
  allowAutomatedBooking: false,
  cooldownOnResults: ["http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty", "empty_response"],
  createdAt: now.toISOString(),
  livePortalChecksEnabled: false,
  maxChecksPerDay: 24,
  minCheckIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
  mode: "fixture_only",
  piiStorage: "none",
  policyId: "policy:source_adapter:fixture-only",
  requireVisibleUserConfirmation: true
});

function requestFor(sourceKind = "fixture") {
  return AvailabilityCheckRequestSchema.parse({
    createdAt: now.toISOString(),
    idempotencyKey: `idem:source_adapter:${sourceKind}:001`,
    livePortalChecksEnabled: false,
    policyId: policy.policyId,
    portalTarget: "ais_usvisa_info",
    requestId: `request:source_adapter:${sourceKind}:001`,
    requestedConsulateIds: ["consulate:mumbai"],
    source: "service_worker",
    sourceKind,
    traceId: `trace:source_adapter:${sourceKind}:001`,
    userConsent: "visible_session_only"
  });
}

const fixtureAdapter = new FixtureVisaAvailabilityAdapter();

const slotsFound = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "slots_found" });
assert.equal(slotsFound.classification, "success", "slots-found fixture should classify as success");
assert.equal(slotsFound.snapshot?.status, "slots_found", "slots-found fixture should include a snapshot");
assert.equal(slotsFound.snapshot?.candidates.length, 1, "slots-found fixture should include one safe candidate");
assert.equal(slotsFound.runResult.livePortalRequestMade, false, "fixture adapter must not call live portal");
assert.equal(slotsFound.snapshot?.candidates[0]?.bookingAction, "open_official_page_only", "candidate action should only open the official page");

const noSlots = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "no_slots" });
assert.equal(noSlots.classification, "no_slots", "no-slots fixture should classify as no_slots");
assert.equal(noSlots.snapshot?.candidates.length, 0, "no-slots fixture should not fabricate candidates");
assert.equal(noSlots.runResult.retryable, false, "no-slots fixture should not force fast retries");

const cooldown = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "http_429" });
assert.equal(cooldown.classification, "cooldown", "429 fixture should classify as cooldown");
assert.equal(cooldown.runResult.httpStatus, 429, "429 fixture should preserve status classification");
assert.ok(cooldown.runResult.cooldownMinutes >= 60, "429 fixture should cool down conservatively");

const authRequired = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "auth_redirect" });
assert.equal(authRequired.classification, "auth_required", "auth redirect should require user-visible auth");
assert.equal(authRequired.runResult.retryable, false, "auth redirect should not silently retry");

const parserMismatch = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "parser_mismatch" });
assert.equal(parserMismatch.classification, "parser_mismatch", "parser mismatch should stay explicit");
assert.equal(parserMismatch.snapshot, null, "parser mismatch should not create a misleading snapshot");

const retry = fixtureAdapter.run({ now, policy, request: requestFor(), scenario: "network_error" });
assert.equal(retry.classification, "retry", "network errors can be retry-classified without shortening policy");
assert.ok(retry.runResult.nextAllowedCheckAt, "retry classification should still carry a next safe check time");

const policyBlocked = fixtureAdapter.run({
  now,
  policy,
  request: {
    ...requestFor(),
    sourceKind: "public_reference"
  },
  scenario: "slots_found"
});
assert.equal(policyBlocked.classification, "policy_blocked", "fixture adapter should reject non-fixture requests");
assert.equal(policyBlocked.runResult.livePortalRequestMade, false, "policy block still must not call live portal");

const publicReference = new PublicReferenceAvailabilityAdapter().run({
  now,
  policy,
  request: requestFor("public_reference")
});
assert.equal(publicReference.classification, "policy_blocked", "public reference adapter is placeholder-gated");
assert.equal(publicReference.runResult.sourceKind, "public_reference", "public reference placeholder should preserve source kind");
assert.equal(publicReference.runResult.livePortalRequestMade, false, "public reference placeholder must not fetch network data");
assert.equal(classifyAdapterRunResult(publicReference.runResult), "policy_blocked");

const queueBundle = createAdapterFixtureBundle({
  idempotencyKey: "idem:source_adapter:queue:001",
  now,
  requestId: "request:source_adapter:queue:001",
  traceId: "trace:source_adapter:queue:001"
});
const queueState = deriveVisaQueueState({
  generatedAt: now.toISOString(),
  permissionState: "missing",
  records: mergeQueueRecords([], queueBundle.records, now),
  restartRecovery: "indexeddb_loaded"
});
assert.equal(queueState.latestRun?.resultReason, "slots_found", "queue bundle should expose adapter run result");
assert.equal(queueState.latestSnapshot?.sourceKind, "fixture", "queue bundle should expose fixture snapshot");
assert.equal(queueState.latestSnapshot?.livePortalRequestMade, false, "queue bundle must stay offline");
assert.equal(queueState.notifications.length, 0, "adapter workflow should not deliver notifications before approval");

console.log("Adapter contract tests passed.");
