import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AdapterRunResultSchema,
  AuditEventSchema,
  AvailabilityCheckRequestSchema,
  AvailabilitySnapshotSchema,
  BookingAssistSessionSchema,
  CheckPolicySchema,
  DomainContractSchemas,
  MIN_SAFE_CHECK_INTERVAL_MINUTES,
  NotificationEventSchema,
  SlotCandidateSchema
} from "../dist/index.js";

const examples = JSON.parse(
  readFileSync(new URL("../examples/domain-valid.json", import.meta.url), "utf8")
);
const fieldMap = JSON.parse(
  readFileSync(new URL("../src/domain-field-map.json", import.meta.url), "utf8")
);

const schemas = {
  AdapterRunResult: AdapterRunResultSchema,
  AuditEvent: AuditEventSchema,
  AvailabilityCheckRequest: AvailabilityCheckRequestSchema,
  AvailabilitySnapshot: AvailabilitySnapshotSchema,
  BookingAssistSession: BookingAssistSessionSchema,
  CheckPolicy: CheckPolicySchema,
  NotificationEvent: NotificationEventSchema,
  SlotCandidate: SlotCandidateSchema
};

assert.deepEqual(
  Object.keys(DomainContractSchemas).sort(),
  Object.keys(fieldMap).sort(),
  "schema registry should cover every field-map contract"
);

for (const [contractName, schema] of Object.entries(schemas)) {
  assert.deepEqual(Object.keys(schema.shape), fieldMap[contractName], `${contractName} fields should match field map`);
  assert.equal(
    schema.safeParse(examples.contracts[contractName]).success,
    true,
    `${contractName} example should parse`
  );

  const withExtraField = {
    ...examples.contracts[contractName],
    unsafeExtraField: "must be rejected"
  };
  assert.equal(schema.safeParse(withExtraField).success, false, `${contractName} should reject extra fields`);
}

for (const result of examples.adapterFailureResults) {
  assert.equal(AdapterRunResultSchema.safeParse(result).success, true, `${result.resultReason} should be representable`);
}
assert.deepEqual(
  new Set(examples.adapterFailureResults.map((result) => result.resultReason)),
  new Set(["http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty"]),
  "required cooldown/failure reasons should be represented"
);

assert.equal(
  CheckPolicySchema.safeParse({
    ...examples.contracts.CheckPolicy,
    minCheckIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES - 1
  }).success,
  false,
  "short polling policies should be rejected"
);
assert.equal(
  CheckPolicySchema.safeParse({
    ...examples.contracts.CheckPolicy,
    livePortalChecksEnabled: true
  }).success,
  false,
  "live portal checks should not be enabled by domain contracts"
);
assert.equal(
  CheckPolicySchema.safeParse({
    ...examples.contracts.CheckPolicy,
    allowAutomatedBooking: true
  }).success,
  false,
  "automated booking should be impossible in policy contracts"
);
assert.equal(
  AvailabilityCheckRequestSchema.safeParse({
    ...examples.contracts.AvailabilityCheckRequest,
    livePortalChecksEnabled: true
  }).success,
  false,
  "check requests cannot request live portal checks"
);
assert.equal(
  BookingAssistSessionSchema.safeParse({
    ...examples.contracts.BookingAssistSession,
    allowBookingConfirmation: true
  }).success,
  false,
  "booking assist cannot authorize final confirmation"
);
assert.equal(
  BookingAssistSessionSchema.safeParse({
    ...examples.contracts.BookingAssistSession,
    officialUrl: "https://example.com/book"
  }).success,
  false,
  "booking assist URLs must stay on the official AIS origin"
);
assert.equal(
  NotificationEventSchema.safeParse({
    ...examples.contracts.NotificationEvent,
    containsBookingConfirmation: true
  }).success,
  false,
  "notifications cannot contain booking confirmation"
);
assert.equal(
  AuditEventSchema.safeParse({
    ...examples.contracts.AuditEvent,
    containsSensitiveRawData: true
  }).success,
  false,
  "audit events cannot declare raw sensitive data"
);
assert.equal(
  AdapterRunResultSchema.safeParse({
    ...examples.contracts.AdapterRunResult,
    livePortalRequestMade: true
  }).success,
  false,
  "adapter results cannot claim live portal requests"
);
assert.equal(
  SlotCandidateSchema.safeParse({
    ...examples.contracts.SlotCandidate,
    bookingAction: "submit_booking"
  }).success,
  false,
  "slot candidates cannot encode submit actions"
);
assert.equal(
  AvailabilitySnapshotSchema.safeParse({
    ...examples.contracts.AvailabilitySnapshot,
    minNextCheckMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES - 1
  }).success,
  false,
  "snapshots cannot shorten the next check interval"
);

const bannedFieldPattern = /(password|credential|secret|token)/i;
for (const [contractName, fields] of Object.entries(fieldMap)) {
  for (const field of fields) {
    assert.equal(bannedFieldPattern.test(field), false, `${contractName}.${field} should not be a raw secret field`);
  }
}

console.log("Domain contract tests passed.");
