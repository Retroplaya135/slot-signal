import { z } from "zod";

import {
  AdapterRunResultSchema,
  AuditEventSchema,
  AvailabilityCheckRequestSchema,
  AvailabilitySnapshotSchema,
  BookingAssistSessionSchema,
  CheckPolicySchema,
  NotificationEventSchema,
  type AdapterRunResult,
  type AuditEvent,
  type AvailabilityCheckRequest,
  type AvailabilitySnapshot,
  type BookingAssistSession,
  type NotificationEvent
} from "./domain.js";
import { NotificationDeliveryResultSchema } from "./notification.js";
import {
  FixtureAdapterScenarioSchema,
  FixtureVisaAvailabilityAdapter,
  type FixtureAdapterScenario
} from "./adapter.js";
import {
  NotificationSpamGuardStateSchema,
  OBSERVABILITY_SCHEMA_VERSION,
  ObservabilitySummarySchema,
  RetentionPolicySummarySchema,
  type NotificationSpamGuardState,
  type ObservabilitySummary,
  type RetentionPolicySummary
} from "./observability.js";
import { MIN_SAFE_CHECK_INTERVAL_MINUTES, QUEUE_RETENTION_LIMIT } from "./policy.js";
import { VisaQueueStatePayloadSchema, type VisaQueueStatePayload } from "./messages.js";

const QueueRecordBaseSchema = z
  .object({
    key: z.string().min(8).max(240).regex(/^[A-Za-z0-9._:-]+$/),
    createdAt: z.string().datetime(),
    idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
    traceId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
  })
  .strict();

export const QueueRecordSchema = z.discriminatedUnion("kind", [
  QueueRecordBaseSchema.extend({
    kind: z.literal("check_request"),
    payload: AvailabilityCheckRequestSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("adapter_run"),
    payload: AdapterRunResultSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("snapshot"),
    payload: AvailabilitySnapshotSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("booking_assist_session"),
    payload: BookingAssistSessionSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("notification"),
    payload: NotificationEventSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("notification_delivery"),
    payload: NotificationDeliveryResultSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("audit"),
    payload: AuditEventSchema
  }),
  QueueRecordBaseSchema.extend({
    kind: z.literal("duplicate_suppressed"),
    payload: z
      .object({
        duplicateKey: z.string().min(8).max(240),
        reason: z.enum(["snapshot_idempotency", "record_key_idempotency"]),
        suppressedAt: z.string().datetime()
      })
      .strict()
  })
]);

export type QueueRecord = z.infer<typeof QueueRecordSchema>;

export const QuarantinedQueueRecordSchema = z
  .object({
    key: z.string().min(8).max(240).regex(/^[A-Za-z0-9._:-]+$/),
    quarantinedAt: z.string().datetime(),
    reason: z.string().min(1).max(240)
  })
  .strict();

export const QueueIntegritySummarySchema = z
  .object({
    validRecordCount: z.number().int().min(0).max(QUEUE_RETENTION_LIMIT),
    corruptRecordCount: z.number().int().min(0).max(1000),
    quarantineStoreCount: z.number().int().min(0).max(1000),
    retentionLimit: z.number().int().min(20).max(QUEUE_RETENTION_LIMIT),
    compactedRecordCount: z.number().int().min(0).max(1000)
  })
  .strict();

export type QuarantinedQueueRecord = z.infer<typeof QuarantinedQueueRecordSchema>;
export type QueueIntegritySummary = z.infer<typeof QueueIntegritySummarySchema>;

type FixtureInput = {
  idempotencyKey: string;
  now?: Date;
  requestId?: string;
  traceId: string;
};

function iso(date: Date) {
  return date.toISOString();
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function deriveRetentionPolicySummary(integrity?: QueueIntegritySummary): RetentionPolicySummary {
  return RetentionPolicySummarySchema.parse({
    auditEventDisplayLimit: 50,
    debugExportIncludesPageDumps: false,
    debugExportIncludesPrivateAuthData: false,
    localOnlyFixtureMode: true,
    localQueueRetentionRecords: integrity?.retentionLimit ?? QUEUE_RETENTION_LIMIT,
    notificationEventDisplayLimit: 20,
    quarantineInvalidRecords: true,
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION
  });
}

function deriveNotificationSpamGuard({
  deliverySuppressedCount,
  generatedAt,
  notifications
}: {
  deliverySuppressedCount: number;
  generatedAt: string;
  notifications: NotificationEvent[];
}): NotificationSpamGuardState {
  const latestNotification = notifications[0] ?? null;
  if (!latestNotification) {
    return NotificationSpamGuardStateSchema.parse({
      containsSensitiveRawData: false,
      lastNotificationAt: null,
      minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
      nextAllowedNotificationAt: null,
      reason: "no_prior_notification",
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      status: "ready",
      suppressedCount: deliverySuppressedCount
    });
  }

  const nextAllowedNotificationAt = iso(addMinutes(new Date(latestNotification.createdAt), MIN_SAFE_CHECK_INTERVAL_MINUTES));
  const withinMinimumInterval = new Date(nextAllowedNotificationAt).getTime() > new Date(generatedAt).getTime();

  return NotificationSpamGuardStateSchema.parse({
    containsSensitiveRawData: false,
    lastNotificationAt: latestNotification.createdAt,
    minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
    nextAllowedNotificationAt,
    reason: deliverySuppressedCount > 0 ? "delivery_suppressed" : withinMinimumInterval ? "within_minimum_interval" : "outside_minimum_interval",
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    status: deliverySuppressedCount > 0 ? "suppressed" : withinMinimumInterval ? "guarded" : "ready",
    suppressedCount: deliverySuppressedCount
  });
}

function deriveObservabilitySummary(records: QueueRecord[]): ObservabilitySummary {
  const traceIds = [...new Set(records.map((record) => record.traceId).filter(Boolean))].slice(0, 25);
  const components = new Set<"notification" | "queue" | "service_worker">(["queue", "service_worker"]);
  if (records.some((record) => record.kind === "notification" || record.kind === "notification_delivery")) {
    components.add("notification");
  }

  return ObservabilitySummarySchema.parse({
    components: [...components],
    containsSensitiveRawData: false,
    logFormat: "json",
    missingTraceCount: records.filter((record) => !record.traceId).length,
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    structuredEventCount: records.length,
    traceCoverage: records.length === 0 ? "empty" : traceIds.length === records.length || records.every((record) => traceIds.includes(record.traceId)) ? "all_records_with_trace" : "partial",
    traceIds
  });
}

function corruptRecordKey(input: unknown, index: number) {
  if (input && typeof input === "object" && "key" in input && typeof input.key === "string") {
    const sanitized = input.key.replace(/[^A-Za-z0-9._:-]+/g, ":").slice(0, 200);
    if (sanitized.length >= 8) return sanitized;
  }

  return `corrupt:queue-record:${index}`;
}

function validationReason(error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) return "Queue record failed validation.";
  return `${issue.path.join(".") || "record"}: ${issue.message}`.slice(0, 240);
}

export function compactQueueRecords(
  records: QueueRecord[],
  retentionLimit: number = QUEUE_RETENTION_LIMIT
): { compactedRecordCount: number; records: QueueRecord[] } {
  const parsedRecords = records.map((record) => QueueRecordSchema.parse(record));
  if (parsedRecords.length <= retentionLimit) {
    return {
      compactedRecordCount: 0,
      records: parsedRecords
    };
  }

  const sortedRecords = [...parsedRecords].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const compactedRecordCount = sortedRecords.length - retentionLimit;
  return {
    compactedRecordCount,
    records: sortedRecords.slice(compactedRecordCount)
  };
}

export function parseQueueRecordsForIntegrity({
  existingQuarantineCount = 0,
  now = new Date(),
  rawRecords,
  retentionLimit = QUEUE_RETENTION_LIMIT
}: {
  existingQuarantineCount?: number;
  now?: Date;
  rawRecords: unknown[];
  retentionLimit?: number;
}): {
  corruptRecords: QuarantinedQueueRecord[];
  integrity: QueueIntegritySummary;
  records: QueueRecord[];
} {
  const validRecords: QueueRecord[] = [];
  const corruptRecords: QuarantinedQueueRecord[] = [];

  rawRecords.forEach((record, index) => {
    const result = QueueRecordSchema.safeParse(record);
    if (result.success) {
      validRecords.push(result.data);
      return;
    }

    corruptRecords.push(
      QuarantinedQueueRecordSchema.parse({
        key: corruptRecordKey(record, index),
        quarantinedAt: iso(now),
        reason: validationReason(result.error)
      })
    );
  });

  const compacted = compactQueueRecords(validRecords, retentionLimit);
  const integrity = QueueIntegritySummarySchema.parse({
    validRecordCount: compacted.records.length,
    corruptRecordCount: corruptRecords.length,
    quarantineStoreCount: existingQuarantineCount + corruptRecords.length,
    retentionLimit,
    compactedRecordCount: compacted.compactedRecordCount
  });

  return {
    corruptRecords,
    integrity,
    records: compacted.records
  };
}

export function createQueueFixtureBundle(input: FixtureInput): { records: QueueRecord[] } {
  const now = input.now ?? new Date();
  const requestId = input.requestId ?? `request:queue_fixture:${input.idempotencyKey.replace(/[^A-Za-z0-9]+/g, ":").slice(0, 48)}`;
  const snapshotId = "snapshot:queue_fixture:fixture:toronto";
  const candidateId = "candidate:queue_fixture:fixture:toronto:001";
  const runId = `run:queue_fixture:${input.idempotencyKey.replace(/[^A-Za-z0-9]+/g, ":").slice(0, 48)}`;
  const sessionId = "session:queue_fixture:fixture:toronto";
  const notificationId = "notification:queue_fixture:fixture:toronto";
  const auditId = "audit:queue_fixture:fixture:toronto";
  const capturedAt = addMinutes(now, 1);
  const cooldownUntil = addMinutes(capturedAt, MIN_SAFE_CHECK_INTERVAL_MINUTES);

  const request: AvailabilityCheckRequest = {
    requestId,
    policyId: "policy:contract_fixture:default",
    createdAt: iso(now),
    source: "service_worker",
    portalTarget: "ais_usvisa_info",
    sourceKind: "fixture",
    requestedConsulateIds: ["consulate:toronto"],
    idempotencyKey: input.idempotencyKey,
    traceId: input.traceId,
    livePortalChecksEnabled: false,
    userConsent: "visible_session_only"
  };

  const snapshot: AvailabilitySnapshot = {
    snapshotId,
    requestId,
    capturedAt: iso(capturedAt),
    status: "slots_found",
    portalTarget: "ais_usvisa_info",
    sourceKind: "fixture",
    resultReason: "slots_found",
    candidates: [
      {
        candidateId,
        snapshotId,
        portalTarget: "ais_usvisa_info",
        consulateId: "consulate:toronto",
        consulateName: "Toronto Consulate",
        appointmentDate: "2026-06-15",
        appointmentTime: "09:30",
        appointmentType: "consular",
        sourceKind: "fixture",
        detectedAt: iso(capturedAt),
        confidence: "high",
        rank: 1,
        bookingAction: "open_official_page_only",
        piiIncluded: false
      }
    ],
    nextAllowedCheckAt: iso(cooldownUntil),
    minNextCheckMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
    auditEventId: auditId,
    livePortalRequestMade: false
  };

  const run: AdapterRunResult = {
    runId,
    requestId,
    startedAt: iso(now),
    finishedAt: iso(capturedAt),
    status: "succeeded",
    sourceKind: "fixture",
    resultReason: "slots_found",
    httpStatus: null,
    snapshotId,
    nextAllowedCheckAt: iso(cooldownUntil),
    cooldownMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
    retryable: false,
    traceId: input.traceId,
    livePortalRequestMade: false
  };

  const bookingAssistSession: BookingAssistSession = {
    sessionId,
    candidateId,
    snapshotId,
    createdAt: iso(addMinutes(now, 2)),
    expiresAt: iso(addMinutes(now, 17)),
    status: "prepared",
    officialUrl: "https://ais.usvisa-info.com/en-ca/niv/schedule/fixture/appointment",
    finalConfirmationAuthority: "user_in_browser",
    allowBookingConfirmation: false,
    autoSubmitAllowed: false,
    visibleUserActionRequired: true,
    traceId: input.traceId
  };

  const notification: NotificationEvent = {
    notificationId,
    eventType: "availability_detected",
    channel: "browser",
    createdAt: iso(addMinutes(now, 2)),
    deliveryStatus: "pending",
    relatedSnapshotId: snapshotId,
    relatedSessionId: sessionId,
    messageIntent: "alert_only",
    redactionLevel: "no_secrets",
    containsBookingConfirmation: false,
    traceId: input.traceId
  };

  const audit: AuditEvent = {
    auditId,
    occurredAt: iso(addMinutes(now, 2)),
    actorType: "extension",
    action: "snapshot_recorded",
    source: "service_worker",
    result: "succeeded",
    reason: "slots_found",
    traceId: input.traceId,
    idempotencyKey: input.idempotencyKey,
    redactionLevel: "no_secrets",
    containsSensitiveRawData: false,
    safeSummary: "Fixture snapshot recorded with one visible candidate."
  };

  const records: QueueRecord[] = [
    { key: `request:${request.requestId}`, kind: "check_request", createdAt: request.createdAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: request },
    { key: `run:${run.runId}`, kind: "adapter_run", createdAt: run.startedAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: run },
    { key: `snapshot:${snapshot.snapshotId}`, kind: "snapshot", createdAt: snapshot.capturedAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: snapshot },
    { key: `session:${bookingAssistSession.sessionId}`, kind: "booking_assist_session", createdAt: bookingAssistSession.createdAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: bookingAssistSession },
    { key: `notification:${notification.notificationId}`, kind: "notification", createdAt: notification.createdAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: notification },
    { key: `audit:${audit.auditId}`, kind: "audit", createdAt: audit.occurredAt, idempotencyKey: input.idempotencyKey, traceId: input.traceId, payload: audit }
  ];

  return { records: records.map((record) => QueueRecordSchema.parse(record)) };
}

export function createAdapterFixtureBundle(
  input: FixtureInput & {
    requestedConsulateIds?: string[];
    scenario?: FixtureAdapterScenario;
  }
): { records: QueueRecord[] } {
  const now = input.now ?? new Date();
  const scenario = FixtureAdapterScenarioSchema.parse(input.scenario ?? "slots_found");
  const requestId = input.requestId ?? `request:source_adapter:${input.idempotencyKey.replace(/[^A-Za-z0-9]+/g, ":").slice(0, 48)}`;
  const request: AvailabilityCheckRequest = AvailabilityCheckRequestSchema.parse({
    createdAt: iso(now),
    idempotencyKey: input.idempotencyKey,
    livePortalChecksEnabled: false,
    policyId: "policy:source_adapter:fixture-only",
    portalTarget: "ais_usvisa_info",
    requestId,
    requestedConsulateIds: input.requestedConsulateIds ?? ["consulate:fixture"],
    source: "service_worker",
    sourceKind: "fixture",
    traceId: input.traceId,
    userConsent: "visible_session_only"
  });
  const policy = CheckPolicySchema.parse({
    allowAutomatedBooking: false,
    cooldownOnResults: ["http_403", "http_429", "auth_redirect", "parser_mismatch", "repeated_empty", "empty_response"],
    createdAt: iso(now),
    livePortalChecksEnabled: false,
    maxChecksPerDay: 24,
    minCheckIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
    mode: "fixture_only",
    piiStorage: "none",
    policyId: request.policyId,
    requireVisibleUserConfirmation: true
  });
  const bundle = new FixtureVisaAvailabilityAdapter().run({ now, policy, request, scenario });
  const records: QueueRecord[] = [
    {
      createdAt: request.createdAt,
      idempotencyKey: input.idempotencyKey,
      key: `request:${request.requestId}`,
      kind: "check_request",
      payload: bundle.request,
      traceId: input.traceId
    },
    {
      createdAt: bundle.runResult.startedAt,
      idempotencyKey: input.idempotencyKey,
      key: `run:${bundle.runResult.runId}`,
      kind: "adapter_run",
      payload: bundle.runResult,
      traceId: input.traceId
    },
    ...(bundle.snapshot
      ? [
          {
            createdAt: bundle.snapshot.capturedAt,
            idempotencyKey: input.idempotencyKey,
            key: `snapshot:${bundle.snapshot.snapshotId}`,
            kind: "snapshot" as const,
            payload: bundle.snapshot,
            traceId: input.traceId
          }
        ]
      : []),
    {
      createdAt: bundle.auditEvent.occurredAt,
      idempotencyKey: input.idempotencyKey,
      key: `audit:${bundle.auditEvent.auditId}`,
      kind: "audit",
      payload: bundle.auditEvent,
      traceId: input.traceId
    }
  ];

  return { records: records.map((record) => QueueRecordSchema.parse(record)) };
}

export function createWorkflowFixtureBundle(
  input: FixtureInput & {
    requestedConsulateIds?: string[];
  }
): { records: QueueRecord[] } {
  const now = input.now ?? new Date();
  const requestId = input.requestId ?? `request:fixture_e2e:${input.idempotencyKey.replace(/[^A-Za-z0-9]+/g, ":").slice(0, 48)}`;
  const adapterBundle = createAdapterFixtureBundle({
    idempotencyKey: input.idempotencyKey,
    now,
    requestId,
    requestedConsulateIds: input.requestedConsulateIds,
    scenario: "slots_found",
    traceId: input.traceId
  });
  const snapshotRecord = adapterBundle.records.find(
    (record): record is Extract<QueueRecord, { kind: "snapshot" }> => record.kind === "snapshot"
  );
  const candidate = snapshotRecord?.payload.candidates[0];
  if (!snapshotRecord || !candidate) {
    throw new Error("Fixture workflow bundle requires a fixture candidate.");
  }

  const suffix = input.idempotencyKey.replace(/[^A-Za-z0-9]+/g, ":").slice(0, 48);
  const checkAudit: AuditEvent = AuditEventSchema.parse({
    action: "check_requested",
    actorType: "test_harness",
    auditId: `audit:fixture_e2e:${suffix}:check_requested`,
    containsSensitiveRawData: false,
    idempotencyKey: input.idempotencyKey,
    occurredAt: iso(now),
    reason: "manual_check",
    redactionLevel: "no_secrets",
    result: "accepted",
    safeSummary: "Fixture check accepted in a controlled test environment.",
    source: "test_harness",
    traceId: input.traceId
  });
  const bookingAssistSession: BookingAssistSession = BookingAssistSessionSchema.parse({
    allowBookingConfirmation: false,
    autoSubmitAllowed: false,
    candidateId: candidate.candidateId,
    createdAt: iso(addMinutes(now, 2)),
    expiresAt: iso(addMinutes(now, 17)),
    finalConfirmationAuthority: "user_in_browser",
    officialUrl: "https://ais.usvisa-info.com/en-ca/niv/schedule/fixture/appointment",
    sessionId: `session:fixture_e2e:${suffix}:assist`,
    snapshotId: snapshotRecord.payload.snapshotId,
    status: "prepared",
    traceId: input.traceId,
    visibleUserActionRequired: true
  });
  const assistAudit: AuditEvent = AuditEventSchema.parse({
    action: "booking_assist_opened",
    actorType: "backend",
    auditId: `audit:fixture_e2e:${suffix}:booking_assist_opened`,
    containsSensitiveRawData: false,
    idempotencyKey: input.idempotencyKey,
    occurredAt: iso(addMinutes(now, 3)),
    reason: "slots_found",
    redactionLevel: "no_secrets",
    result: "accepted",
    safeSummary: "Booking-assist session prepared for user review; no appointment-changing action was taken.",
    source: "api",
    traceId: input.traceId
  });
  const records: QueueRecord[] = [
    QueueRecordSchema.parse({
      createdAt: checkAudit.occurredAt,
      idempotencyKey: input.idempotencyKey,
      key: `audit:${checkAudit.auditId}`,
      kind: "audit",
      payload: checkAudit,
      traceId: input.traceId
    }),
    ...adapterBundle.records,
    QueueRecordSchema.parse({
      createdAt: bookingAssistSession.createdAt,
      idempotencyKey: input.idempotencyKey,
      key: `session:${bookingAssistSession.sessionId}`,
      kind: "booking_assist_session",
      payload: bookingAssistSession,
      traceId: input.traceId
    }),
    QueueRecordSchema.parse({
      createdAt: assistAudit.occurredAt,
      idempotencyKey: input.idempotencyKey,
      key: `audit:${assistAudit.auditId}`,
      kind: "audit",
      payload: assistAudit,
      traceId: input.traceId
    })
  ];

  return {
    records: records.map((record) => QueueRecordSchema.parse(record))
  };
}

export function mergeQueueRecords(existing: QueueRecord[], incoming: QueueRecord[], now: Date = new Date()): QueueRecord[] {
  const merged = new Map(existing.map((record) => [record.key, record]));
  const duplicateRecords: QueueRecord[] = [];

  for (const record of incoming) {
    const parsed = QueueRecordSchema.parse(record);
    if (!merged.has(parsed.key)) {
      merged.set(parsed.key, parsed);
      continue;
    }

    const duplicate: QueueRecord = {
      key: `duplicate:${parsed.key}:${now.getTime()}:${duplicateRecords.length}`,
      kind: "duplicate_suppressed",
      createdAt: iso(now),
      idempotencyKey: parsed.idempotencyKey,
      traceId: parsed.traceId,
      payload: {
        duplicateKey: parsed.key,
        reason: parsed.kind === "snapshot" ? "snapshot_idempotency" : "record_key_idempotency",
        suppressedAt: iso(now)
      }
    };
    duplicateRecords.push(QueueRecordSchema.parse(duplicate));
  }

  for (const duplicate of duplicateRecords) {
    merged.set(duplicate.key, duplicate);
  }

  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deriveVisaQueueState({
  generatedAt = new Date().toISOString(),
  integrity,
  permissionState = "unknown",
  records,
  restartRecovery
}: {
  generatedAt?: string;
  integrity?: QueueIntegritySummary;
  permissionState?: VisaQueueStatePayload["permissionState"];
  records: QueueRecord[];
  restartRecovery: VisaQueueStatePayload["restartRecovery"];
}): VisaQueueStatePayload {
  const parsedRecords = records.map((record) => QueueRecordSchema.parse(record));
  const snapshots = parsedRecords
    .filter((record): record is Extract<QueueRecord, { kind: "snapshot" }> => record.kind === "snapshot")
    .map((record) => record.payload)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .slice(0, 20);
  const latestSnapshot = snapshots[0] ?? null;
  const latestRun =
    parsedRecords
      .filter((record): record is Extract<QueueRecord, { kind: "adapter_run" }> => record.kind === "adapter_run")
      .map((record) => record.payload)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  const bookingAssistSession =
    parsedRecords
      .filter((record): record is Extract<QueueRecord, { kind: "booking_assist_session" }> => record.kind === "booking_assist_session")
      .map((record) => record.payload)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const notifications = parsedRecords
    .filter((record): record is Extract<QueueRecord, { kind: "notification" }> => record.kind === "notification")
    .map((record) => record.payload)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);
  const deliverySuppressedCount = parsedRecords.filter(
    (record): record is Extract<QueueRecord, { kind: "notification_delivery" }> =>
      record.kind === "notification_delivery" && record.payload.status === "suppressed"
  ).length;
  const auditEvents = parsedRecords
    .filter((record): record is Extract<QueueRecord, { kind: "audit" }> => record.kind === "audit")
    .map((record) => record.payload)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 50);
  const duplicateSuppressedCount = parsedRecords.filter((record) => record.kind === "duplicate_suppressed").length;
  const cooldownUntil = latestSnapshot?.nextAllowedCheckAt ?? latestRun?.nextAllowedCheckAt ?? null;
  const cooldownActive = Boolean(cooldownUntil && new Date(cooldownUntil).getTime() > new Date(generatedAt).getTime());
  const notificationSpamGuard = deriveNotificationSpamGuard({
    deliverySuppressedCount,
    generatedAt,
    notifications
  });

  return VisaQueueStatePayloadSchema.parse({
    mode: "fixture_only",
    generatedAt,
    queueDepth: parsedRecords.filter((record) => record.kind !== "duplicate_suppressed").length,
    duplicateSuppressedCount,
    backendStatus: "offline_fixture",
    permissionState,
    restartRecovery,
    latestRun,
    latestSnapshot,
    snapshots,
    bookingAssistSession,
    notifications,
    auditEvents,
    retentionPolicy: deriveRetentionPolicySummary(integrity),
    notificationSpamGuard,
    observability: deriveObservabilitySummary(parsedRecords),
    ...(integrity ? { integrity } : {}),
    cooldown: {
      active: cooldownActive,
      cooldownUntil,
      minimumIntervalMinutes: MIN_SAFE_CHECK_INTERVAL_MINUTES,
      reason: latestSnapshot?.resultReason ?? latestRun?.resultReason ?? null
    }
  });
}
