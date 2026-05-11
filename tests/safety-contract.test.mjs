import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const domain = readFileSync(new URL("../packages/contracts/src/domain.ts", import.meta.url), "utf8");
const policy = readFileSync(new URL("../packages/contracts/src/policy.ts", import.meta.url), "utf8");
const fieldMap = JSON.parse(
  readFileSync(new URL("../packages/contracts/src/domain-field-map.json", import.meta.url), "utf8")
);

assert.match(domain, /livePortalChecksEnabled:\s*z\.literal\(false\)/);
assert.match(domain, /allowAutomatedBooking:\s*z\.literal\(false\)/);
assert.match(domain, /allowBookingConfirmation:\s*z\.literal\(false\)/);
assert.match(domain, /autoSubmitAllowed:\s*z\.literal\(false\)/);
assert.match(domain, /bookingAction:\s*z\.literal\("open_official_page_only"\)/);
assert.match(domain, /piiStorage:\s*z\.literal\("none"\)/);
assert.match(policy, /MIN_SAFE_CHECK_INTERVAL_MINUTES\s*=\s*15/);

const forbiddenField = /(password|credential|secret|token)/i;
for (const [contractName, fields] of Object.entries(fieldMap)) {
  assert.ok(Array.isArray(fields), `${contractName} must map to an array`);
  for (const field of fields) {
    assert.equal(forbiddenField.test(field), false, `${contractName}.${field} exposes a secret field`);
  }
}

console.log("Slot Signal safety contract checks passed.");
