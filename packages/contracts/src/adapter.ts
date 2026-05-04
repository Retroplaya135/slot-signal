import { z } from "zod";

import {
  AdapterRunResultSchema,
  AuditEventSchema,
  AvailabilityCheckRequestSchema,
  AvailabilitySnapshotSchema,
  CheckPolicySchema,
  SlotCandidateSchema,
  type AdapterRunResult,
  type AuditEvent,
  type AvailabilityCheckRequest,
  type AvailabilitySnapshot,
  type CheckPolicy,
  type SourceKind
} from "./domain.js";
import { MIN_SAFE_CHECK_INTERVAL_MINUTES } from "./policy.js";

const AdapterIdSchema = z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);

export const AdapterClassificationSchema = z.enum([
  "success",
  "no_slots",
  "retry",
  "cooldown",
  "auth_required",
  "parser_mismatch",
  "policy_blocked"
]);

export const FixtureAdapterScenarioSchema = z.enum([
  "slots_found",
  "no_slots",
  "http_403",
  "http_429",
  "auth_redirect",
  "parser_mismatch",
  "repeated_empty",
  "empty_response",
  "network_error",
  "policy_blocked"
]);

export const AdapterRunBundleSchema = z
  .object({
    adapterId: AdapterIdSchema,
    classification: AdapterClassificationSchema,
    request: AvailabilityCheckRequestSchema,
    runResult: AdapterRunResultSchema,
    snapshot: AvailabilitySnapshotSchema.nullable(),
    auditEvent: AuditEventSchema
  })
  .strict();

export type AdapterClassification = z.infer<typeof AdapterClassificationSchema>;
export type FixtureAdapterScenario = z.infer<typeof FixtureAdapterScenarioSchema>;
export type AdapterRunBundle = z.infer<typeof AdapterRunBundleSchema>;

export type AdapterRunInput = {
  now?: Date;
  policy: CheckPolicy;
  request: AvailabilityCheckRequest;
  scenario?: FixtureAdapterScenario;
};

export type VisaAvailabilityAdapter = {
  adapterId: string;
  sourceKind: Extract<SourceKind, "fixture" | "public_reference">;
  run(input: AdapterRunInput): AdapterRunBundle | Promise<AdapterRunBundle>;
};

function iso(date: Date) {
  return date.toISOString();
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function safeSuffix(value: string) {
  return value.replace(/[^A-Za-z0-9._:-]+/g, ":").slice(0, 64);
}

function cooldownMinutesForScenario(scenario: FixtureAdapterScenario, policy: CheckPolicy) {
  if (scenario === "http_429") return Math.max(60, policy.minCheckIntervalMinutes);
  if (scenario === "http_403" || scenario === "auth_redirect" || scenario === "parser_mismatch") {
    return Math.max(30, policy.minCheckIntervalMinutes);
  }
  return policy.minCheckIntervalMinutes;
}

export function classifyAdapterRunResult(result: AdapterRunResult): AdapterClassification {
  const parsed = AdapterRunResultSchema.parse(result);
  if (parsed.resultReason === "policy_blocked") return "policy_blocked";
  if (parsed.resultReason === "auth_redirect" || parsed.resultReason === "permission_missing") return "auth_required";
  if (parsed.resultReason === "parser_mismatch") return "parser_mismatch";
  if (parsed.status === "cooldown") return "cooldown";
  if (parsed.resultReason === "network_error" && parsed.retryable) return "retry";
  if (parsed.status === "no_slots" || parsed.resultReason === "no_slots") return "no_slots";
  if (parsed.status === "succeeded" && (parsed.resultReason === "slots_found" || parsed.resultReason === "fixture_data")) {
    return "success";
  }
  return parsed.retryable ? "retry" : "policy_blocked";
}

function buildCandidate({
  capturedAt,
  request,
  snapshotId
}: {
  capturedAt: Date;
  request: AvailabilityCheckRequest;
  snapshotId: string;
}) {
  return SlotCandidateSchema.parse({
    appointmentDate: "2026-06-15",
    appointmentTime: "09:30",
    appointmentType: "consular",
    bookingAction: "open_official_page_only",
    candidateId: `candidate:source_adapter:${safeSuffix(request.requestId)}:001`,
    confidence: "high",
    consulateId: request.requestedConsulateIds[0],
    consulateName: "Fixture Consulate",
    detectedAt: iso(capturedAt),
    piiIncluded: false,
    portalTarget: request.portalTarget,
    rank: 1,
    snapshotId,
    sourceKind: request.sourceKind
  });
}

function buildSnapshot({
  capturedAt,
  policy,
  request,
  scenario
}: {
  capturedAt: Date;
  policy: CheckPolicy;
  request: AvailabilityCheckRequest;
  scenario: Extract<FixtureAdapterScenario, "slots_found" | "no_slots">;
}) {
  const snapshotId = `snapshot:source_adapter:${safeSuffix(request.requestId)}:${scenario}`;
  const candidates = scenario === "slots_found" ? [buildCandidate({ capturedAt, request, snapshotId })] : [];

  return AvailabilitySnapshotSchema.parse({
    auditEventId: `audit:source_adapter:${safeSuffix(request.requestId)}:${scenario}`,
    candidates,
    capturedAt: iso(capturedAt),
    livePortalRequestMade: false,
    minNextCheckMinutes: policy.minCheckIntervalMinutes,
    nextAllowedCheckAt: iso(addMinutes(capturedAt, policy.minCheckIntervalMinutes)),
    portalTarget: request.portalTarget,
    requestId: request.requestId,
    resultReason: scenario,
    snapshotId,
    sourceKind: request.sourceKind,
    status: scenario
  });
}

function buildRunResult({
  finishedAt,
  policy,
  request,
  scenario,
  snapshot
}: {
  finishedAt: Date;
  policy: CheckPolicy;
  request: AvailabilityCheckRequest;
  scenario: FixtureAdapterScenario;
  snapshot: AvailabilitySnapshot | null;
}) {
  const cooldownMinutes = scenario === "policy_blocked" ? null : cooldownMinutesForScenario(scenario, policy);
  const nextAllowedCheckAt = cooldownMinutes ? iso(addMinutes(finishedAt, cooldownMinutes)) : null;
  const statusByScenario: Record<FixtureAdapterScenario, AdapterRunResult["status"]> = {
    auth_redirect: "failed",
    empty_response: "cooldown",
    http_403: "cooldown",
    http_429: "cooldown",
    network_error: "failed",
    no_slots: "no_slots",
    parser_mismatch: "failed",
    policy_blocked: "failed",
    repeated_empty: "cooldown",
    slots_found: "succeeded"
  };
  const httpStatusByScenario: Partial<Record<FixtureAdapterScenario, AdapterRunResult["httpStatus"]>> = {
    http_403: 403,
    http_429: 429
  };
  const retryable = scenario === "http_429" || scenario === "network_error" || scenario === "repeated_empty" || scenario === "empty_response";

  return AdapterRunResultSchema.parse({
    cooldownMinutes,
    finishedAt: iso(finishedAt),
    httpStatus: httpStatusByScenario[scenario] ?? null,
    livePortalRequestMade: false,
    nextAllowedCheckAt: snapshot?.nextAllowedCheckAt ?? nextAllowedCheckAt,
    requestId: request.requestId,
    resultReason: scenario,
    retryable,
    runId: `run:source_adapter:${safeSuffix(request.requestId)}:${scenario}`,
    snapshotId: snapshot?.snapshotId ?? null,
    sourceKind: request.sourceKind,
    startedAt: iso(new Date(finishedAt.getTime() - 1000)),
    status: statusByScenario[scenario],
    traceId: request.traceId
  });
}

function buildAuditEvent({
  adapterId,
  finishedAt,
  request,
  runResult
}: {
  adapterId: string;
  finishedAt: Date;
  request: AvailabilityCheckRequest;
  runResult: AdapterRunResult;
}) {
  const classification = classifyAdapterRunResult(runResult);
  const resultByClassification: Record<AdapterClassification, AuditEvent["result"]> = {
    auth_required: "failed",
    cooldown: "cooldown",
    no_slots: "succeeded",
    parser_mismatch: "failed",
    policy_blocked: "rejected",
    retry: "failed",
    success: "succeeded"
  };
  const actionByClassification: Record<AdapterClassification, AuditEvent["action"]> = {
    auth_required: "policy_rejected",
    cooldown: "cooldown_started",
    no_slots: "snapshot_recorded",
    parser_mismatch: "policy_rejected",
    policy_blocked: "policy_rejected",
    retry: "policy_rejected",
    success: "snapshot_recorded"
  };

  return AuditEventSchema.parse({
    action: actionByClassification[classification],
    actorType: "adapter",
    auditId: `audit:source_adapter:${safeSuffix(request.requestId)}:${safeSuffix(runResult.resultReason)}`,
    containsSensitiveRawData: false,
    idempotencyKey: request.idempotencyKey,
    occurredAt: iso(finishedAt),
    reason: runResult.resultReason,
    redactionLevel: "no_secrets",
    result: resultByClassification[classification],
    safeSummary: `${adapterId} classified fixture-safe result as ${classification}.`,
    source: request.sourceKind === "fixture" ? "fixture_adapter" : "api",
    traceId: request.traceId
  });
}

function policyBlockedBundle({
  adapterId,
  now,
  request
}: {
  adapterId: string;
  now: Date;
  request: AvailabilityCheckRequest;
}) {
  const runResult = AdapterRunResultSchema.parse({
    cooldownMinutes: null,
    finishedAt: iso(now),
    httpStatus: null,
    livePortalRequestMade: false,
    nextAllowedCheckAt: null,
    requestId: request.requestId,
    resultReason: "policy_blocked",
    retryable: false,
    runId: `run:source_adapter:${safeSuffix(request.requestId)}:policy_blocked`,
    snapshotId: null,
    sourceKind: request.sourceKind,
    startedAt: iso(new Date(now.getTime() - 1000)),
    status: "failed",
    traceId: request.traceId
  });

  return AdapterRunBundleSchema.parse({
    adapterId,
    auditEvent: buildAuditEvent({ adapterId, finishedAt: now, request, runResult }),
    classification: classifyAdapterRunResult(runResult),
    request,
    runResult,
    snapshot: null
  });
}

export class FixtureVisaAvailabilityAdapter implements VisaAvailabilityAdapter {
  adapterId = "adapter:fixture:visa-availability";
  sourceKind = "fixture" as const;

  run(input: AdapterRunInput): AdapterRunBundle {
    const policy = CheckPolicySchema.parse(input.policy);
    const request = AvailabilityCheckRequestSchema.parse(input.request);
    const now = input.now ?? new Date();
    const scenario = FixtureAdapterScenarioSchema.parse(input.scenario ?? "slots_found");

    if (policy.livePortalChecksEnabled || request.livePortalChecksEnabled || request.sourceKind !== "fixture") {
      return policyBlockedBundle({ adapterId: this.adapterId, now, request });
    }

    if (scenario === "policy_blocked") {
      return policyBlockedBundle({ adapterId: this.adapterId, now, request });
    }

    const snapshot =
      scenario === "slots_found" || scenario === "no_slots"
        ? buildSnapshot({ capturedAt: now, policy, request, scenario })
        : null;
    const runResult = buildRunResult({ finishedAt: now, policy, request, scenario, snapshot });

    return AdapterRunBundleSchema.parse({
      adapterId: this.adapterId,
      auditEvent: buildAuditEvent({ adapterId: this.adapterId, finishedAt: now, request, runResult }),
      classification: classifyAdapterRunResult(runResult),
      request,
      runResult,
      snapshot
    });
  }
}

export class PublicReferenceAvailabilityAdapter implements VisaAvailabilityAdapter {
  adapterId = "adapter:public-reference:placeholder";
  sourceKind = "public_reference" as const;

  run(input: AdapterRunInput): AdapterRunBundle {
    const request = AvailabilityCheckRequestSchema.parse(input.request);
    const now = input.now ?? new Date();
    return policyBlockedBundle({ adapterId: this.adapterId, now, request });
  }
}
