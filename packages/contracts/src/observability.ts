import { z } from "zod";

import { MIN_SAFE_CHECK_INTERVAL_MINUTES, QUEUE_RETENTION_LIMIT } from "./policy.js";

export const OBSERVABILITY_SCHEMA_VERSION = "observability.observability.v1" as const;
export const DEBUG_EXPORT_SCHEMA_VERSION = "observability.debug_export.v1" as const;

const ContractIdSchema = z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const IsoDateTimeSchema = z.string().datetime();
const SafeTextSchema = z.string().min(1).max(360);

export const ObservabilityComponentSchema = z.enum([
  "api",
  "content_script",
  "contracts",
  "extension",
  "notification",
  "options",
  "popup",
  "proof_harness",
  "queue",
  "service_worker",
  "sidepanel"
]);

export const ObservabilityEventNameSchema = z.enum([
  "debug.export.generated",
  "extension.ready",
  "message.rejected",
  "message.responded",
  "notification.delivery.requested",
  "notification.delivery.sent",
  "notification.delivery.suppressed",
  "permission.state.read",
  "queue.integrity.checked",
  "queue.state.derived",
  "runtime.error",
  "service_worker.started"
]);

export const ObservabilitySeveritySchema = z.enum(["debug", "info", "warn", "error"]);

const MetadataValueSchema = z.union([z.string().min(0).max(240), z.number(), z.boolean(), z.null()]);

export const ObservabilityMetadataSchema = z
  .object({
    cooldownActive: z.boolean().optional(),
    permissionState: z.enum(["granted", "missing", "unknown"]).optional(),
    queueDepth: z.number().int().min(0).max(1000).optional(),
    restartRecovery: z.enum(["indexeddb_loaded", "empty_initialized", "memory_fallback"]).optional(),
    spamGuardStatus: z.enum(["ready", "guarded", "suppressed", "unknown"]).optional()
  })
  .catchall(MetadataValueSchema);

export const StructuredObservabilityEventSchema = z
  .object({
    component: ObservabilityComponentSchema,
    containsSensitiveRawData: z.literal(false),
    eventId: ContractIdSchema,
    eventName: ObservabilityEventNameSchema,
    idempotencyKey: ContractIdSchema.nullable(),
    logFormat: z.literal("json"),
    metadata: ObservabilityMetadataSchema,
    occurredAt: IsoDateTimeSchema,
    reason: z.string().min(1).max(160).nullable(),
    redactionLevel: z.literal("no_secrets"),
    result: z.enum(["accepted", "failed", "observed", "rejected", "sent", "succeeded", "suppressed"]),
    safeSummary: SafeTextSchema,
    schemaVersion: z.literal(OBSERVABILITY_SCHEMA_VERSION),
    severity: ObservabilitySeveritySchema,
    traceId: ContractIdSchema
  })
  .strict();

export const RetentionPolicySummarySchema = z
  .object({
    auditEventDisplayLimit: z.number().int().min(1).max(50),
    debugExportIncludesPageDumps: z.literal(false),
    debugExportIncludesPrivateAuthData: z.literal(false),
    localOnlyFixtureMode: z.literal(true),
    localQueueRetentionRecords: z.number().int().min(20).max(QUEUE_RETENTION_LIMIT),
    notificationEventDisplayLimit: z.number().int().min(1).max(20),
    quarantineInvalidRecords: z.literal(true),
    schemaVersion: z.literal(OBSERVABILITY_SCHEMA_VERSION)
  })
  .strict();

export const NotificationSpamGuardStateSchema = z
  .object({
    containsSensitiveRawData: z.literal(false),
    lastNotificationAt: IsoDateTimeSchema.nullable(),
    minimumIntervalMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
    nextAllowedNotificationAt: IsoDateTimeSchema.nullable(),
    reason: z.enum([
      "delivery_suppressed",
      "no_prior_notification",
      "outside_minimum_interval",
      "unknown",
      "within_minimum_interval"
    ]),
    schemaVersion: z.literal(OBSERVABILITY_SCHEMA_VERSION),
    status: z.enum(["guarded", "ready", "suppressed", "unknown"]),
    suppressedCount: z.number().int().min(0).max(1000)
  })
  .strict();

export const ObservabilitySummarySchema = z
  .object({
    components: z.array(ObservabilityComponentSchema).min(1).max(12),
    containsSensitiveRawData: z.literal(false),
    logFormat: z.literal("json"),
    missingTraceCount: z.number().int().min(0).max(1000),
    schemaVersion: z.literal(OBSERVABILITY_SCHEMA_VERSION),
    structuredEventCount: z.number().int().min(0).max(1000),
    traceCoverage: z.enum(["all_records_with_trace", "empty", "partial"]),
    traceIds: z.array(ContractIdSchema).max(25)
  })
  .strict();

export const DebugExportSafetySummarySchema = z
  .object({
    bannedFieldFindingCount: z.number().int().min(0).max(0),
    containsSensitiveRawData: z.literal(false),
    generatedAt: IsoDateTimeSchema,
    includesPortalPageDump: z.literal(false),
    includesPrivateAuthData: z.literal(false),
    redactionLevel: z.literal("no_secrets"),
    schemaVersion: z.literal(DEBUG_EXPORT_SCHEMA_VERSION),
    userShareable: z.literal(true)
  })
  .strict();

export type DebugExportSafetySummary = z.infer<typeof DebugExportSafetySummarySchema>;
export type NotificationSpamGuardState = z.infer<typeof NotificationSpamGuardStateSchema>;
export type ObservabilitySummary = z.infer<typeof ObservabilitySummarySchema>;
export type RetentionPolicySummary = z.infer<typeof RetentionPolicySummarySchema>;
export type StructuredObservabilityEvent = z.infer<typeof StructuredObservabilityEventSchema>;

function safeSuffix(value: string) {
  return value.replace(/[^A-Za-z0-9._:-]+/g, ":").slice(0, 64);
}

export function createStructuredObservabilityEvent({
  component,
  eventName,
  idempotencyKey = null,
  metadata = {},
  occurredAt = new Date().toISOString(),
  reason = null,
  result,
  safeSummary,
  severity,
  traceId
}: {
  component: z.infer<typeof ObservabilityComponentSchema>;
  eventName: z.infer<typeof ObservabilityEventNameSchema>;
  idempotencyKey?: string | null;
  metadata?: z.input<typeof ObservabilityMetadataSchema>;
  occurredAt?: string;
  reason?: string | null;
  result: z.infer<typeof StructuredObservabilityEventSchema>["result"];
  safeSummary: string;
  severity: z.infer<typeof ObservabilitySeveritySchema>;
  traceId: string;
}): StructuredObservabilityEvent {
  return StructuredObservabilityEventSchema.parse({
    component,
    containsSensitiveRawData: false,
    eventId: `obs:${safeSuffix(eventName)}:${safeSuffix(traceId)}`,
    eventName,
    idempotencyKey,
    logFormat: "json",
    metadata,
    occurredAt,
    reason,
    redactionLevel: "no_secrets",
    result,
    safeSummary,
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    severity,
    traceId
  });
}
