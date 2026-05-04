import { z } from "zod";

import {
  AuditEventSchema,
  NotificationEventSchema,
  type AuditEvent,
  type NotificationEvent
} from "./domain.js";

const ContractIdSchema = z.string().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const IsoDateTimeSchema = z.string().datetime();
const SafeTextSchema = z.string().min(1).max(360);

export const NotificationChannelPreferenceSchema = z
  .object({
    browser: z.boolean(),
    telegram: z.boolean(),
    email: z.boolean()
  })
  .strict();

export const NotificationPreferenceSchema = z
  .object({
    preferenceId: ContractIdSchema,
    channels: NotificationChannelPreferenceSchema,
    createdAt: IsoDateTimeSchema,
    includeBookingContext: z.literal(true),
    allowExternalActions: z.literal(false),
    telegramCommandScope: z.literal("status_only"),
    redactionLevel: z.literal("no_secrets"),
    containsSensitiveRawData: z.literal(false)
  })
  .strict();

export const SafeNotificationMessageSchema = z
  .object({
    title: SafeTextSchema,
    body: SafeTextSchema,
    actionLabel: z.enum(["Open tracker", "Review candidate"]),
    messageIntent: z.enum(["alert_only", "status_only", "assist_ready"]),
    bookingLanguageStatus: z.literal("candidate_not_booked"),
    containsBookingConfirmation: z.literal(false),
    containsSensitiveRawData: z.literal(false)
  })
  .strict()
  .superRefine((message, context) => {
    const joined = `${message.title} ${message.body}`.toLowerCase();
    for (const phrase of ["booked", "booking confirmed", "appointment changed", "reserved", "auto"]) {
      if (joined.includes(phrase)) {
        context.addIssue({
          code: "custom",
          message: `Notification copy contains unsafe phrase: ${phrase}`,
          path: ["body"]
        });
      }
    }
  });

export const NotificationDeliveryReasonSchema = z.enum([
  "delivered",
  "channel_disabled",
  "adapter_not_configured",
  "missing_permission",
  "browser_api_unavailable",
  "spam_guard_cooldown",
  "unsafe_content"
]);

export const NotificationDeliveryResultSchema = z
  .object({
    deliveryId: ContractIdSchema,
    notificationId: ContractIdSchema,
    channel: z.enum(["browser", "telegram", "email", "slack", "debug"]),
    attemptedAt: IsoDateTimeSchema,
    status: z.enum(["sent", "failed", "suppressed"]),
    reason: NotificationDeliveryReasonSchema,
    providerMessageId: z.string().min(1).max(160).nullable(),
    safeMessage: SafeNotificationMessageSchema,
    containsBookingConfirmation: z.literal(false),
    containsSensitiveRawData: z.literal(false)
  })
  .strict();

export const NotificationDispatchBundleSchema = z
  .object({
    notification: NotificationEventSchema,
    deliveries: z.array(NotificationDeliveryResultSchema).min(1).max(4),
    auditEvent: AuditEventSchema
  })
  .strict();

export const TelegramCommandAuditSchema = z
  .object({
    command: z.enum(["status", "open_browser", "confirm_booking"]),
    allowed: z.boolean(),
    reason: z.enum(["status_only", "browser_only_action", "appointment_action_blocked"]),
    auditEvent: AuditEventSchema
  })
  .strict();

export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;
export type NotificationDeliveryResult = z.infer<typeof NotificationDeliveryResultSchema>;
export type NotificationDispatchBundle = z.infer<typeof NotificationDispatchBundleSchema>;
export type SafeNotificationMessage = z.infer<typeof SafeNotificationMessageSchema>;
export type TelegramCommandAudit = z.infer<typeof TelegramCommandAuditSchema>;

type NotificationQueueState = {
  bookingAssistSession: {
    sessionId: string;
  } | null;
  generatedAt: string;
  notificationSpamGuard?: {
    status: "guarded" | "ready" | "suppressed" | "unknown";
  };
  latestSnapshot: {
    appointmentDate?: string;
    appointmentTime?: string | null;
    candidates: Array<{
      appointmentDate: string;
      appointmentTime: string | null;
      consulateName: string;
    }>;
    snapshotId: string;
  } | null;
};

function iso(date: Date) {
  return date.toISOString();
}

function safeSuffix(value: string) {
  return value.replace(/[^A-Za-z0-9._:-]+/g, ":").slice(0, 64);
}

export function createNotificationPreferences({
  browser = true,
  email = false,
  telegram = false,
  now = new Date()
}: {
  browser?: boolean;
  email?: boolean;
  telegram?: boolean;
  now?: Date;
} = {}): NotificationPreference {
  return NotificationPreferenceSchema.parse({
    allowExternalActions: false,
    channels: {
      browser,
      email,
      telegram
    },
    containsSensitiveRawData: false,
    createdAt: iso(now),
    includeBookingContext: true,
    preferenceId: "notification:preferences:notification",
    redactionLevel: "no_secrets",
    telegramCommandScope: "status_only"
  });
}

export function createSafeNotificationMessage(queueState: NotificationQueueState): SafeNotificationMessage {
  const candidate = queueState.latestSnapshot?.candidates[0] ?? null;
  const location = candidate ? candidate.consulateName : "configured location";
  const appointment = candidate
    ? `${candidate.appointmentDate}${candidate.appointmentTime ? ` ${candidate.appointmentTime}` : ""}`
    : "the fixture window";

  return SafeNotificationMessageSchema.parse({
    actionLabel: "Review candidate",
    body: `Candidate found for ${location} on ${appointment}. Review it in the tracker. No appointment action was taken.`,
    bookingLanguageStatus: "candidate_not_booked",
    containsBookingConfirmation: false,
    containsSensitiveRawData: false,
    messageIntent: "alert_only",
    title: "Visa appointment candidate found"
  });
}

function createNotificationEvent({
  guarded,
  now,
  queueState,
  traceId
}: {
  guarded: boolean;
  now: Date;
  queueState: NotificationQueueState;
  traceId: string;
}): NotificationEvent {
  const snapshotId = queueState.latestSnapshot?.snapshotId ?? null;
  return NotificationEventSchema.parse({
    channel: "browser",
    containsBookingConfirmation: false,
    createdAt: iso(now),
    deliveryStatus: guarded ? "suppressed" : "pending",
    eventType: queueState.latestSnapshot?.candidates.length ? "availability_detected" : "check_failed",
    messageIntent: "alert_only",
    notificationId: `notification:notification:${safeSuffix(snapshotId ?? queueState.generatedAt)}`,
    redactionLevel: "no_secrets",
    relatedSessionId: queueState.bookingAssistSession?.sessionId ?? null,
    relatedSnapshotId: snapshotId,
    traceId
  });
}

function createDelivery({
  attemptedAt,
  channel,
  enabled,
  guarded,
  notification,
  safeMessage
}: {
  attemptedAt: Date;
  channel: NotificationDeliveryResult["channel"];
  enabled: boolean;
  guarded: boolean;
  notification: NotificationEvent;
  safeMessage: SafeNotificationMessage;
}): NotificationDeliveryResult {
  const status = guarded || !enabled ? "suppressed" : channel === "browser" ? "sent" : "suppressed";
  const reason = guarded
    ? "spam_guard_cooldown"
    : !enabled
      ? "channel_disabled"
      : channel === "browser"
        ? "delivered"
        : "adapter_not_configured";

  return NotificationDeliveryResultSchema.parse({
    attemptedAt: iso(attemptedAt),
    channel,
    containsBookingConfirmation: false,
    containsSensitiveRawData: false,
    deliveryId: `delivery:notification:${channel}:${safeSuffix(notification.notificationId)}`,
    notificationId: notification.notificationId,
    providerMessageId: channel === "browser" && enabled ? `browser:${safeSuffix(notification.notificationId)}` : null,
    reason,
    safeMessage,
    status
  });
}

function createNotificationAudit({
  guarded,
  idempotencyKey,
  now,
  notification,
  traceId
}: {
  guarded: boolean;
  idempotencyKey: string;
  now: Date;
  notification: NotificationEvent;
  traceId: string;
}): AuditEvent {
  return AuditEventSchema.parse({
    action: "notification_queued",
    actorType: "notification",
    auditId: `audit:notification:${safeSuffix(notification.notificationId)}`,
    containsSensitiveRawData: false,
    idempotencyKey,
    occurredAt: iso(now),
    reason: guarded ? "policy_blocked" : "slots_found",
    redactionLevel: "no_secrets",
    result: guarded ? "cooldown" : "accepted",
    safeSummary: guarded
      ? "Fixture notification suppressed by spam guard cooldown; no booking action was taken."
      : "Fixture candidate notification queued without booking-confirmation language.",
    source: "service_worker",
    traceId
  });
}

export function createFixtureNotificationDispatch({
  idempotencyKey,
  now = new Date(),
  preferences = createNotificationPreferences(),
  queueState,
  traceId
}: {
  idempotencyKey: string;
  now?: Date;
  preferences?: NotificationPreference;
  queueState: NotificationQueueState;
  traceId: string;
}): NotificationDispatchBundle {
  const parsedPreferences = NotificationPreferenceSchema.parse(preferences);
  const guarded = queueState.notificationSpamGuard?.status === "guarded" || queueState.notificationSpamGuard?.status === "suppressed";
  const notification = createNotificationEvent({ guarded, now, queueState, traceId });
  const safeMessage = createSafeNotificationMessage(queueState);
  const deliveries = [
    createDelivery({
      attemptedAt: now,
      channel: "browser",
      enabled: parsedPreferences.channels.browser,
      guarded,
      notification,
      safeMessage
    }),
    createDelivery({
      attemptedAt: now,
      channel: "telegram",
      enabled: parsedPreferences.channels.telegram,
      guarded,
      notification,
      safeMessage
    }),
    createDelivery({
      attemptedAt: now,
      channel: "email",
      enabled: parsedPreferences.channels.email,
      guarded,
      notification,
      safeMessage
    })
  ];

  return NotificationDispatchBundleSchema.parse({
    auditEvent: createNotificationAudit({ guarded, idempotencyKey, now, notification, traceId }),
    deliveries,
    notification
  });
}

export function createTelegramCommandAudit({
  command,
  idempotencyKey,
  now = new Date(),
  traceId
}: {
  command: "status" | "open_browser" | "confirm_booking";
  idempotencyKey: string;
  now?: Date;
  traceId: string;
}): TelegramCommandAudit {
  const allowed = command === "status";
  const reason =
    command === "status"
      ? "status_only"
      : command === "open_browser"
        ? "browser_only_action"
        : "appointment_action_blocked";
  const auditEvent = AuditEventSchema.parse({
    action: allowed ? "check_requested" : "policy_rejected",
    actorType: "notification",
    auditId: `audit:notification:telegram:${safeSuffix(command)}:${safeSuffix(idempotencyKey)}`,
    containsSensitiveRawData: false,
    idempotencyKey,
    occurredAt: iso(now),
    reason: allowed ? "manual_check" : "policy_blocked",
    redactionLevel: "no_secrets",
    result: allowed ? "accepted" : "rejected",
    safeSummary: allowed
      ? "Telegram status command audited as read-only."
      : "Telegram command rejected because browser or appointment-changing authority stays in the browser.",
    source: "api",
    traceId
  });

  return TelegramCommandAuditSchema.parse({
    allowed,
    auditEvent,
    command,
    reason
  });
}
