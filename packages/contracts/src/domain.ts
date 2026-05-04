import { z } from "zod";

import { MIN_SAFE_CHECK_INTERVAL_MINUTES } from "./policy.js";

const ContractIdSchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

const TraceIdSchema = ContractIdSchema;
const IsoDateTimeSchema = z.string().datetime();
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ClockTimeSchema = z.string().regex(/^\d{2}:\d{2}$/).nullable();
const SafeTextSchema = z.string().min(1).max(320);

const OfficialAisUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === "https://ais.usvisa-info.com";
  } catch {
    return false;
  }
}, "officialUrl must stay on https://ais.usvisa-info.com");

export const PortalTargetSchema = z.enum(["ais_usvisa_info"]);
export const SourceKindSchema = z.enum(["fixture", "public_reference", "user_visible_portal"]);
export const CheckRequestSourceSchema = z.enum(["popup", "sidepanel", "service_worker", "test_harness"]);
export const AppointmentTypeSchema = z.enum(["consular", "asc", "ofc", "dropbox", "unknown"]);
export const CandidateConfidenceSchema = z.enum(["low", "medium", "high"]);

export const AdapterResultReasonSchema = z.enum([
  "fixture_data",
  "manual_check",
  "slots_found",
  "no_slots",
  "http_403",
  "http_429",
  "auth_redirect",
  "parser_mismatch",
  "repeated_empty",
  "empty_response",
  "permission_missing",
  "network_error",
  "policy_blocked"
]);

export const CheckPolicySchema = z.strictObject({
  policyId: ContractIdSchema,
  mode: z.enum(["fixture_only", "manual_on_demand"]),
  minCheckIntervalMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
  maxChecksPerDay: z.number().int().min(1).max(96),
  cooldownOnResults: z.array(AdapterResultReasonSchema).min(1).max(16),
  livePortalChecksEnabled: z.literal(false),
  allowAutomatedBooking: z.literal(false),
  requireVisibleUserConfirmation: z.literal(true),
  piiStorage: z.literal("none"),
  createdAt: IsoDateTimeSchema
});

export const AvailabilityCheckRequestSchema = z.strictObject({
  requestId: ContractIdSchema,
  policyId: ContractIdSchema,
  createdAt: IsoDateTimeSchema,
  source: CheckRequestSourceSchema,
  portalTarget: PortalTargetSchema,
  sourceKind: z.enum(["fixture", "public_reference"]),
  requestedConsulateIds: z.array(ContractIdSchema).min(1).max(24),
  idempotencyKey: ContractIdSchema,
  traceId: TraceIdSchema,
  livePortalChecksEnabled: z.literal(false),
  userConsent: z.literal("visible_session_only")
});

export const SlotCandidateSchema = z.strictObject({
  candidateId: ContractIdSchema,
  snapshotId: ContractIdSchema,
  portalTarget: PortalTargetSchema,
  consulateId: ContractIdSchema,
  consulateName: SafeTextSchema,
  appointmentDate: IsoDateSchema,
  appointmentTime: ClockTimeSchema,
  appointmentType: AppointmentTypeSchema,
  sourceKind: SourceKindSchema,
  detectedAt: IsoDateTimeSchema,
  confidence: CandidateConfidenceSchema,
  rank: z.number().int().min(1).max(1000),
  bookingAction: z.literal("open_official_page_only"),
  piiIncluded: z.literal(false)
});

export const AvailabilitySnapshotSchema = z.strictObject({
  snapshotId: ContractIdSchema,
  requestId: ContractIdSchema,
  capturedAt: IsoDateTimeSchema,
  status: z.enum(["slots_found", "no_slots", "cooldown", "failed"]),
  portalTarget: PortalTargetSchema,
  sourceKind: SourceKindSchema,
  resultReason: AdapterResultReasonSchema,
  candidates: z.array(SlotCandidateSchema).max(50),
  nextAllowedCheckAt: IsoDateTimeSchema.nullable(),
  minNextCheckMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES),
  auditEventId: ContractIdSchema.nullable(),
  livePortalRequestMade: z.literal(false)
});

export const BookingAssistSessionSchema = z.strictObject({
  sessionId: ContractIdSchema,
  candidateId: ContractIdSchema,
  snapshotId: ContractIdSchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  status: z.enum(["prepared", "official_page_opened", "cancelled", "expired"]),
  officialUrl: OfficialAisUrlSchema,
  finalConfirmationAuthority: z.literal("user_in_browser"),
  allowBookingConfirmation: z.literal(false),
  autoSubmitAllowed: z.literal(false),
  visibleUserActionRequired: z.literal(true),
  traceId: TraceIdSchema
});

export const NotificationEventSchema = z.strictObject({
  notificationId: ContractIdSchema,
  eventType: z.enum(["availability_detected", "cooldown_started", "check_failed", "booking_assist_ready"]),
  channel: z.enum(["browser", "telegram", "email", "slack", "debug"]),
  createdAt: IsoDateTimeSchema,
  deliveryStatus: z.enum(["pending", "sent", "failed", "suppressed"]),
  relatedSnapshotId: ContractIdSchema.nullable(),
  relatedSessionId: ContractIdSchema.nullable(),
  messageIntent: z.enum(["alert_only", "status_only", "assist_ready"]),
  redactionLevel: z.enum(["no_secrets", "pii_redacted"]),
  containsBookingConfirmation: z.literal(false),
  traceId: TraceIdSchema
});

export const AuditEventSchema = z.strictObject({
  auditId: ContractIdSchema,
  occurredAt: IsoDateTimeSchema,
  actorType: z.enum(["user", "extension", "backend", "adapter", "notification", "test_harness"]),
  action: z.enum([
    "check_requested",
    "snapshot_recorded",
    "cooldown_started",
    "notification_queued",
    "booking_assist_opened",
    "policy_rejected"
  ]),
  source: z.enum(["popup", "sidepanel", "service_worker", "api", "fixture_adapter", "test_harness"]),
  result: z.enum(["accepted", "rejected", "succeeded", "failed", "cooldown"]),
  reason: AdapterResultReasonSchema.nullable(),
  traceId: TraceIdSchema,
  idempotencyKey: ContractIdSchema,
  redactionLevel: z.enum(["no_secrets", "pii_redacted"]),
  containsSensitiveRawData: z.literal(false),
  safeSummary: SafeTextSchema.nullable()
});

export const AdapterRunResultSchema = z.strictObject({
  runId: ContractIdSchema,
  requestId: ContractIdSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  status: z.enum(["succeeded", "no_slots", "cooldown", "failed"]),
  sourceKind: SourceKindSchema,
  resultReason: AdapterResultReasonSchema,
  httpStatus: z.union([z.literal(403), z.literal(429), z.literal(500), z.literal(502), z.literal(503)]).nullable(),
  snapshotId: ContractIdSchema.nullable(),
  nextAllowedCheckAt: IsoDateTimeSchema.nullable(),
  cooldownMinutes: z.number().int().min(MIN_SAFE_CHECK_INTERVAL_MINUTES).nullable(),
  retryable: z.boolean(),
  traceId: TraceIdSchema,
  livePortalRequestMade: z.literal(false)
});

export const DomainContractSchemas = {
  AdapterRunResult: AdapterRunResultSchema,
  AuditEvent: AuditEventSchema,
  AvailabilityCheckRequest: AvailabilityCheckRequestSchema,
  AvailabilitySnapshot: AvailabilitySnapshotSchema,
  BookingAssistSession: BookingAssistSessionSchema,
  CheckPolicy: CheckPolicySchema,
  NotificationEvent: NotificationEventSchema,
  SlotCandidate: SlotCandidateSchema
} as const;

export type AdapterRunResult = z.infer<typeof AdapterRunResultSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AvailabilityCheckRequest = z.infer<typeof AvailabilityCheckRequestSchema>;
export type AvailabilitySnapshot = z.infer<typeof AvailabilitySnapshotSchema>;
export type BookingAssistSession = z.infer<typeof BookingAssistSessionSchema>;
export type CheckPolicy = z.infer<typeof CheckPolicySchema>;
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SlotCandidate = z.infer<typeof SlotCandidateSchema>;
