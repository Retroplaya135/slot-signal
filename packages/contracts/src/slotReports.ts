import { z } from "zod";
import { NotificationEventSchema } from "./domain.js";
import { SafeNotificationMessageSchema } from "./notification.js";

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "Must be a valid date in YYYY-MM-DD format");

const IsoDateTimeSchema = z.string().datetime();

const SafeTextSchema = z.string().trim().min(1).max(320);

const SensitiveNotePattern =
  /\b(password|passcode|otp|mfa|2fa|cookie|session|token|bearer|authorization|passport|ds-160|ds160|sevis|csrf|hidden field|raw html|html dump|screenshot)\b/i;
const EmailPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PhonePattern = /(?:\+?\d[\s().-]?){8,}/;

const SafeNotesSchema = z
  .string()
  .trim()
  .max(320)
  .refine((value) => !SensitiveNotePattern.test(value), "Notes must not include sensitive portal data")
  .refine((value) => !EmailPattern.test(value), "Notes must not include personal contact data")
  .refine((value) => !PhonePattern.test(value), "Notes must not include personal contact data");

const SafeModerationNoteSchema = z
  .string()
  .trim()
  .min(4)
  .max(320)
  .refine((value) => !SensitiveNotePattern.test(value), "Moderation notes must not include sensitive portal data")
  .refine((value) => !EmailPattern.test(value), "Moderation notes must not include personal contact data")
  .refine((value) => !PhonePattern.test(value), "Moderation notes must not include personal contact data");

const SlotReportContributionPayloadShape = {
  availableDates: z.array(IsoDateSchema).min(1).max(60),
  bookingActionTaken: z.literal(false),
  capturedAt: IsoDateTimeSchema,
  confidence: z.enum(["user_visible", "community_report"]),
  containsSensitiveRawData: z.literal(false),
  contributorId: z.string().trim().min(8).max(120).optional(),
  country: SafeTextSchema,
  credentialDataIncluded: z.literal(false),
  notes: SafeNotesSchema.optional(),
  portalAutomationUsed: z.literal(false),
  postCity: SafeTextSchema,
  sourceKind: z.enum(["community_report", "manual_report"]),
  visaClass: SafeTextSchema
};

export const SlotReportProvenanceSchema = z.strictObject({
  availabilityClaim: z.literal("community_report_not_official_confirmation"),
  capturedAt: IsoDateTimeSchema,
  confidence: z.enum(["user_visible", "community_report"]),
  contributorId: z.string().trim().min(8).max(120).nullable().optional(),
  country: SafeTextSchema,
  officialAvailabilitySource: z.literal(false),
  postCity: SafeTextSchema,
  sourceKind: z.enum(["community_report", "manual_report"]),
  submittedAt: IsoDateTimeSchema,
  visaClass: SafeTextSchema
});

export const SlotReportTrustSchema = z.strictObject({
  conflictingReportIds: z.array(z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)).max(24),
  dedupeKey: z.string().min(8).max(240).regex(/^[A-Za-z0-9._:-]+$/),
  duplicateOfReportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/).nullable(),
  eligibleForNotification: z.boolean(),
  independentContributorCount: z.number().int().min(0).max(1000).default(0),
  provenance: SlotReportProvenanceSchema,
  qualityScore: z.number().int().min(0).max(100).default(70),
  qualitySignals: z
    .array(
      z.enum([
        "visible_metadata_only",
        "user_visible_confidence",
        "community_report_confidence",
        "registered_local_identity",
        "stable_local_identity",
        "identity_rotation_warning",
        "independent_corroboration",
        "fresh_report",
        "duplicate_same_dates",
        "conflicting_same_scope",
        "local_review_watch",
        "local_review_restricted"
      ])
    )
    .max(16)
    .default([]),
  qualityTier: z.enum(["trusted", "standard", "low", "suppressed"]).default("standard"),
  similarFreshReportCount: z.number().int().min(0).max(1000).default(0),
  status: z.enum(["accepted_unique", "accepted_duplicate", "accepted_conflict", "stale_suppressed"]),
  suppressionReasons: z
    .array(
      z.enum([
        "stale_report",
        "duplicate_report",
        "conflicting_report",
        "restricted_contributor",
        "low_quality_score"
      ])
    )
    .max(16)
    .default([]),
  visibleMetadataOnly: z.literal(true)
});

function validateAvailableDatesAreUniqueAndSorted(
  payload: { availableDates: string[] },
  context: z.RefinementCtx
) {
  const normalized = [...new Set(payload.availableDates)].sort();
  if (normalized.length !== payload.availableDates.length || normalized.some((date, index) => date !== payload.availableDates[index])) {
    context.addIssue({
      code: "custom",
      message: "Available dates must be unique and sorted",
      path: ["availableDates"]
    });
  }
}

export const SlotReportContributionPayloadSchema = z
  .strictObject(SlotReportContributionPayloadShape)
  .superRefine(validateAvailableDatesAreUniqueAndSorted);

export const SlotReportResponseSchema = z.strictObject({
  ...SlotReportContributionPayloadShape,
  availabilityClaim: z.literal("community_report_not_official_confirmation"),
  contributorId: z.string().trim().min(8).max(120).nullable().optional(),
  freshUntil: IsoDateTimeSchema,
  freshness: z.enum(["fresh", "stale"]),
  notes: SafeNotesSchema.nullable().optional(),
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  storedAt: IsoDateTimeSchema,
  trust: SlotReportTrustSchema
}).superRefine(validateAvailableDatesAreUniqueAndSorted);

export const SlotReportLatestRowSchema = SlotReportResponseSchema.safeExtend({
  matchedDates: z.array(IsoDateSchema).min(1).max(60)
});

export const SlotReportLatestResponseSchema = z.strictObject({
  reports: z.array(SlotReportLatestRowSchema).max(100)
});

export const SlotReportAlertSubscriptionPayloadSchema = z
  .strictObject({
    active: z.boolean(),
    channels: z.array(z.enum(["browser", "telegram", "email", "slack"])).min(1).max(4),
    cooldownMinutes: z.number().int().min(15).max(1440).default(15),
    country: SafeTextSchema,
    deliveryMode: z.enum(["immediate", "digest"]).default("immediate"),
    digestWindowMinutes: z.number().int().min(15).max(1440).default(60),
    postCities: z.array(SafeTextSchema).min(1).max(24),
    targetEndDate: IsoDateSchema,
    targetStartDate: IsoDateSchema,
    visaClasses: z.array(SafeTextSchema).min(1).max(24)
  })
  .superRefine((payload, context) => {
    if (payload.targetStartDate > payload.targetEndDate) {
      context.addIssue({
        code: "custom",
        message: "targetStartDate must be on or before targetEndDate",
        path: ["targetStartDate"]
      });
    }
  });

export const SlotReportAlertSubscriptionSchema = SlotReportAlertSubscriptionPayloadSchema.safeExtend({
  createdAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable().optional(),
  lastNotificationAt: IsoDateTimeSchema.nullable().optional(),
  pausedAt: IsoDateTimeSchema.nullable().optional(),
  status: z.enum(["active", "paused", "deleted"]),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  updatedAt: IsoDateTimeSchema.nullable().optional()
});

export const AlertSubscriptionUpdatePayloadSchema = z.strictObject({
  active: z.boolean().optional(),
  auditReason: z.string().trim().max(160).optional(),
  containsSensitiveRawData: z.literal(false),
  cooldownMinutes: z.number().int().min(15).max(1440).optional(),
  deliveryMode: z.enum(["immediate", "digest"]).optional(),
  digestWindowMinutes: z.number().int().min(15).max(1440).optional()
});

export const AlertSubscriptionAuditEventSchema = z.strictObject({
  action: z.enum(["created", "paused", "resumed", "cooldown_updated", "delivery_policy_updated", "deleted"]),
  auditReason: z.string().trim().max(160).nullable().optional(),
  containsSensitiveRawData: z.literal(false),
  recordedAt: IsoDateTimeSchema,
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const AlertSubscriptionListResponseSchema = z.strictObject({
  auditEvents: z.array(AlertSubscriptionAuditEventSchema).max(500),
  subscriptions: z.array(SlotReportAlertSubscriptionSchema).max(500)
});

export const AlertSubscriptionUpdateResponseSchema = z.strictObject({
  auditEvent: AlertSubscriptionAuditEventSchema,
  subscription: SlotReportAlertSubscriptionSchema
});

export const AlertSubscriptionDeleteResponseSchema = z.strictObject({
  auditEvent: AlertSubscriptionAuditEventSchema,
  deleted: z.boolean(),
  removedPendingMatches: z.number().int().min(0),
  subscription: SlotReportAlertSubscriptionSchema
});

export const SlotReportAlertMatchSchema = z.strictObject({
  availabilityClaim: z.literal("community_report_not_official_confirmation"),
  deliveryMode: z.enum(["immediate", "digest"]).default("immediate"),
  digestWindowMinutes: z.number().int().min(15).max(1440).default(60),
  lastDeliveryAttemptAt: IsoDateTimeSchema.nullable().optional(),
  matchedDates: z.array(IsoDateSchema).min(1).max(60),
  nextRetryAt: IsoDateTimeSchema.nullable().optional(),
  notificationEvent: NotificationEventSchema,
  notificationReason: z.literal("fresh_community_report_matches_filter"),
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  reportTrust: SlotReportTrustSchema,
  retryAttemptCount: z.number().int().min(0).default(0),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const SlotReportAlertSubscriptionResponseSchema = z.strictObject({
  initialMatches: z.array(SlotReportAlertMatchSchema).max(100),
  subscription: SlotReportAlertSubscriptionSchema
});

export const AlertNotificationQueueResponseSchema = z.strictObject({
  pendingMatches: z.array(SlotReportAlertMatchSchema).max(100)
});

export const AlertNotificationDigestGroupSchema = z.strictObject({
  deliveryMode: z.literal("digest"),
  digestWindowMinutes: z.number().int().min(15).max(1440),
  latestMatchedAt: IsoDateTimeSchema,
  matches: z.array(SlotReportAlertMatchSchema).max(100),
  pendingCount: z.number().int().min(0),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const AlertNotificationDigestResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  groups: z.array(AlertNotificationDigestGroupSchema).max(100),
  slotAlertsDelivered: z.literal(false)
});

export const AlertPendingCleanupPayloadSchema = z.strictObject({
  checkedAt: IsoDateTimeSchema.optional(),
  cutoffBefore: IsoDateTimeSchema.optional(),
  dryRun: z.boolean()
});

export const AlertPendingCleanupResponseSchema = z.strictObject({
  checkedAt: IsoDateTimeSchema,
  cleanupReason: z.literal("stale_pending_cleanup"),
  containsSensitiveRawData: z.literal(false),
  deletedPendingMatches: z.number().int().min(0),
  dryRun: z.boolean(),
  matchedPendingMatches: z.number().int().min(0)
});

export const AlertDeliveryAckPayloadSchema = z.strictObject({
  acknowledgedAt: IsoDateTimeSchema.optional(),
  containsSensitiveRawData: z.literal(false),
  deliveryAttemptedInBrowser: z.boolean(),
  deliveryStatus: z.enum(["sent", "suppressed", "failed"]),
  reason: z.enum([
    "already_delivered_locally",
    "browser_api_unavailable",
    "browser_create_failed",
    "browser_notification_created",
    "digest_mode_deferred",
    "digest_summary_sent",
    "digest_suppressed_by_user",
    "not_browser_channel",
    "not_eligible"
  ])
});

export const SlotReportAlertDeliveryAuditEventSchema = z.strictObject({
  acknowledgedAt: IsoDateTimeSchema,
  containsSensitiveRawData: z.literal(false),
  deliveryAttemptedInBrowser: z.boolean(),
  deliveryStatus: z.enum(["sent", "suppressed", "failed"]),
  notificationEvent: NotificationEventSchema,
  notificationId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  reason: z.enum([
    "already_delivered_locally",
    "browser_api_unavailable",
    "browser_create_failed",
    "browser_notification_created",
    "digest_mode_deferred",
    "digest_summary_sent",
    "digest_suppressed_by_user",
    "not_browser_channel",
    "not_eligible"
  ]),
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const SlotReportAlertDeliveryAckResponseSchema = z.strictObject({
  deliveryAudit: SlotReportAlertDeliveryAuditEventSchema,
  notificationEvent: NotificationEventSchema,
  replayed: z.boolean()
});

export const AlertDigestDeliveryAckPayloadSchema = z
  .strictObject({
    acknowledgedAt: IsoDateTimeSchema.optional(),
    containsSensitiveRawData: z.literal(false),
    deliveryAttemptedInBrowser: z.literal(false).default(false),
    deliveryStatus: z.enum(["sent", "suppressed"]),
    reason: z.enum(["digest_summary_sent", "digest_suppressed_by_user"])
  })
  .superRefine((payload, context) => {
    if (payload.deliveryStatus === "sent" && payload.reason !== "digest_summary_sent") {
      context.addIssue({
        code: "custom",
        message: "sent digest decisions must use digest_summary_sent",
        path: ["reason"]
      });
    }
    if (payload.deliveryStatus === "suppressed" && payload.reason !== "digest_suppressed_by_user") {
      context.addIssue({
        code: "custom",
        message: "suppressed digest decisions must use digest_suppressed_by_user",
        path: ["reason"]
      });
    }
  });

export const AlertDigestDeliveryAckResponseSchema = z.strictObject({
  acknowledgedAt: IsoDateTimeSchema,
  acknowledgedCount: z.number().int().min(0),
  containsSensitiveRawData: z.literal(false),
  deliveryAudits: z.array(SlotReportAlertDeliveryAuditEventSchema).max(100),
  deliveryStatus: z.enum(["sent", "suppressed"]),
  reason: z.enum(["digest_summary_sent", "digest_suppressed_by_user"]),
  replayedCount: z.number().int().min(0),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const SlotReportAlertDeliveryAuditResponseSchema = z.strictObject({
  auditEvents: z.array(SlotReportAlertDeliveryAuditEventSchema).max(100),
  notificationId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const AlertDeliveryHistoryResponseSchema = z.strictObject({
  auditEvents: z.array(SlotReportAlertDeliveryAuditEventSchema).max(100),
  containsSensitiveRawData: z.literal(false),
  countsByStatus: z.strictObject({
    failed: z.number().int().min(0),
    sent: z.number().int().min(0),
    suppressed: z.number().int().min(0)
  })
});

export const AlertNotificationAdapterSandboxPayloadSchema = z.strictObject({
  actionLabel: z.literal("Open tracker"),
  adapterMode: z.literal("sandbox_only"),
  availabilityClaim: z.literal("community_report_not_official_confirmation"),
  body: SafeTextSchema,
  channel: z.enum(["email", "telegram", "slack"]),
  containsBookingConfirmation: z.literal(false),
  containsSensitiveRawData: z.literal(false),
  country: SafeTextSchema,
  externalNetworkCallAttempted: z.literal(false),
  matchedDates: z.array(IsoDateSchema).min(1).max(60),
  postCity: SafeTextSchema,
  providerEndpoint: z.literal("not_called"),
  recipientRef: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  redactionLevel: z.literal("no_secrets"),
  title: z.literal("Community visa slot report"),
  unsubscribeAction: z.literal("pause_or_delete_filter"),
  visaClass: SafeTextSchema
});

export const AlertNotificationAdapterSandboxDeliverySchema = z.strictObject({
  channel: z.enum(["email", "telegram", "slack"]),
  containsSensitiveRawData: z.literal(false),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  notificationId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  payload: AlertNotificationAdapterSandboxPayloadSchema.nullable(),
  reason: z.enum(["sandbox_payload_recorded", "channel_not_subscribed", "not_eligible"]),
  recordedAt: IsoDateTimeSchema,
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  sandboxDeliveryId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  status: z.enum(["recorded", "skipped", "suppressed"]),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const AlertNotificationAdapterSandboxPayloadRequestSchema = z.strictObject({
  adapterMode: z.literal("sandbox_only"),
  channels: z.array(z.enum(["email", "telegram", "slack"])).min(1).max(3),
  containsSensitiveRawData: z.literal(false),
  includeDigest: z.boolean().default(false),
  notificationIds: z.array(z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)).max(100).optional(),
  recordedAt: IsoDateTimeSchema.optional()
});

export const AlertNotificationAdapterSandboxResponseSchema = z.strictObject({
  adapterMode: z.literal("sandbox_only"),
  containsSensitiveRawData: z.literal(false),
  countsByStatus: z.strictObject({
    recorded: z.number().int().min(0),
    skipped: z.number().int().min(0),
    suppressed: z.number().int().min(0)
  }),
  deliveries: z.array(AlertNotificationAdapterSandboxDeliverySchema).max(200),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  slotAlertsDelivered: z.literal(false)
});

export const AlertNotificationAdapterSandboxHistoryResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  countsByStatus: z.strictObject({
    recorded: z.number().int().min(0),
    skipped: z.number().int().min(0),
    suppressed: z.number().int().min(0)
  }),
  deliveries: z.array(AlertNotificationAdapterSandboxDeliverySchema).max(200),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  slotAlertsDelivered: z.literal(false)
});

export const ProviderDeliveryReadinessResponseSchema = z.strictObject({
  blockedReasons: z
    .array(z.enum(["external_provider_delivery_disabled_by_default", "provider_credentials_not_configured"]))
    .min(1)
    .max(8),
  checkedAt: IsoDateTimeSchema,
  containsSensitiveRawData: z.literal(false),
  credentialStorageMode: z.literal("not_configured"),
  deliveryBoundary: z.literal("browser_digest_primary_provider_outbox_disabled"),
  externalNetworkCallAttempted: z.literal(false),
  externalProviderDeliveryEnabled: z.literal(false),
  liveProviderConfigured: z.literal(false),
  nextRequiredProof: z.literal("delivery_readiness_provider_configuration_not_implemented"),
  providerChannels: z.tuple([z.literal("email"), z.literal("telegram"), z.literal("slack")]),
  providerSafeOutboxEnabled: z.literal(true),
  safeDefaultDeliveryModes: z.tuple([z.literal("browser"), z.literal("digest")])
});

export const AlertNotificationProviderOutboxPayloadRequestSchema = z.strictObject({
  adapterMode: z.literal("provider_safe_outbox"),
  channels: z.array(z.enum(["email", "telegram", "slack"])).min(1).max(3),
  containsSensitiveRawData: z.literal(false),
  externalDeliveryEnabled: z.literal(false),
  includeDigest: z.boolean().default(false),
  notificationIds: z.array(z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)).max(100).optional(),
  recordedAt: IsoDateTimeSchema.optional()
});

export const AlertNotificationProviderOutboxPayloadSchema = z.strictObject({
  actionLabel: z.literal("Open tracker"),
  adapterMode: z.literal("provider_safe_outbox"),
  availabilityClaim: z.literal("community_report_not_official_confirmation"),
  body: SafeTextSchema,
  channel: z.enum(["email", "telegram", "slack"]),
  containsBookingConfirmation: z.literal(false),
  containsSensitiveRawData: z.literal(false),
  country: SafeTextSchema,
  externalNetworkCallAttempted: z.literal(false),
  matchedDates: z.array(IsoDateSchema).min(1).max(60),
  postCity: SafeTextSchema,
  providerEndpoint: z.literal("disabled_by_default"),
  recipientRef: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  redactionLevel: z.literal("no_secrets"),
  retryBackoffSeconds: z.number().int().min(60).max(3600),
  title: z.literal("Community visa slot report"),
  unsubscribeAction: z.literal("pause_or_delete_filter"),
  visaClass: SafeTextSchema
});

export const AlertNotificationProviderOutboxDeliverySchema = z.strictObject({
  channel: z.enum(["email", "telegram", "slack"]),
  containsSensitiveRawData: z.literal(false),
  externalDeliveryEnabled: z.literal(false),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  notificationId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  outboxDeliveryId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  payload: AlertNotificationProviderOutboxPayloadSchema.nullable(),
  reason: z.enum(["provider_disabled_by_default", "channel_not_subscribed", "not_eligible"]),
  recordedAt: IsoDateTimeSchema,
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  status: z.enum(["queued_disabled", "skipped", "suppressed"]),
  subscriptionId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/)
});

export const AlertNotificationProviderOutboxResponseSchema = z.strictObject({
  adapterMode: z.literal("provider_safe_outbox"),
  containsSensitiveRawData: z.literal(false),
  countsByStatus: z.strictObject({
    queued_disabled: z.number().int().min(0),
    skipped: z.number().int().min(0),
    suppressed: z.number().int().min(0)
  }),
  deliveries: z.array(AlertNotificationProviderOutboxDeliverySchema).max(200),
  externalDeliveryEnabled: z.literal(false),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  slotAlertsDelivered: z.literal(false)
});

export const AlertNotificationProviderOutboxHistoryResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  countsByStatus: z.strictObject({
    queued_disabled: z.number().int().min(0),
    skipped: z.number().int().min(0),
    suppressed: z.number().int().min(0)
  }),
  deliveries: z.array(AlertNotificationProviderOutboxDeliverySchema).max(200),
  externalDeliveryEnabled: z.literal(false),
  externalNetworkCallAttempted: z.literal(false),
  liveProviderConfigured: z.literal(false),
  slotAlertsDelivered: z.literal(false)
});

export const ContributorTrustSummarySchema = z.strictObject({
  acceptedUniqueReports: z.number().int().min(0),
  abuseAuditEventCount: z.number().int().min(0),
  abuseReviewRequired: z.boolean(),
  conflictQuorumPolicy: z.strictObject({
    currentIndependentContributors: z.number().int().min(0),
    met: z.boolean(),
    requiredIndependentContributors: z.number().int().min(2)
  }),
  conflictReports: z.number().int().min(0),
  contributorId: z.string().trim().min(8).max(120),
  duplicateReports: z.number().int().min(0),
  identityHealth: z.enum(["not_registered", "new", "stable", "rotated", "review"]),
  identityRotationWarning: z.boolean(),
  localReviewStatus: z.enum(["clear", "watch", "restricted"]),
  localIdentitySeen: z.boolean(),
  moderationNoteCount: z.number().int().min(0),
  notificationEligibleReports: z.number().int().min(0),
  piiStored: z.literal(false),
  rateLimitPolicy: z.strictObject({
    currentWindowReports: z.number().int().min(0),
    limited: z.boolean(),
    maxReports: z.number().int().min(1),
    windowHours: z.number().int().min(1)
  }),
  recentReportCount: z.number().int().min(0),
  reputationStatus: z.enum(["new", "normal", "watch", "restricted"]),
  staleReports: z.number().int().min(0),
  totalReports: z.number().int().min(0)
});

export const ContributorTrustResponseSchema = z.strictObject({
  trust: ContributorTrustSummarySchema
});

export const ContributorAbuseAuditEventSchema = z.strictObject({
  action: z.enum(["report_accepted", "rate_limited", "abuse_review_flagged"]),
  containsSensitiveRawData: z.literal(false),
  contributorId: z.string().trim().min(8).max(120),
  limitMaxReports: z.number().int().min(1),
  limitWindowHours: z.number().int().min(1),
  reason: z.enum(["accepted_under_rate_limit", "hourly_report_limit_exceeded", "conflict_watch_threshold_reached"]),
  recentReportCount: z.number().int().min(0),
  recordedAt: IsoDateTimeSchema
});

export const ContributorAbuseAuditResponseSchema = z.strictObject({
  auditEvents: z.array(ContributorAbuseAuditEventSchema).max(500),
  containsSensitiveRawData: z.literal(false)
});

export const ContributorModerationReasonSchema = z.enum(["rate_limit_review", "conflict_review", "manual_review", "false_report_review"]);
export const ContributorLocalReviewStatusSchema = z.enum(["clear", "watch", "restricted"]);

export const ContributorModerationNotePayloadSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  note: SafeModerationNoteSchema,
  reason: ContributorModerationReasonSchema,
  reviewStatus: ContributorLocalReviewStatusSchema
});

export const ContributorModerationNoteSchema = ContributorModerationNotePayloadSchema.safeExtend({
  contributorId: z.string().trim().min(8).max(120),
  noteId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  recordedAt: IsoDateTimeSchema
});

export const ContributorModerationNoteCreateResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  note: ContributorModerationNoteSchema
});

export const ContributorModerationNotesResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  notes: z.array(ContributorModerationNoteSchema).max(500)
});

const ContributorIdentityPayloadShape = {
  containsSensitiveRawData: z.literal(false),
  contributorKeyId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  createdAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.optional(),
  piiStored: z.literal(false),
  proofKind: z.literal("opaque_local_key"),
  rotationCount: z.number().int().min(0).max(100),
  storageScope: z.literal("extension_local_storage")
};

function validateContributorIdentitySeenAt(
  payload: { createdAt: string; lastSeenAt?: string },
  context: z.RefinementCtx
) {
  if (payload.lastSeenAt && payload.lastSeenAt < payload.createdAt) {
    context.addIssue({
      code: "custom",
      message: "lastSeenAt must be on or after createdAt",
      path: ["lastSeenAt"]
    });
  }
}

export const ContributorIdentityPayloadSchema = z
  .strictObject(ContributorIdentityPayloadShape)
  .superRefine(validateContributorIdentitySeenAt);

export const ContributorIdentityRecordSchema = z.strictObject({
  ...ContributorIdentityPayloadShape,
  contributorId: z.string().trim().min(8).max(120),
  firstSeenAt: IsoDateTimeSchema,
  identityHealth: z.enum(["not_registered", "new", "stable", "rotated", "review"]),
  rotationWarning: z.boolean()
}).superRefine(validateContributorIdentitySeenAt);

export const ContributorIdentityAuditEventSchema = z.strictObject({
  action: z.enum(["created", "seen", "rotated"]),
  containsSensitiveRawData: z.literal(false),
  contributorId: z.string().trim().min(8).max(120),
  contributorKeyId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  previousContributorKeyId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/).nullable().optional(),
  recordedAt: IsoDateTimeSchema,
  rotationCount: z.number().int().min(0).max(100)
});

export const ContributorIdentityResponseSchema = z.strictObject({
  auditEvents: z.array(ContributorIdentityAuditEventSchema).max(500),
  containsSensitiveRawData: z.literal(false),
  identity: ContributorIdentityRecordSchema
});

export const PublicEstimateSnapshotPayloadSchema = z.strictObject({
  availabilityClaim: z.literal("public_estimate_not_slot_availability"),
  capturedAt: IsoDateTimeSchema,
  containsSensitiveRawData: z.literal(false),
  country: SafeTextSchema,
  estimateLabel: SafeTextSchema,
  estimateValueDays: z.number().int().min(0).max(3650),
  freshUntil: IsoDateTimeSchema,
  parserStatus: z.enum(["parsed", "parser_failed", "source_stale"]),
  parserVersion: z.string().trim().min(1).max(80),
  postCity: SafeTextSchema,
  sourceName: SafeTextSchema,
  sourcePermission: z.literal("public_estimate_context"),
  sourceUrl: z
    .string()
    .trim()
    .min(12)
    .max(500)
    .refine((value) => value.startsWith("https://") || value.startsWith("http://"), "sourceUrl must be HTTP(S)"),
  triggersSlotAlerts: z.literal(false),
  visaClass: SafeTextSchema
});

export const PublicEstimateSnapshotSchema = PublicEstimateSnapshotPayloadSchema.safeExtend({
  estimateId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  freshnessLabel: z.enum(["fresh", "stale", "quarantined"]),
  quarantineReason: z.enum(["parsed", "parser_failed", "source_stale"]).nullable().optional(),
  status: z.enum(["accepted", "quarantined"]),
  storedAt: IsoDateTimeSchema
});

export const PublicEstimateSnapshotCreateResponseSchema = z.strictObject({
  snapshot: PublicEstimateSnapshotSchema
});

export const PublicEstimateFixtureImportPayloadSchema = z.strictObject({
  adapterMode: z.literal("fixture_replay"),
  capturedAt: IsoDateTimeSchema.optional(),
  containsSensitiveRawData: z.literal(false),
  country: SafeTextSchema,
  estimateLabel: SafeTextSchema,
  fixtureText: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine((value) => !SensitiveNotePattern.test(value), "fixtureText must not include sensitive portal data")
    .refine((value) => !EmailPattern.test(value), "fixtureText must not include personal contact data")
    .refine((value) => !PhonePattern.test(value), "fixtureText must not include personal contact data"),
  freshUntil: IsoDateTimeSchema.optional(),
  parserVersion: z.string().trim().min(1).max(80),
  postCity: SafeTextSchema,
  quarantineByDefault: z.literal(true),
  sourceId: z.literal("travel_state_global_wait_times"),
  sourceName: SafeTextSchema,
  sourcePermission: z.literal("public_estimate_context"),
  sourceUrl: z
    .string()
    .trim()
    .min(12)
    .max(500)
    .refine((value) => value.startsWith("https://") || value.startsWith("http://"), "sourceUrl must be HTTP(S)"),
  triggersSlotAlerts: z.literal(false),
  visaClass: SafeTextSchema
});

export const PublicEstimateFixtureImportResponseSchema = z.strictObject({
  adapterMode: z.literal("fixture_replay"),
  allowlistStatus: z.literal("allowlisted"),
  liveFetchAttempted: z.literal(false),
  parserDriftDetected: z.boolean(),
  quarantineByDefault: z.literal(true),
  sourceId: z.literal("travel_state_global_wait_times"),
  slotAlertTriggerAttempted: z.literal(false),
  snapshot: PublicEstimateSnapshotSchema
});

export const PublicEstimateLatestResponseSchema = z.strictObject({
  estimates: z.array(PublicEstimateSnapshotSchema).max(100),
  quarantinedCount: z.number().int().min(0)
});

export const PublicContextSummarySchema = z.strictObject({
  acceptedEstimateCount: z.number().int().min(0),
  alertTriggerAllowed: z.literal(false),
  availabilityClaim: z.literal("public_context_not_slot_availability"),
  contextId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  country: SafeTextSchema,
  freshUntil: IsoDateTimeSchema,
  freshnessLabel: z.enum(["fresh", "stale", "quarantined", "mixed"]),
  latestCapturedAt: IsoDateTimeSchema,
  latestEstimateLabel: SafeTextSchema,
  latestEstimateValueDays: z.number().int().min(0).max(3650),
  parserStatuses: z.array(z.enum(["parsed", "parser_failed", "source_stale"])).max(8),
  postCity: SafeTextSchema,
  quarantinedEstimateCount: z.number().int().min(0),
  recommendedUse: z.literal("decision_context_only"),
  reviewNote: z.literal("public_context_not_appointment_inventory"),
  slotAlertTriggerAttempted: z.literal(false),
  sourceKind: z.literal("public_estimate"),
  sourceNames: z.array(SafeTextSchema).max(16),
  sourceUrls: z.array(z.string().trim().min(12).max(500)).max(16),
  staleEstimateCount: z.number().int().min(0),
  status: z.enum(["accepted", "quarantined", "mixed"]),
  totalEstimateCount: z.number().int().min(1),
  triggersSlotAlerts: z.literal(false),
  visaClass: SafeTextSchema
});

export const SourcePolicyRecordSchema = z.strictObject({
  alertEligibility: z.enum(["alert_allowed", "context_only", "sandbox_only", "blocked_pending_authorization"]),
  allowedInMvp: z.boolean(),
  appointmentChangingActionAllowed: z.literal(false),
  canTriggerSlotAlerts: z.boolean(),
  credentialAccessAllowed: z.literal(false),
  officialAvailabilitySource: z.literal(false),
  policyReason: SafeTextSchema,
  portalAutomationAllowed: z.literal(false),
  proofGate: SafeTextSchema,
  requiresWrittenAuthorization: z.boolean(),
  sourceKind: z.enum([
    "community_report",
    "manual_report",
    "public_estimate",
    "notification_adapter_sandbox",
    "authorized_partner_api"
  ]),
  sourceLane: z.enum([
    "community_signal",
    "manual_visible_metadata",
    "public_context",
    "sandbox_payload",
    "authorized_source_pending_evidence"
  ])
});

export const PublicContextSummaryResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  contexts: z.array(PublicContextSummarySchema).max(100),
  liveFetchAttempted: z.literal(false),
  quarantinedContextCount: z.number().int().min(0),
  slotAlertsDelivered: z.literal(false),
  slotAlertTriggerAttempted: z.literal(false),
  sourcePolicy: SourcePolicyRecordSchema
});

export const SourcePolicyResponseSchema = z.strictObject({
  appointmentChangingActionAllowed: z.literal(false),
  checkedAt: IsoDateTimeSchema,
  containsSensitiveRawData: z.literal(false),
  credentialAccessAllowed: z.literal(false),
  livePortalAutomationAllowed: z.literal(false),
  records: z.array(SourcePolicyRecordSchema).min(1).max(12)
});

export const SlotSignalExportResponseSchema = z.strictObject({
  appointmentChangingActionTaken: z.literal(false),
  containsSensitiveRawData: z.literal(false),
  contributorIdentities: z.array(ContributorIdentityRecordSchema).max(1000),
  contributorIdentityAuditEvents: z.array(ContributorIdentityAuditEventSchema).max(1000),
  contributorModerationNotes: z.array(ContributorModerationNoteSchema).max(1000),
  deliveryAuditEvents: z.array(SlotReportAlertDeliveryAuditEventSchema).max(1000),
  exportedAt: IsoDateTimeSchema,
  livePortalRequestMade: z.literal(false),
  pendingMatches: z.array(SlotReportAlertMatchSchema).max(1000),
  publicEstimates: z.array(PublicEstimateSnapshotSchema).max(1000),
  reports: z.array(SlotReportResponseSchema).max(1000),
  safeSummary: SafeTextSchema,
  schemaVersion: z.number().int().min(0),
  subscriptions: z.array(SlotReportAlertSubscriptionSchema).max(1000)
});

export const SlotSignalDeleteResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  deleted: z.boolean(),
  deletedDeliveryAuditEvents: z.number().int().min(0),
  deletedPendingMatches: z.number().int().min(0),
  deletedReports: z.number().int().min(0),
  reportId: z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  retentionAction: z.literal("manual_delete")
});

export const SlotSignalRetentionPrunePayloadSchema = z.strictObject({
  cutoffBefore: IsoDateTimeSchema.optional(),
  dryRun: z.boolean()
});

export const SlotSignalRetentionPruneResponseSchema = z.strictObject({
  containsSensitiveRawData: z.literal(false),
  cutoffBefore: IsoDateTimeSchema,
  deletedDeliveryAuditEvents: z.number().int().min(0),
  deletedPendingMatches: z.number().int().min(0),
  deletedReports: z.number().int().min(0),
  dryRun: z.boolean(),
  matchedReports: z.number().int().min(0),
  retentionAction: z.literal("retention_prune")
});

export type SlotReportContributionPayload = z.infer<typeof SlotReportContributionPayloadSchema>;
export type SlotReportResponse = z.infer<typeof SlotReportResponseSchema>;
export type SlotReportAlertMatch = z.infer<typeof SlotReportAlertMatchSchema>;
export type SlotReportAlertSubscription = z.infer<typeof SlotReportAlertSubscriptionSchema>;
export type SlotReportAlertSubscriptionPayload = z.infer<typeof SlotReportAlertSubscriptionPayloadSchema>;
export type SlotReportAlertSubscriptionResponse = z.infer<typeof SlotReportAlertSubscriptionResponseSchema>;
export type AlertSubscriptionUpdatePayload = z.infer<typeof AlertSubscriptionUpdatePayloadSchema>;
export type AlertSubscriptionListResponse = z.infer<typeof AlertSubscriptionListResponseSchema>;
export type AlertSubscriptionUpdateResponse = z.infer<typeof AlertSubscriptionUpdateResponseSchema>;
export type AlertSubscriptionDeleteResponse = z.infer<typeof AlertSubscriptionDeleteResponseSchema>;
export type AlertNotificationDigestResponse = z.infer<typeof AlertNotificationDigestResponseSchema>;
export type AlertNotificationQueueResponse = z.infer<typeof AlertNotificationQueueResponseSchema>;
export type AlertPendingCleanupPayload = z.infer<typeof AlertPendingCleanupPayloadSchema>;
export type AlertPendingCleanupResponse = z.infer<typeof AlertPendingCleanupResponseSchema>;
export type AlertDeliveryAckPayload = z.infer<typeof AlertDeliveryAckPayloadSchema>;
export type AlertDigestDeliveryAckPayload = z.infer<typeof AlertDigestDeliveryAckPayloadSchema>;
export type AlertDigestDeliveryAckResponse = z.infer<typeof AlertDigestDeliveryAckResponseSchema>;
export type AlertDeliveryHistoryResponse = z.infer<typeof AlertDeliveryHistoryResponseSchema>;
export type AlertNotificationAdapterSandboxPayloadRequest = z.infer<typeof AlertNotificationAdapterSandboxPayloadRequestSchema>;
export type AlertNotificationAdapterSandboxResponse = z.infer<typeof AlertNotificationAdapterSandboxResponseSchema>;
export type AlertNotificationAdapterSandboxHistoryResponse = z.infer<typeof AlertNotificationAdapterSandboxHistoryResponseSchema>;
export type ProviderDeliveryReadinessResponse = z.infer<typeof ProviderDeliveryReadinessResponseSchema>;
export type AlertNotificationProviderOutboxPayloadRequest = z.infer<typeof AlertNotificationProviderOutboxPayloadRequestSchema>;
export type AlertNotificationProviderOutboxResponse = z.infer<typeof AlertNotificationProviderOutboxResponseSchema>;
export type AlertNotificationProviderOutboxHistoryResponse = z.infer<typeof AlertNotificationProviderOutboxHistoryResponseSchema>;
export type ContributorAbuseAuditResponse = z.infer<typeof ContributorAbuseAuditResponseSchema>;
export type ContributorIdentityPayload = z.infer<typeof ContributorIdentityPayloadSchema>;
export type ContributorIdentityResponse = z.infer<typeof ContributorIdentityResponseSchema>;
export type ContributorModerationNotePayload = z.infer<typeof ContributorModerationNotePayloadSchema>;
export type ContributorModerationNoteCreateResponse = z.infer<typeof ContributorModerationNoteCreateResponseSchema>;
export type ContributorModerationNotesResponse = z.infer<typeof ContributorModerationNotesResponseSchema>;
export type ContributorTrustResponse = z.infer<typeof ContributorTrustResponseSchema>;
export type PublicEstimateFixtureImportPayload = z.infer<typeof PublicEstimateFixtureImportPayloadSchema>;
export type PublicEstimateFixtureImportResponse = z.infer<typeof PublicEstimateFixtureImportResponseSchema>;
export type PublicEstimateSnapshotPayload = z.infer<typeof PublicEstimateSnapshotPayloadSchema>;
export type PublicEstimateLatestResponse = z.infer<typeof PublicEstimateLatestResponseSchema>;
export type PublicContextSummaryResponse = z.infer<typeof PublicContextSummaryResponseSchema>;
export type SourcePolicyRecord = z.infer<typeof SourcePolicyRecordSchema>;
export type SourcePolicyResponse = z.infer<typeof SourcePolicyResponseSchema>;
export type PublicEstimateSnapshotCreateResponse = z.infer<typeof PublicEstimateSnapshotCreateResponseSchema>;
export type SlotSignalRetentionPrunePayload = z.infer<typeof SlotSignalRetentionPrunePayloadSchema>;
export type SlotSignalRetentionPruneResponse = z.infer<typeof SlotSignalRetentionPruneResponseSchema>;
export type SlotSignalDeleteResponse = z.infer<typeof SlotSignalDeleteResponseSchema>;
export type SlotSignalExportResponse = z.infer<typeof SlotSignalExportResponseSchema>;
export type SlotReportLatestResponse = z.infer<typeof SlotReportLatestResponseSchema>;
export type SlotReportAlertDeliveryAckResponse = z.infer<typeof SlotReportAlertDeliveryAckResponseSchema>;
export type PendingSlotAlertDeliveryPlan = ReturnType<typeof createPendingSlotAlertDeliveryPlan>;

export type BuildSlotReportContributionInput = {
  availableDatesText: string;
  capturedAt?: string;
  contributorId?: string;
  country: string;
  notes?: string;
  postCity: string;
  visaClass: string;
};

export type SlotReportContributionDraftValidation =
  | {
      errors: [];
      normalizedDates: string[];
      payload: SlotReportContributionPayload;
      valid: true;
    }
  | {
      errors: string[];
      normalizedDates: string[];
      payload: null;
      valid: false;
    };

export type SlotReportApiClientOptions = {
  apiBaseUrl?: string;
  authToken?: string;
  fetcher?: typeof fetch;
};

export type FetchLatestSlotReportsParams = {
  country?: string;
  includeLowTrust?: boolean;
  includeStale?: boolean;
  postCity?: string;
  targetEndDate?: string;
  targetStartDate?: string;
  visaClass?: string;
};

export type FetchLatestPublicEstimatesParams = {
  country?: string;
  includeQuarantined?: boolean;
  postCity?: string;
  visaClass?: string;
};

export type FetchPublicContextSummaryParams = FetchLatestPublicEstimatesParams;

export type FetchPendingAlertNotificationsParams = {
  includeBackoff?: boolean;
  includeDigest?: boolean;
};

export type BuildAlertSubscriptionInput = {
  availableDates: string[];
  cooldownMinutes?: number;
  country: string;
  deliveryMode?: "immediate" | "digest";
  digestWindowMinutes?: number;
  postCity: string;
  visaClass: string;
};

export type BuildPublicEstimateSnapshotInput = {
  country: string;
  estimateLabel: string;
  estimateValueDays: number;
  freshUntil?: string;
  parserStatus?: "parsed" | "parser_failed" | "source_stale";
  parserVersion?: string;
  postCity: string;
  sourceName?: string;
  sourceUrl: string;
  visaClass: string;
};

export type BuildPublicEstimateFixtureImportInput = {
  adapterMode?: "fixture_replay";
  capturedAt?: string;
  country: string;
  estimateLabel: string;
  fixtureText: string;
  freshUntil?: string;
  parserVersion?: string;
  postCity: string;
  quarantineByDefault?: true;
  sourceId?: "travel_state_global_wait_times";
  sourceName?: string;
  sourceUrl: string;
  visaClass: string;
};

export type BuildContributorModerationNoteInput = {
  note: string;
  reason?: "rate_limit_review" | "conflict_review" | "manual_review" | "false_report_review";
  reviewStatus?: "clear" | "watch" | "restricted";
};

export type BuildContributorIdentityInput = {
  contributorKeyId: string;
  createdAt: string;
  lastSeenAt?: string;
  rotationCount: number;
};

export function parseAvailableDatesText(value: string): string[] {
  const tokens = value
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const dates = [...new Set(tokens)].sort();
  const parsed = z.array(IsoDateSchema).min(1, "Enter at least one valid date").parse(dates);
  return parsed;
}

export function buildSlotReportContributionPayload(input: BuildSlotReportContributionInput): SlotReportContributionPayload {
  return SlotReportContributionPayloadSchema.parse({
    availableDates: parseAvailableDatesText(input.availableDatesText),
    bookingActionTaken: false,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    confidence: "user_visible",
    containsSensitiveRawData: false,
    contributorId: input.contributorId || undefined,
    country: input.country,
    credentialDataIncluded: false,
    notes: input.notes || undefined,
    portalAutomationUsed: false,
    postCity: input.postCity,
    sourceKind: "community_report",
    visaClass: input.visaClass
  });
}

function validationErrors(error: unknown): string[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message);
  }
  if (error instanceof Error && error.message) return [error.message];
  return ["Contribution draft is invalid."];
}

export function validateSlotReportContributionDraft(
  input: BuildSlotReportContributionInput
): SlotReportContributionDraftValidation {
  let normalizedDates: string[] = [];
  try {
    normalizedDates = parseAvailableDatesText(input.availableDatesText);
  } catch {
    normalizedDates = [];
  }

  try {
    const payload = buildSlotReportContributionPayload(input);
    return {
      errors: [],
      normalizedDates: payload.availableDates,
      payload,
      valid: true
    };
  } catch (error) {
    return {
      errors: validationErrors(error),
      normalizedDates,
      payload: null,
      valid: false
    };
  }
}

export function buildAlertSubscriptionPayload(input: BuildAlertSubscriptionInput): SlotReportAlertSubscriptionPayload {
  const dates = z.array(IsoDateSchema).min(1).parse([...new Set(input.availableDates)].sort());
  return SlotReportAlertSubscriptionPayloadSchema.parse({
    active: true,
    channels: ["browser"],
    cooldownMinutes: input.cooldownMinutes ?? 15,
    country: input.country,
    deliveryMode: input.deliveryMode ?? "immediate",
    digestWindowMinutes: input.digestWindowMinutes ?? 60,
    postCities: [input.postCity],
    targetEndDate: dates[dates.length - 1],
    targetStartDate: dates[0],
    visaClasses: [input.visaClass]
  });
}

export function buildContributorModerationNotePayload(input: BuildContributorModerationNoteInput): ContributorModerationNotePayload {
  return ContributorModerationNotePayloadSchema.parse({
    containsSensitiveRawData: false,
    note: input.note,
    reason: input.reason ?? "manual_review",
    reviewStatus: input.reviewStatus ?? "watch"
  });
}

export function buildContributorIdentityPayload(input: BuildContributorIdentityInput): ContributorIdentityPayload {
  return ContributorIdentityPayloadSchema.parse({
    containsSensitiveRawData: false,
    contributorKeyId: input.contributorKeyId,
    createdAt: input.createdAt,
    lastSeenAt: input.lastSeenAt ?? new Date().toISOString(),
    piiStored: false,
    proofKind: "opaque_local_key",
    rotationCount: input.rotationCount,
    storageScope: "extension_local_storage"
  });
}

export function buildPublicEstimateFixtureImportPayload(input: BuildPublicEstimateFixtureImportInput): PublicEstimateFixtureImportPayload {
  return PublicEstimateFixtureImportPayloadSchema.parse({
    adapterMode: input.adapterMode ?? "fixture_replay",
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    containsSensitiveRawData: false,
    country: input.country,
    estimateLabel: input.estimateLabel,
    fixtureText: input.fixtureText,
    freshUntil: input.freshUntil,
    parserVersion: input.parserVersion ?? "fixture-public-estimate-v1",
    postCity: input.postCity,
    quarantineByDefault: input.quarantineByDefault ?? true,
    sourceId: input.sourceId ?? "travel_state_global_wait_times",
    sourceName: input.sourceName ?? "Department of State Global Visa Wait Times",
    sourcePermission: "public_estimate_context",
    sourceUrl: input.sourceUrl,
    triggersSlotAlerts: false,
    visaClass: input.visaClass
  });
}

export function buildPublicEstimateSnapshotPayload(input: BuildPublicEstimateSnapshotInput): PublicEstimateSnapshotPayload {
  const capturedAt = new Date().toISOString();
  const freshUntil = input.freshUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return PublicEstimateSnapshotPayloadSchema.parse({
    availabilityClaim: "public_estimate_not_slot_availability",
    capturedAt,
    containsSensitiveRawData: false,
    country: input.country,
    estimateLabel: input.estimateLabel,
    estimateValueDays: input.estimateValueDays,
    freshUntil,
    parserStatus: input.parserStatus ?? "parsed",
    parserVersion: input.parserVersion ?? "manual-public-estimate-v1",
    postCity: input.postCity,
    sourceName: input.sourceName ?? "Public estimate",
    sourcePermission: "public_estimate_context",
    sourceUrl: input.sourceUrl,
    triggersSlotAlerts: false,
    visaClass: input.visaClass
  });
}

function firstMatchedDate(match: SlotReportAlertMatch): string {
  return match.matchedDates[0] ?? "a reported date";
}

function createPendingSlotAlertMessage(match: SlotReportAlertMatch) {
  const provenance = match.reportTrust.provenance;
  return SafeNotificationMessageSchema.parse({
    actionLabel: "Review candidate",
    body: `${provenance.postCity} ${provenance.visaClass} community availability includes ${firstMatchedDate(match)}. Review the community report. No appointment action was taken.`,
    bookingLanguageStatus: "candidate_not_booked",
    containsBookingConfirmation: false,
    containsSensitiveRawData: false,
    messageIntent: "alert_only",
    title: "Community visa slot report"
  });
}

export function createPendingSlotAlertDeliveryPlan({
  deliveredNotificationIds,
  now = new Date(),
  pendingMatches
}: {
  deliveredNotificationIds: Set<string>;
  now?: Date;
  pendingMatches: SlotReportAlertMatch[];
}) {
  const deliveries: Array<{
    match: SlotReportAlertMatch;
    notificationId: string;
    safeMessage: z.infer<typeof SafeNotificationMessageSchema>;
  }> = [];
  const suppressed: Array<{
    match: SlotReportAlertMatch;
    notificationId: string;
    reason: "already_delivered" | "digest_mode_deferred" | "not_browser_channel" | "not_eligible" | "retry_backoff_active";
  }> = [];

  for (const match of pendingMatches.map((pendingMatch) => SlotReportAlertMatchSchema.parse(pendingMatch))) {
    const notificationId = match.notificationEvent.notificationId;
    if (match.deliveryMode === "digest") {
      suppressed.push({ match, notificationId, reason: "digest_mode_deferred" });
      continue;
    }
    if (match.nextRetryAt && new Date(match.nextRetryAt) > now) {
      suppressed.push({ match, notificationId, reason: "retry_backoff_active" });
      continue;
    }
    if (deliveredNotificationIds.has(notificationId)) {
      suppressed.push({ match, notificationId, reason: "already_delivered" });
      continue;
    }
    if (match.notificationEvent.channel !== "browser") {
      suppressed.push({ match, notificationId, reason: "not_browser_channel" });
      continue;
    }
    if (!match.reportTrust.eligibleForNotification || match.reportTrust.status !== "accepted_unique") {
      suppressed.push({ match, notificationId, reason: "not_eligible" });
      continue;
    }
    deliveries.push({
      match,
      notificationId,
      safeMessage: createPendingSlotAlertMessage(match)
    });
  }

  return { deliveries, suppressed };
}

export function createSlotReportApiClient(options: SlotReportApiClientOptions = {}) {
  const apiBaseUrl = (options.apiBaseUrl ?? "/v1").replace(/\/+$/, "");
  const authToken = options.authToken?.trim();
  const fetcher = options.fetcher ?? fetch;
  const requestHeaders = () => ({
    "Content-Type": "application/json",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
  });

  return {
    async acknowledgeAlertDelivery(
      notificationId: string,
      payload: AlertDeliveryAckPayload
    ): Promise<SlotReportAlertDeliveryAckResponse> {
      const safePayload = AlertDeliveryAckPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/${encodeURIComponent(notificationId)}/delivery-ack`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Alert delivery acknowledgement failed with HTTP ${response.status}`);
      }
      return SlotReportAlertDeliveryAckResponseSchema.parse(await response.json());
    },
    async submitSlotReport(payload: SlotReportContributionPayload): Promise<SlotReportResponse> {
      const safePayload = SlotReportContributionPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/slot-reports`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Slot report submission failed with HTTP ${response.status}`);
      }
      return SlotReportResponseSchema.parse(await response.json());
    },
    async createAlertSubscription(payload: SlotReportAlertSubscriptionPayload): Promise<SlotReportAlertSubscriptionResponse> {
      const safePayload = SlotReportAlertSubscriptionPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-subscriptions`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Alert subscription failed with HTTP ${response.status}`);
      }
      return SlotReportAlertSubscriptionResponseSchema.parse(await response.json());
    },
    async fetchAlertSubscriptions(includeDeleted = false): Promise<AlertSubscriptionListResponse> {
      const query = includeDeleted ? "?includeDeleted=true" : "";
      const response = await fetcher(`${apiBaseUrl}/alert-subscriptions${query}`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Alert subscription list fetch failed with HTTP ${response.status}`);
      }
      return AlertSubscriptionListResponseSchema.parse(await response.json());
    },
    async updateAlertSubscription(
      subscriptionId: string,
      payload: AlertSubscriptionUpdatePayload
    ): Promise<AlertSubscriptionUpdateResponse> {
      const safePayload = AlertSubscriptionUpdatePayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-subscriptions/${encodeURIComponent(subscriptionId)}`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "PATCH"
      });
      if (!response.ok) {
        throw new Error(`Alert subscription update failed with HTTP ${response.status}`);
      }
      return AlertSubscriptionUpdateResponseSchema.parse(await response.json());
    },
    async deleteAlertSubscription(subscriptionId: string, auditReason = "user unsubscribed"): Promise<AlertSubscriptionDeleteResponse> {
      const query = new URLSearchParams({ auditReason });
      const response = await fetcher(`${apiBaseUrl}/alert-subscriptions/${encodeURIComponent(subscriptionId)}?${query.toString()}`, {
        headers: requestHeaders(),
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(`Alert subscription delete failed with HTTP ${response.status}`);
      }
      return AlertSubscriptionDeleteResponseSchema.parse(await response.json());
    },
    async fetchPendingAlertNotifications(params: FetchPendingAlertNotificationsParams = {}): Promise<AlertNotificationQueueResponse> {
      const query = new URLSearchParams();
      if (params.includeBackoff) query.set("includeBackoff", "true");
      if (params.includeDigest) query.set("includeDigest", "true");
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/pending${query.size > 0 ? `?${query.toString()}` : ""}`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Pending alert notification fetch failed with HTTP ${response.status}`);
      }
      return AlertNotificationQueueResponseSchema.parse(await response.json());
    },
    async fetchDigestAlertNotifications(): Promise<AlertNotificationDigestResponse> {
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/digest`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Digest alert notification fetch failed with HTTP ${response.status}`);
      }
      return AlertNotificationDigestResponseSchema.parse(await response.json());
    },
    async acknowledgeDigestDelivery(
      subscriptionId: string,
      payload: AlertDigestDeliveryAckPayload
    ): Promise<AlertDigestDeliveryAckResponse> {
      const safePayload = AlertDigestDeliveryAckPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/digest/${encodeURIComponent(subscriptionId)}/delivery-ack`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Digest delivery acknowledgement failed with HTTP ${response.status}`);
      }
      return AlertDigestDeliveryAckResponseSchema.parse(await response.json());
    },
    async cleanupPendingAlertNotifications(payload: AlertPendingCleanupPayload): Promise<AlertPendingCleanupResponse> {
      const safePayload = AlertPendingCleanupPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/pending/cleanup`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Pending alert cleanup failed with HTTP ${response.status}`);
      }
      return AlertPendingCleanupResponseSchema.parse(await response.json());
    },
    async fetchAlertDeliveryHistory(): Promise<AlertDeliveryHistoryResponse> {
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/delivery-history`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Alert delivery history fetch failed with HTTP ${response.status}`);
      }
      return AlertDeliveryHistoryResponseSchema.parse(await response.json());
    },
    async sandboxNotificationAdapters(
      payload: AlertNotificationAdapterSandboxPayloadRequest
    ): Promise<AlertNotificationAdapterSandboxResponse> {
      const safePayload = AlertNotificationAdapterSandboxPayloadRequestSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/adapter-sandbox`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Notification adapter sandbox failed with HTTP ${response.status}`);
      }
      return AlertNotificationAdapterSandboxResponseSchema.parse(await response.json());
    },
    async fetchNotificationAdapterSandboxHistory(): Promise<AlertNotificationAdapterSandboxHistoryResponse> {
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/adapter-sandbox/history`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Notification adapter sandbox history fetch failed with HTTP ${response.status}`);
      }
      return AlertNotificationAdapterSandboxHistoryResponseSchema.parse(await response.json());
    },
    async fetchProviderDeliveryReadiness(): Promise<ProviderDeliveryReadinessResponse> {
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/provider-readiness`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Provider delivery readiness fetch failed with HTTP ${response.status}`);
      }
      return ProviderDeliveryReadinessResponseSchema.parse(await response.json());
    },
    async createProviderOutbox(
      payload: AlertNotificationProviderOutboxPayloadRequest
    ): Promise<AlertNotificationProviderOutboxResponse> {
      const safePayload = AlertNotificationProviderOutboxPayloadRequestSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/provider-outbox`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Provider-safe outbox creation failed with HTTP ${response.status}`);
      }
      return AlertNotificationProviderOutboxResponseSchema.parse(await response.json());
    },
    async fetchProviderOutboxHistory(): Promise<AlertNotificationProviderOutboxHistoryResponse> {
      const response = await fetcher(`${apiBaseUrl}/alert-notifications/provider-outbox/history`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Provider-safe outbox history fetch failed with HTTP ${response.status}`);
      }
      return AlertNotificationProviderOutboxHistoryResponseSchema.parse(await response.json());
    },
    async fetchContributorTrust(contributorId: string): Promise<ContributorTrustResponse> {
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/trust`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Contributor trust fetch failed with HTTP ${response.status}`);
      }
      return ContributorTrustResponseSchema.parse(await response.json());
    },
    async upsertContributorIdentity(
      contributorId: string,
      payload: ContributorIdentityPayload
    ): Promise<ContributorIdentityResponse> {
      const safePayload = ContributorIdentityPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/identity`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "PUT"
      });
      if (!response.ok) {
        throw new Error(`Contributor identity update failed with HTTP ${response.status}`);
      }
      return ContributorIdentityResponseSchema.parse(await response.json());
    },
    async fetchContributorIdentity(contributorId: string): Promise<ContributorIdentityResponse> {
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/identity`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Contributor identity fetch failed with HTTP ${response.status}`);
      }
      return ContributorIdentityResponseSchema.parse(await response.json());
    },
    async fetchContributorAbuseAudit(contributorId: string): Promise<ContributorAbuseAuditResponse> {
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/abuse-audit`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Contributor abuse audit fetch failed with HTTP ${response.status}`);
      }
      return ContributorAbuseAuditResponseSchema.parse(await response.json());
    },
    async addContributorModerationNote(
      contributorId: string,
      payload: ContributorModerationNotePayload
    ): Promise<ContributorModerationNoteCreateResponse> {
      const safePayload = ContributorModerationNotePayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/moderation-notes`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Contributor moderation note failed with HTTP ${response.status}`);
      }
      return ContributorModerationNoteCreateResponseSchema.parse(await response.json());
    },
    async fetchContributorModerationNotes(contributorId: string): Promise<ContributorModerationNotesResponse> {
      const response = await fetcher(`${apiBaseUrl}/contributors/${encodeURIComponent(contributorId)}/moderation-notes`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Contributor moderation notes fetch failed with HTTP ${response.status}`);
      }
      return ContributorModerationNotesResponseSchema.parse(await response.json());
    },
    async submitPublicEstimateSnapshot(payload: PublicEstimateSnapshotPayload): Promise<PublicEstimateSnapshotCreateResponse> {
      const safePayload = PublicEstimateSnapshotPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/public-estimates/snapshots`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Public estimate submission failed with HTTP ${response.status}`);
      }
      return PublicEstimateSnapshotCreateResponseSchema.parse(await response.json());
    },
    async importPublicEstimateFixture(payload: PublicEstimateFixtureImportPayload): Promise<PublicEstimateFixtureImportResponse> {
      const safePayload = PublicEstimateFixtureImportPayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/public-estimates/import-fixture`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Public estimate fixture import failed with HTTP ${response.status}`);
      }
      return PublicEstimateFixtureImportResponseSchema.parse(await response.json());
    },
    async fetchLatestPublicEstimates(params: FetchLatestPublicEstimatesParams = {}): Promise<PublicEstimateLatestResponse> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === "") continue;
        query.set(key, String(value));
      }
      const response = await fetcher(`${apiBaseUrl}/public-estimates/latest${query.size > 0 ? `?${query.toString()}` : ""}`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Latest public estimate fetch failed with HTTP ${response.status}`);
      }
      return PublicEstimateLatestResponseSchema.parse(await response.json());
    },
    async fetchPublicContextSummary(params: FetchPublicContextSummaryParams = {}): Promise<PublicContextSummaryResponse> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === "") continue;
        query.set(key, String(value));
      }
      const response = await fetcher(`${apiBaseUrl}/public-context/summary${query.size > 0 ? `?${query.toString()}` : ""}`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Public context summary fetch failed with HTTP ${response.status}`);
      }
      return PublicContextSummaryResponseSchema.parse(await response.json());
    },
    async fetchSourcePolicy(): Promise<SourcePolicyResponse> {
      const response = await fetcher(`${apiBaseUrl}/source-policy`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Source policy fetch failed with HTTP ${response.status}`);
      }
      return SourcePolicyResponseSchema.parse(await response.json());
    },
    async fetchLatestSlotReports(params: FetchLatestSlotReportsParams = {}): Promise<SlotReportLatestResponse> {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === "") continue;
        query.set(key, String(value));
      }
      const response = await fetcher(`${apiBaseUrl}/slot-reports/latest${query.size > 0 ? `?${query.toString()}` : ""}`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Latest slot report fetch failed with HTTP ${response.status}`);
      }
      return SlotReportLatestResponseSchema.parse(await response.json());
    },
    async exportSlotSignalRecords(): Promise<SlotSignalExportResponse> {
      const response = await fetcher(`${apiBaseUrl}/slot-signal/export`, {
        headers: requestHeaders(),
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`Slot signal export failed with HTTP ${response.status}`);
      }
      return SlotSignalExportResponseSchema.parse(await response.json());
    },
    async deleteSlotSignalReport(reportId: string): Promise<SlotSignalDeleteResponse> {
      const response = await fetcher(`${apiBaseUrl}/slot-signal/reports/${encodeURIComponent(reportId)}`, {
        headers: requestHeaders(),
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(`Slot signal report delete failed with HTTP ${response.status}`);
      }
      return SlotSignalDeleteResponseSchema.parse(await response.json());
    },
    async pruneSlotSignalRecords(payload: SlotSignalRetentionPrunePayload): Promise<SlotSignalRetentionPruneResponse> {
      const safePayload = SlotSignalRetentionPrunePayloadSchema.parse(payload);
      const response = await fetcher(`${apiBaseUrl}/slot-signal/retention/prune`, {
        body: JSON.stringify(safePayload),
        headers: requestHeaders(),
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Slot signal retention prune failed with HTTP ${response.status}`);
      }
      return SlotSignalRetentionPruneResponseSchema.parse(await response.json());
    }
  };
}
