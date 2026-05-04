import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  AdapterResultReasonSchema,
  AdapterRunResultSchema,
  AuditEventSchema,
  AvailabilitySnapshotSchema,
  BookingAssistSessionSchema,
  NotificationEventSchema
} from "./domain.js";
import { NotificationDispatchBundleSchema } from "./notification.js";
import {
  DEBUG_EXPORT_SCHEMA_VERSION,
  DebugExportSafetySummarySchema,
  NotificationSpamGuardStateSchema,
  OBSERVABILITY_SCHEMA_VERSION,
  ObservabilitySummarySchema,
  RetentionPolicySummarySchema
} from "./observability.js";
import { MESSAGE_VERSION, MIN_SAFE_CHECK_INTERVAL_MINUTES, QUEUE_RETENTION_LIMIT } from "./policy.js";

export const ExtensionActorSchema = z.enum([
  "popup",
  "sidepanel",
  "options",
  "content_script",
  "service_worker",
  "test_harness"
]);

export const ExtensionMessageTypeSchema = z.enum([
  "extension.ready",
  "extension.status.requested",
  "extension.status.responded",
  "extension.sidepanel.open_requested",
  "extension.sidepanel.open_responded",
  "visa.portal.context_detected",
  "visa.availability.check_requested",
  "visa.availability.cooldown_started",
  "visa.queue.state_requested",
  "visa.queue.state_responded",
  "visa.debug.export_requested",
  "visa.debug.export_responded",
  "visa.notification.test_requested",
  "visa.notification.delivery_responded",
  "error.client_reported"
]);

const EnvelopeIdSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

const TraceIdSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

const IsoDateTimeSchema = z.string().datetime();
const BoundaryTextSchema = z.string().min(20).max(500);
const PortalOriginSchema = z.literal("https://ais.usvisa-info.com");

const ValidationIssueSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(240),
    path: z.string().max(160)
  })
  .strict();

const ErrorCodeSchema = z.enum([
  "malformed_message",
  "message_send_failed",
  "sidepanel_open_failed",
  "unknown_message",
  "queue_read_failed",
  "unsafe_message",
  "unsupported_action",
  "unsupported_sender",
  "validation_failed"
]);

export const ClientErrorPayloadSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(320),
    issues: z.array(ValidationIssueSchema).max(12).optional()
  })
  .strict();

function envelopeSchema<Type extends string, Payload extends ZodTypeAny>(type: Type, payload: Payload) {
  return z
    .object({
      id: EnvelopeIdSchema,
      type: z.literal(type),
      version: z.literal(MESSAGE_VERSION),
      createdAt: IsoDateTimeSchema,
      actor: ExtensionActorSchema,
      payload,
      idempotencyKey: EnvelopeIdSchema,
      traceId: TraceIdSchema
    })
    .strict();
}

export const ExtensionReadyMessageSchema = envelopeSchema(
  "extension.ready",
  z
    .object({
      mode: z.literal("fixture_only"),
      boundary: BoundaryTextSchema,
      livePortalChecksEnabled: z.literal(false),
      minScheduledCheckMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
      supportedPortalOrigins: z.array(PortalOriginSchema).min(1).max(1)
    })
    .strict()
);

export const ExtensionStatusRequestedMessageSchema = envelopeSchema(
  "extension.status.requested",
  z
    .object({
      reason: z
        .enum(["popup_opened", "sidepanel_opened", "options_opened", "manual_refresh", "content_context_detected"])
        .optional()
    })
    .strict()
);

export const ExtensionStatusRespondedMessageSchema = envelopeSchema(
  "extension.status.responded",
  z
    .object({
      mode: z.enum(["ready", "watching", "cooldown", "permission_needed"]),
      boundary: BoundaryTextSchema,
      livePortalChecksEnabled: z.literal(false),
      lastCheck: z.string().min(1).max(80),
      nextCheck: z.string().min(1).max(80),
      minScheduledCheckMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
      runtime: z.enum(["fixture_only", "backend_offline"]),
      permissions: z
        .object({
          aisHostPermissionGranted: z.boolean()
        })
        .strict()
    })
    .strict()
);

export const ExtensionSidePanelOpenRequestedMessageSchema = envelopeSchema(
  "extension.sidepanel.open_requested",
  z
    .object({
      source: z.literal("popup"),
      requestedAt: IsoDateTimeSchema
    })
    .strict()
);

export const ExtensionSidePanelOpenRespondedMessageSchema = envelopeSchema(
  "extension.sidepanel.open_responded",
  z
    .object({
      opened: z.boolean(),
      reason: z.enum(["opened", "api_unavailable", "window_unavailable", "open_failed"]).optional()
    })
    .strict()
);

export const VisaPortalContextDetectedMessageSchema = envelopeSchema(
  "visa.portal.context_detected",
  z
    .object({
      supported: z.boolean(),
      origin: PortalOriginSchema,
      path: z.string().min(1).max(320).regex(/^\//),
      stage: z.literal("scaffold_only")
    })
    .strict()
);

export const VisaAvailabilityCheckRequestedMessageSchema = envelopeSchema(
  "visa.availability.check_requested",
  z
    .object({
      source: z.enum(["popup", "sidepanel"]),
      requestedAt: IsoDateTimeSchema,
      livePortalChecksEnabled: z.literal(false),
      reason: z.enum(["manual_check", "fixture_smoke"]).optional()
    })
    .strict()
);

export const VisaAvailabilityCooldownStartedMessageSchema = envelopeSchema(
  "visa.availability.cooldown_started",
  z
    .object({
      reason: z.enum(["fixture_mode", "rate_limit", "forbidden", "empty_response", "permission_missing"]),
      minimumIntervalMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
      cooldownUntil: IsoDateTimeSchema.optional(),
      detail: z.string().min(1).max(320)
    })
    .strict()
);

export const VisaQueueStateRequestedMessageSchema = envelopeSchema(
  "visa.queue.state_requested",
  z
    .object({
      requestedAt: IsoDateTimeSchema,
      source: z.enum(["sidepanel", "popup", "test_harness"])
    })
    .strict()
);

export const VisaQueueStatePayloadSchema = z
  .object({
    mode: z.literal("fixture_only"),
    generatedAt: IsoDateTimeSchema,
    queueDepth: z.number().int().min(0).max(1000),
    duplicateSuppressedCount: z.number().int().min(0).max(1000),
    backendStatus: z.enum(["offline_fixture", "offline"]),
    permissionState: z.enum(["granted", "missing", "unknown"]),
    restartRecovery: z.enum(["indexeddb_loaded", "empty_initialized", "memory_fallback"]),
    latestRun: AdapterRunResultSchema.nullable(),
    latestSnapshot: AvailabilitySnapshotSchema.nullable(),
    snapshots: z.array(AvailabilitySnapshotSchema).max(20),
    bookingAssistSession: BookingAssistSessionSchema.nullable(),
    notifications: z.array(NotificationEventSchema).max(20),
    auditEvents: z.array(AuditEventSchema).max(50),
    retentionPolicy: RetentionPolicySummarySchema,
    notificationSpamGuard: NotificationSpamGuardStateSchema,
    observability: ObservabilitySummarySchema,
    integrity: z
      .object({
        validRecordCount: z.number().int().min(0).max(QUEUE_RETENTION_LIMIT),
        corruptRecordCount: z.number().int().min(0).max(1000),
        quarantineStoreCount: z.number().int().min(0).max(1000),
        retentionLimit: z.number().int().min(20).max(QUEUE_RETENTION_LIMIT),
        compactedRecordCount: z.number().int().min(0).max(1000)
      })
      .strict()
      .optional(),
    cooldown: z
      .object({
        active: z.boolean(),
        reason: AdapterResultReasonSchema.nullable(),
        cooldownUntil: IsoDateTimeSchema.nullable(),
        minimumIntervalMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES)
      })
      .strict()
  })
  .strict();

export const VisaQueueStateRespondedMessageSchema = envelopeSchema("visa.queue.state_responded", VisaQueueStatePayloadSchema);

export const VisaDebugExportRequestedMessageSchema = envelopeSchema(
  "visa.debug.export_requested",
  z
    .object({
      requestedAt: IsoDateTimeSchema,
      source: z.enum(["options", "sidepanel", "test_harness"])
    })
    .strict()
);

export const VisaDebugExportPayloadSchema = z
  .object({
    schemaVersion: z.literal(DEBUG_EXPORT_SCHEMA_VERSION),
    exportedAt: IsoDateTimeSchema,
    generatedBy: z.literal("service_worker"),
    redactionLevel: z.literal("no_secrets"),
    containsSensitiveRawData: z.literal(false),
    queueState: VisaQueueStatePayloadSchema,
    retentionPolicy: RetentionPolicySummarySchema,
    notificationSpamGuard: NotificationSpamGuardStateSchema,
    observability: ObservabilitySummarySchema,
    debugSafety: DebugExportSafetySummarySchema,
    bannedFieldScan: z
      .object({
        checkedFieldPatterns: z.array(z.enum(["password", "credential", "secret", "token", "cookie", "rawPortalPayload"])).min(1).max(6),
        findings: z.array(z.string().min(1).max(160)).max(0)
      })
      .strict()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.retentionPolicy.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
      context.addIssue({
        code: "custom",
        message: "Debug export retention policy must use the active observability schema.",
        path: ["retentionPolicy", "schemaVersion"]
      });
    }
    if (payload.debugSafety.bannedFieldFindingCount !== payload.bannedFieldScan.findings.length) {
      context.addIssue({
        code: "custom",
        message: "Debug export safety summary must match banned field scan.",
        path: ["debugSafety", "bannedFieldFindingCount"]
      });
    }
  });

export const VisaDebugExportRespondedMessageSchema = envelopeSchema("visa.debug.export_responded", VisaDebugExportPayloadSchema);

export const VisaNotificationTestRequestedMessageSchema = envelopeSchema(
  "visa.notification.test_requested",
  z
    .object({
      requestedAt: IsoDateTimeSchema,
      source: z.enum(["options", "sidepanel", "test_harness"])
    })
    .strict()
);

export const VisaNotificationDeliveryRespondedMessageSchema = envelopeSchema(
  "visa.notification.delivery_responded",
  NotificationDispatchBundleSchema
);

export const ClientErrorMessageSchema = envelopeSchema("error.client_reported", ClientErrorPayloadSchema);

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  ExtensionReadyMessageSchema,
  ExtensionStatusRequestedMessageSchema,
  ExtensionStatusRespondedMessageSchema,
  ExtensionSidePanelOpenRequestedMessageSchema,
  ExtensionSidePanelOpenRespondedMessageSchema,
  VisaPortalContextDetectedMessageSchema,
  VisaAvailabilityCheckRequestedMessageSchema,
  VisaAvailabilityCooldownStartedMessageSchema,
  VisaQueueStateRequestedMessageSchema,
  VisaQueueStateRespondedMessageSchema,
  VisaDebugExportRequestedMessageSchema,
  VisaDebugExportRespondedMessageSchema,
  VisaNotificationTestRequestedMessageSchema,
  VisaNotificationDeliveryRespondedMessageSchema,
  ClientErrorMessageSchema
]);

export type ExtensionActor = z.infer<typeof ExtensionActorSchema>;
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type ExtensionMessageType = ExtensionMessage["type"];
export type ClientErrorPayload = z.infer<typeof ClientErrorPayloadSchema>;
export type VisaDebugExportPayload = z.infer<typeof VisaDebugExportPayloadSchema>;
export type VisaQueueStatePayload = z.infer<typeof VisaQueueStatePayloadSchema>;
export type ExtensionMessageByType<Type extends ExtensionMessageType> = Extract<ExtensionMessage, { type: Type }>;

export type CreateEnvelopeInput<Type extends ExtensionMessageType> = {
  type: Type;
  actor: ExtensionActor;
  payload: ExtensionMessageByType<Type>["payload"];
  createdAt?: string;
  id?: string;
  idempotencyKey?: string;
  traceId?: string;
};

export type ParseExtensionMessageResult =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; error: ExtensionMessageByType<"error.client_reported"> };

function createId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}:${uuid}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 14)}`;
}

function validationIssues(error: z.ZodError): ClientErrorPayload["issues"] {
  return error.issues.slice(0, 12).map((issue) => {
    return {
      code: issue.code,
      message: issue.message.slice(0, 240),
      path: issue.path.join(".")
    };
  });
}

export function createEnvelope<Type extends ExtensionMessageType>(
  input: CreateEnvelopeInput<Type>
): ExtensionMessageByType<Type> {
  const envelope = {
    id: input.id ?? createId("msg"),
    type: input.type,
    version: MESSAGE_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    actor: input.actor,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? createId("idem"),
    traceId: input.traceId ?? createId("trace")
  };

  const result = ExtensionMessageSchema.safeParse(envelope);
  if (!result.success) {
    throw new Error(`Invalid extension message envelope: ${JSON.stringify(validationIssues(result.error))}`);
  }

  return result.data as ExtensionMessageByType<Type>;
}

export function createClientErrorEnvelope({
  actor,
  code,
  idempotencyKey,
  issues,
  message,
  traceId
}: {
  actor: ExtensionActor;
  code: ClientErrorPayload["code"];
  idempotencyKey?: string;
  issues?: ClientErrorPayload["issues"];
  message: string;
  traceId?: string;
}) {
  return createEnvelope({
    actor,
    idempotencyKey,
    payload: {
      code,
      issues,
      message
    },
    traceId,
    type: "error.client_reported"
  });
}

export function parseExtensionMessage(input: unknown): ParseExtensionMessageResult {
  const result = ExtensionMessageSchema.safeParse(input);
  if (result.success) {
    return { ok: true, message: result.data };
  }

  return {
    ok: false,
    error: createClientErrorEnvelope({
      actor: "service_worker",
      code: "validation_failed",
      issues: validationIssues(result.error),
      message: "Message failed runtime schema validation."
    })
  };
}

export function isExtensionMessage(input: unknown): input is ExtensionMessage {
  return ExtensionMessageSchema.safeParse(input).success;
}
