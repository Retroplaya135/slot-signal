import assert from "node:assert/strict";
import {
  AlertDeliveryAckPayloadSchema,
  AlertDigestDeliveryAckResponseSchema,
  AlertDeliveryHistoryResponseSchema,
  AlertNotificationAdapterSandboxPayloadSchema,
  AlertNotificationProviderOutboxDeliverySchema,
  AlertNotificationProviderOutboxHistoryResponseSchema,
  AlertNotificationProviderOutboxPayloadSchema,
  AlertNotificationProviderOutboxResponseSchema,
  AlertNotificationAdapterSandboxResponseSchema,
  AlertNotificationAdapterSandboxHistoryResponseSchema,
  AlertNotificationAdapterSandboxDeliverySchema,
  AlertNotificationDigestResponseSchema,
  AlertNotificationQueueResponseSchema,
  AlertPendingCleanupResponseSchema,
  AlertSubscriptionDeleteResponseSchema,
  AlertSubscriptionListResponseSchema,
  AlertSubscriptionUpdateResponseSchema,
  buildAlertSubscriptionPayload,
  buildContributorIdentityPayload,
  buildContributorModerationNotePayload,
  buildPublicEstimateFixtureImportPayload,
  buildPublicEstimateSnapshotPayload,
  buildSlotReportContributionPayload,
  createPendingSlotAlertDeliveryPlan,
  createSlotReportApiClient,
  ContributorAbuseAuditResponseSchema,
  ContributorIdentityResponseSchema,
  ContributorModerationNoteCreateResponseSchema,
  ContributorModerationNotesResponseSchema,
  ContributorTrustResponseSchema,
  PublicEstimateFixtureImportResponseSchema,
  PublicContextSummaryResponseSchema,
  PublicEstimateLatestResponseSchema,
  PublicEstimateSnapshotCreateResponseSchema,
  ProviderDeliveryReadinessResponseSchema,
  SourcePolicyResponseSchema,
  SlotSignalDeleteResponseSchema,
  SlotSignalExportResponseSchema,
  SlotSignalRetentionPruneResponseSchema,
  SlotReportAlertDeliveryAckResponseSchema,
  SlotReportAlertSubscriptionPayloadSchema,
  SlotReportContributionPayloadSchema,
  validateSlotReportContributionDraft
} from "../dist/index.js";

const contribution = buildSlotReportContributionPayload({
  availableDatesText: "2026-06-18, 2026-06-12\n2026-06-18",
  capturedAt: "2026-05-07T22:30:00.000Z",
  country: "India",
  notes: "Visible schedule metadata only.",
  postCity: "Chennai",
  visaClass: "B1/B2"
});

assert.deepEqual(contribution.availableDates, ["2026-06-12", "2026-06-18"]);
assert.equal(contribution.sourceKind, "community_report");
assert.equal(contribution.confidence, "user_visible");
assert.equal(contribution.containsSensitiveRawData, false);
assert.equal(contribution.credentialDataIncluded, false);
assert.equal(contribution.portalAutomationUsed, false);
assert.equal(contribution.bookingActionTaken, false);
assert.doesNotThrow(() => SlotReportContributionPayloadSchema.parse(contribution));

const validDraft = validateSlotReportContributionDraft({
  availableDatesText: "2026-06-18, 2026-06-12\n2026-06-18",
  capturedAt: "2026-05-07T22:30:00.000Z",
  country: "India",
  notes: "Visible schedule metadata only.",
  postCity: "Chennai",
  visaClass: "B1/B2"
});
assert.equal(validDraft.valid, true);
assert.deepEqual(validDraft.normalizedDates, ["2026-06-12", "2026-06-18"]);
assert.equal(validDraft.payload?.portalAutomationUsed, false);

const sensitiveDraft = validateSlotReportContributionDraft({
  availableDatesText: "2026-06-18",
  capturedAt: "2026-05-07T22:30:00.000Z",
  country: "India",
  notes: "My OTP and cookie are here.",
  postCity: "Chennai",
  visaClass: "B1/B2"
});
assert.equal(sensitiveDraft.valid, false);
assert.deepEqual(sensitiveDraft.normalizedDates, ["2026-06-18"]);
assert.match(sensitiveDraft.errors.join(" "), /sensitive/i);

const invalidDateDraft = validateSlotReportContributionDraft({
  availableDatesText: "not a date",
  capturedAt: "2026-05-07T22:30:00.000Z",
  country: "India",
  postCity: "Chennai",
  visaClass: "B1/B2"
});
assert.equal(invalidDateDraft.valid, false);
assert.deepEqual(invalidDateDraft.normalizedDates, []);
assert.match(invalidDateDraft.errors.join(" "), /valid date/i);

assert.throws(
  () =>
    buildSlotReportContributionPayload({
      availableDatesText: "2026-06-18",
      capturedAt: "2026-05-07T22:30:00.000Z",
      country: "India",
      notes: "My OTP and cookie are here.",
      postCity: "Chennai",
      visaClass: "B1/B2"
    }),
  /sensitive/i
);

assert.throws(
  () =>
    buildSlotReportContributionPayload({
      availableDatesText: "not a date",
      capturedAt: "2026-05-07T22:30:00.000Z",
      country: "India",
      postCity: "Chennai",
      visaClass: "B1/B2"
    }),
  /valid date/i
);

const requests = [];
const mockDeliveryAudit = {
  acknowledgedAt: "2026-05-07T22:30:03.000Z",
  containsSensitiveRawData: false,
  deliveryAttemptedInBrowser: true,
  deliveryStatus: "sent",
  notificationEvent: {
    channel: "browser",
    containsBookingConfirmation: false,
    createdAt: "2026-05-07T22:30:02.000Z",
    deliveryStatus: "sent",
    eventType: "availability_detected",
    messageIntent: "alert_only",
    notificationId: "notification:slot-alert:test:001",
    redactionLevel: "no_secrets",
    relatedSessionId: null,
    relatedSnapshotId: "slot-report:test:001",
    traceId: "trace:slot-alert:test:001"
  },
  notificationId: "notification:slot-alert:test:001",
  reason: "browser_notification_created",
  reportId: "slot-report:test:001",
  subscriptionId: "slot-alert:test:001"
};
const mockSlotReportResponse = {
  ...contribution,
  availabilityClaim: "community_report_not_official_confirmation",
  contributorId: null,
  freshUntil: "2026-05-08T04:30:00.000Z",
  freshness: "fresh",
  reportId: "slot-report:test:001",
  storedAt: "2026-05-07T22:30:01.000Z",
  trust: {
    conflictingReportIds: [],
    dedupeKey: "slot-report-dedupe:india:chennai:b1-b2:2026-06-12:2026-06-18",
    duplicateOfReportId: null,
    eligibleForNotification: true,
    provenance: {
      availabilityClaim: "community_report_not_official_confirmation",
      capturedAt: "2026-05-07T22:30:00.000Z",
      confidence: "user_visible",
      contributorId: null,
      country: "India",
      officialAvailabilitySource: false,
      postCity: "Chennai",
      sourceKind: "community_report",
      submittedAt: "2026-05-07T22:30:01.000Z",
      visaClass: "B1/B2"
    },
    status: "accepted_unique",
    visibleMetadataOnly: true
  }
};
const mockSubscription = {
  active: true,
  channels: ["browser"],
  cooldownMinutes: 15,
  country: "India",
  createdAt: "2026-05-07T22:30:01.000Z",
  deletedAt: null,
  deliveryMode: "immediate",
  digestWindowMinutes: 60,
  lastNotificationAt: null,
  pausedAt: null,
  postCities: ["Chennai"],
  status: "active",
  subscriptionId: "slot-alert:test:001",
  targetEndDate: "2026-06-30",
  targetStartDate: "2026-06-01",
  updatedAt: "2026-05-07T22:30:01.000Z",
  visaClasses: ["B1/B2"]
};
const mockSubscriptionAudit = {
  action: "created",
  auditReason: null,
  containsSensitiveRawData: false,
  recordedAt: "2026-05-07T22:30:01.000Z",
  subscriptionId: "slot-alert:test:001"
};
const mockPublicEstimate = {
  availabilityClaim: "public_estimate_not_slot_availability",
  capturedAt: "2026-05-07T22:30:00.000Z",
  containsSensitiveRawData: false,
  country: "India",
  estimateId: "public-estimate:test:001",
  estimateLabel: "Visitor visa interview wait time",
  estimateValueDays: 120,
  freshUntil: "2026-05-08T22:30:00.000Z",
  freshnessLabel: "fresh",
  parserStatus: "parsed",
  parserVersion: "manual-public-estimate-v1",
  postCity: "Chennai",
  quarantineReason: null,
  sourceName: "Public estimate",
  sourcePermission: "public_estimate_context",
  sourceUrl: "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
  status: "accepted",
  storedAt: "2026-05-07T22:30:01.000Z",
  triggersSlotAlerts: false,
  visaClass: "B1/B2"
};
const mockSourcePolicy = {
  appointmentChangingActionAllowed: false,
  checkedAt: "2026-05-08T20:00:00.000Z",
  containsSensitiveRawData: false,
  credentialAccessAllowed: false,
  livePortalAutomationAllowed: false,
  records: [
    {
      alertEligibility: "alert_allowed",
      allowedInMvp: true,
      appointmentChangingActionAllowed: false,
      canTriggerSlotAlerts: true,
      credentialAccessAllowed: false,
      officialAvailabilitySource: false,
      policyReason: "Community reports are sanitized visible metadata and may trigger alerts after quality checks.",
      portalAutomationAllowed: false,
      proofGate: "quality_and_source_policy",
      requiresWrittenAuthorization: false,
      sourceKind: "community_report",
      sourceLane: "community_signal"
    },
    {
      alertEligibility: "alert_allowed",
      allowedInMvp: true,
      appointmentChangingActionAllowed: false,
      canTriggerSlotAlerts: true,
      credentialAccessAllowed: false,
      officialAvailabilitySource: false,
      policyReason: "Manual reports are user-visible metadata and may trigger alerts after quality checks.",
      portalAutomationAllowed: false,
      proofGate: "quality_and_source_policy",
      requiresWrittenAuthorization: false,
      sourceKind: "manual_report",
      sourceLane: "manual_visible_metadata"
    },
    {
      alertEligibility: "context_only",
      allowedInMvp: true,
      appointmentChangingActionAllowed: false,
      canTriggerSlotAlerts: false,
      credentialAccessAllowed: false,
      officialAvailabilitySource: false,
      policyReason: "Public estimates provide context only and never slot availability.",
      portalAutomationAllowed: false,
      proofGate: "public_context_no_alert",
      requiresWrittenAuthorization: false,
      sourceKind: "public_estimate",
      sourceLane: "public_context"
    },
    {
      alertEligibility: "sandbox_only",
      allowedInMvp: true,
      appointmentChangingActionAllowed: false,
      canTriggerSlotAlerts: false,
      credentialAccessAllowed: false,
      officialAvailabilitySource: false,
      policyReason: "Sandbox adapter payloads are reviewer artifacts and cannot create new alerts.",
      portalAutomationAllowed: false,
      proofGate: "adapter_sandbox_no_delivery",
      requiresWrittenAuthorization: false,
      sourceKind: "notification_adapter_sandbox",
      sourceLane: "sandbox_payload"
    },
    {
      alertEligibility: "blocked_pending_authorization",
      allowedInMvp: false,
      appointmentChangingActionAllowed: false,
      canTriggerSlotAlerts: false,
      credentialAccessAllowed: false,
      officialAvailabilitySource: false,
      policyReason: "Partner/API sources need written authorization before alert eligibility.",
      portalAutomationAllowed: false,
      proofGate: "written_source_authorization_required",
      requiresWrittenAuthorization: true,
      sourceKind: "authorized_partner_api",
      sourceLane: "authorized_source_pending_evidence"
    }
  ]
};
const mockContributorModerationNote = {
  containsSensitiveRawData: false,
  contributorId: "contributor:visible-001",
  note: "Local review: restricted after non-PII abuse-review evidence.",
  noteId: "contributor-note:test:001",
  reason: "rate_limit_review",
  recordedAt: "2026-05-07T22:30:05.000Z",
  reviewStatus: "restricted"
};
const mockContributorIdentity = {
  containsSensitiveRawData: false,
  contributorId: "contributor:visible-001",
  contributorKeyId: "contributor-key:visible-001",
  createdAt: "2026-05-07T22:30:00.000Z",
  firstSeenAt: "2026-05-07T22:30:00.000Z",
  identityHealth: "stable",
  lastSeenAt: "2026-05-07T22:30:06.000Z",
  piiStored: false,
  proofKind: "opaque_local_key",
  rotationCount: 0,
  rotationWarning: false,
  storageScope: "extension_local_storage"
};
const mockContributorIdentityAudit = {
  action: "seen",
  containsSensitiveRawData: false,
  contributorId: "contributor:visible-001",
  contributorKeyId: "contributor-key:visible-001",
  previousContributorKeyId: null,
  recordedAt: "2026-05-07T22:30:06.000Z",
  rotationCount: 0
};
const mockDigestDeliveryAck = {
  acknowledgedAt: "2026-05-07T22:30:07.000Z",
  acknowledgedCount: 1,
  containsSensitiveRawData: false,
  deliveryAudits: [
    {
      ...mockDeliveryAudit,
      acknowledgedAt: "2026-05-07T22:30:07.000Z",
      deliveryAttemptedInBrowser: false,
      reason: "digest_summary_sent"
    }
  ],
  deliveryStatus: "sent",
  reason: "digest_summary_sent",
  replayedCount: 0,
  subscriptionId: "slot-alert:test:001"
};
const mockNotificationAdapterSandboxPayload = {
  actionLabel: "Open tracker",
  adapterMode: "sandbox_only",
  availabilityClaim: "community_report_not_official_confirmation",
  body: "Chennai B1/B2 community availability includes 2026-06-12. Review the community report. No appointment action was taken.",
  channel: "email",
  containsBookingConfirmation: false,
  containsSensitiveRawData: false,
  country: "India",
  externalNetworkCallAttempted: false,
  matchedDates: ["2026-06-12"],
  postCity: "Chennai",
  providerEndpoint: "not_called",
  recipientRef: "sandbox-recipient:email:local-reviewer",
  redactionLevel: "no_secrets",
  title: "Community visa slot report",
  unsubscribeAction: "pause_or_delete_filter",
  visaClass: "B1/B2"
};
const mockProviderOutboxPayload = {
  actionLabel: "Open tracker",
  adapterMode: "provider_safe_outbox",
  availabilityClaim: "community_report_not_official_confirmation",
  body: "Chennai B1/B2 community availability includes 2026-06-12. Provider delivery is disabled by default.",
  channel: "email",
  containsBookingConfirmation: false,
  containsSensitiveRawData: false,
  country: "India",
  externalNetworkCallAttempted: false,
  matchedDates: ["2026-06-12"],
  postCity: "Chennai",
  providerEndpoint: "disabled_by_default",
  recipientRef: "redacted-recipient:email:local-reviewer",
  redactionLevel: "no_secrets",
  retryBackoffSeconds: 60,
  title: "Community visa slot report",
  unsubscribeAction: "pause_or_delete_filter",
  visaClass: "B1/B2"
};
const mockProviderOutboxDelivery = {
  channel: "email",
  containsSensitiveRawData: false,
  externalDeliveryEnabled: false,
  externalNetworkCallAttempted: false,
  liveProviderConfigured: false,
  notificationId: "notification:slot-alert:test:001",
  outboxDeliveryId: "provider-outbox:test:001",
  payload: mockProviderOutboxPayload,
  reason: "provider_disabled_by_default",
  recordedAt: "2026-05-07T22:30:09.000Z",
  reportId: "slot-report:test:001",
  status: "queued_disabled",
  subscriptionId: "slot-alert:test:001"
};
const mockProviderReadiness = {
  blockedReasons: ["external_provider_delivery_disabled_by_default", "provider_credentials_not_configured"],
  checkedAt: "2026-05-07T22:30:09.000Z",
  containsSensitiveRawData: false,
  credentialStorageMode: "not_configured",
  deliveryBoundary: "browser_digest_primary_provider_outbox_disabled",
  externalNetworkCallAttempted: false,
  externalProviderDeliveryEnabled: false,
  liveProviderConfigured: false,
  nextRequiredProof: "delivery_readiness_provider_configuration_not_implemented",
  providerChannels: ["email", "telegram", "slack"],
  providerSafeOutboxEnabled: true,
  safeDefaultDeliveryModes: ["browser", "digest"]
};
const mockNotificationAdapterSandboxDelivery = {
  channel: "email",
  containsSensitiveRawData: false,
  externalNetworkCallAttempted: false,
  liveProviderConfigured: false,
  notificationId: "notification:slot-alert:test:001",
  payload: mockNotificationAdapterSandboxPayload,
  reason: "sandbox_payload_recorded",
  recordedAt: "2026-05-07T22:30:08.000Z",
  reportId: "slot-report:test:001",
  sandboxDeliveryId: "sandbox-delivery:test:001",
  status: "recorded",
  subscriptionId: "slot-alert:test:001"
};
const mockSlackNotificationAdapterSandboxDelivery = {
  ...mockNotificationAdapterSandboxDelivery,
  channel: "slack",
  payload: {
    ...mockNotificationAdapterSandboxPayload,
    channel: "slack",
    recipientRef: "sandbox-recipient:slack:local-reviewer"
  },
  sandboxDeliveryId: "sandbox-delivery:test:slack"
};
const mockPublicContextSummary = {
  containsSensitiveRawData: false,
  contexts: [
    {
      acceptedEstimateCount: 2,
      alertTriggerAllowed: false,
      availabilityClaim: "public_context_not_slot_availability",
      contextId: "public-context:india:chennai:b1-b2",
      country: "India",
      freshUntil: "2026-05-08T22:30:00.000Z",
      freshnessLabel: "mixed",
      latestCapturedAt: "2026-05-07T22:30:00.000Z",
      latestEstimateLabel: "Visitor visa interview wait time",
      latestEstimateValueDays: 120,
      parserStatuses: ["parsed", "source_stale", "parser_failed"],
      postCity: "Chennai",
      quarantinedEstimateCount: 1,
      recommendedUse: "decision_context_only",
      reviewNote: "public_context_not_appointment_inventory",
      slotAlertTriggerAttempted: false,
      sourceKind: "public_estimate",
      sourceNames: ["Department of State Global Visa Wait Times"],
      sourceUrls: ["https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html"],
      staleEstimateCount: 1,
      status: "mixed",
      totalEstimateCount: 3,
      triggersSlotAlerts: false,
      visaClass: "B1/B2"
    }
  ],
  liveFetchAttempted: false,
  quarantinedContextCount: 1,
  slotAlertsDelivered: false,
  slotAlertTriggerAttempted: false,
  sourcePolicy: mockSourcePolicy.records.find((record) => record.sourceKind === "public_estimate")
};
const client = createSlotReportApiClient({
  apiBaseUrl: "http://127.0.0.1:8000/v1",
  authToken: "client-token",
  fetcher: async (url, init) => {
    requests.push({ init, url });
    if (String(url).endsWith("/source-policy")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockSourcePolicy
      };
    }
    if (String(url).endsWith("/alert-notifications/provider-readiness")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockProviderReadiness
      };
    }
    if (String(url).endsWith("/alert-notifications/provider-outbox") && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          adapterMode: "provider_safe_outbox",
          containsSensitiveRawData: false,
          countsByStatus: {
            queued_disabled: 1,
            skipped: 0,
            suppressed: 0
          },
          deliveries: [mockProviderOutboxDelivery],
          externalDeliveryEnabled: false,
          externalNetworkCallAttempted: false,
          liveProviderConfigured: false,
          slotAlertsDelivered: false
        })
      };
    }
    if (String(url).endsWith("/alert-notifications/provider-outbox/history")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          countsByStatus: {
            queued_disabled: 1,
            skipped: 0,
            suppressed: 0
          },
          deliveries: [mockProviderOutboxDelivery],
          externalDeliveryEnabled: false,
          externalNetworkCallAttempted: false,
          liveProviderConfigured: false,
          slotAlertsDelivered: false
        })
      };
    }
    if (String(url).endsWith("/alert-notifications/delivery-history")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvents: [mockDeliveryAudit],
          containsSensitiveRawData: false,
          countsByStatus: {
            failed: 0,
            sent: 1,
            suppressed: 0
          }
        })
      };
    }
    if (String(url).endsWith("/alert-notifications/adapter-sandbox") && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          adapterMode: "sandbox_only",
          containsSensitiveRawData: false,
          countsByStatus: {
            recorded: 1,
            skipped: 0,
            suppressed: 0
          },
          deliveries: [mockNotificationAdapterSandboxDelivery],
          externalNetworkCallAttempted: false,
          liveProviderConfigured: false,
          slotAlertsDelivered: false
        })
      };
    }
    if (String(url).startsWith("http://127.0.0.1:8000/v1/public-context/summary")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockPublicContextSummary
      };
    }
    if (String(url).endsWith("/alert-notifications/adapter-sandbox/history")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          countsByStatus: {
            recorded: 1,
            skipped: 0,
            suppressed: 0
          },
          deliveries: [mockNotificationAdapterSandboxDelivery],
          externalNetworkCallAttempted: false,
          liveProviderConfigured: false,
          slotAlertsDelivered: false
        })
      };
    }
    if (String(url).endsWith("/slot-signal/export")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          appointmentChangingActionTaken: false,
          containsSensitiveRawData: false,
          contributorIdentities: [mockContributorIdentity],
          contributorIdentityAuditEvents: [mockContributorIdentityAudit],
          contributorModerationNotes: [mockContributorModerationNote],
          deliveryAuditEvents: [mockDeliveryAudit],
          exportedAt: "2026-05-07T22:30:04.000Z",
          livePortalRequestMade: false,
          pendingMatches: [],
          publicEstimates: [mockPublicEstimate],
          reports: [mockSlotReportResponse],
          safeSummary: "Redacted slot-signal export; community metadata only.",
          schemaVersion: 5,
          subscriptions: [mockSubscription]
        })
      };
    }
    if (String(url).includes("/slot-signal/reports/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          deleted: true,
          deletedDeliveryAuditEvents: 1,
          deletedPendingMatches: 1,
          deletedReports: 1,
          reportId: "slot-report:test:001",
          retentionAction: "manual_delete"
        })
      };
    }
    if (String(url).endsWith("/slot-signal/retention/prune")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          cutoffBefore: "2026-05-01T00:00:00.000Z",
          deletedDeliveryAuditEvents: 0,
          deletedPendingMatches: 0,
          deletedReports: 0,
          dryRun: true,
          matchedReports: 2,
          retentionAction: "retention_prune"
        })
      };
    }
    if (String(url).endsWith("/alert-subscriptions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          initialMatches: [],
          subscription: mockSubscription
        })
      };
    }
    if (String(url).startsWith("http://127.0.0.1:8000/v1/alert-subscriptions?includeDeleted=true")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvents: [mockSubscriptionAudit],
          subscriptions: [mockSubscription]
        })
      };
    }
    if (String(url).includes("/alert-subscriptions/slot-alert%3Atest%3A001") && init?.method === "PATCH") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvent: { ...mockSubscriptionAudit, action: "paused", auditReason: "pause test" },
          subscription: { ...mockSubscription, active: false, pausedAt: "2026-05-07T22:30:05.000Z", status: "paused" }
        })
      };
    }
    if (String(url).includes("/alert-subscriptions/slot-alert%3Atest%3A001") && init?.method === "DELETE") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvent: { ...mockSubscriptionAudit, action: "deleted", auditReason: "user unsubscribed" },
          deleted: true,
          removedPendingMatches: 0,
          subscription: {
            ...mockSubscription,
            active: false,
            deletedAt: "2026-05-07T22:30:06.000Z",
            status: "deleted"
          }
        })
      };
    }
    if (String(url).endsWith("/alert-notifications/digest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          groups: [
            {
              deliveryMode: "digest",
              digestWindowMinutes: 60,
              latestMatchedAt: "2026-05-07T22:30:02.000Z",
              matches: [],
              pendingCount: 1,
              subscriptionId: "slot-alert:test:001"
            }
          ],
          slotAlertsDelivered: false
        })
      };
    }
    if (String(url).includes("/alert-notifications/digest/slot-alert%3Atest%3A001/delivery-ack")) {
      return {
        ok: true,
        status: 200,
        json: async () => mockDigestDeliveryAck
      };
    }
    if (String(url).endsWith("/alert-notifications/pending/cleanup")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          checkedAt: "2026-05-08T15:00:00.000Z",
          cleanupReason: "stale_pending_cleanup",
          containsSensitiveRawData: false,
          deletedPendingMatches: 1,
          dryRun: false,
          matchedPendingMatches: 1
        })
      };
    }
    if (String(url).includes("/alert-notifications/pending") && !String(url).includes("/cleanup")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pendingMatches: [
            {
              availabilityClaim: "community_report_not_official_confirmation",
              deliveryMode: "immediate",
              digestWindowMinutes: 60,
              lastDeliveryAttemptAt: null,
              matchedDates: ["2026-06-12"],
              nextRetryAt: null,
              notificationEvent: {
                channel: "browser",
                containsBookingConfirmation: false,
                createdAt: "2026-05-07T22:30:02.000Z",
                deliveryStatus: "pending",
                eventType: "availability_detected",
                messageIntent: "alert_only",
                notificationId: "notification:slot-alert:test:001",
                redactionLevel: "no_secrets",
                relatedSessionId: null,
                relatedSnapshotId: "slot-report:test:001",
                traceId: "trace:slot-alert:test:001"
              },
              notificationReason: "fresh_community_report_matches_filter",
              reportId: "slot-report:test:001",
              reportTrust: {
                conflictingReportIds: [],
                dedupeKey: "slot-report-dedupe:india:chennai:b1-b2:2026-06-12",
                duplicateOfReportId: null,
                eligibleForNotification: true,
                provenance: {
                  availabilityClaim: "community_report_not_official_confirmation",
                  capturedAt: "2026-05-07T22:30:00.000Z",
                  confidence: "user_visible",
                  contributorId: null,
                  country: "India",
                  officialAvailabilitySource: false,
                  postCity: "Chennai",
                  sourceKind: "community_report",
                  submittedAt: "2026-05-07T22:30:01.000Z",
                  visaClass: "B1/B2"
                },
                status: "accepted_unique",
                visibleMetadataOnly: true
              },
              retryAttemptCount: 0,
              subscriptionId: "slot-alert:test:001"
            }
          ]
        })
      };
    }
    if (String(url).endsWith("/delivery-ack")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          deliveryAudit: {
            ...mockDeliveryAudit
          },
          notificationEvent: {
            channel: "browser",
            containsBookingConfirmation: false,
            createdAt: "2026-05-07T22:30:02.000Z",
            deliveryStatus: "sent",
            eventType: "availability_detected",
            messageIntent: "alert_only",
            notificationId: "notification:slot-alert:test:001",
            redactionLevel: "no_secrets",
            relatedSessionId: null,
            relatedSnapshotId: "slot-report:test:001",
            traceId: "trace:slot-alert:test:001"
          },
          replayed: false
        })
      };
    }
    if (String(url).startsWith("http://127.0.0.1:8000/v1/slot-reports/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          reports: [
            {
              ...mockSlotReportResponse,
              matchedDates: ["2026-06-12"],
            }
          ]
        })
      };
    }
    if (String(url).endsWith("/contributors/contributor%3Avisible-001/trust")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trust: {
            acceptedUniqueReports: 1,
            abuseAuditEventCount: 2,
            abuseReviewRequired: false,
            conflictQuorumPolicy: {
              currentIndependentContributors: 2,
              met: true,
              requiredIndependentContributors: 2
            },
            conflictReports: 0,
            contributorId: "contributor:visible-001",
            duplicateReports: 1,
            identityHealth: "stable",
            identityRotationWarning: false,
            localReviewStatus: "restricted",
            localIdentitySeen: true,
            moderationNoteCount: 1,
            notificationEligibleReports: 1,
            piiStored: false,
            rateLimitPolicy: {
              currentWindowReports: 2,
              limited: false,
              maxReports: 5,
              windowHours: 1
            },
            recentReportCount: 2,
            reputationStatus: "restricted",
            staleReports: 0,
            totalReports: 2
          }
        })
      };
    }
    if (String(url).endsWith("/contributors/contributor%3Avisible-001/identity")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvents: [mockContributorIdentityAudit],
          containsSensitiveRawData: false,
          identity: mockContributorIdentity
        })
      };
    }
    if (String(url).endsWith("/contributors/contributor%3Avisible-001/abuse-audit")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          auditEvents: [
            {
              action: "report_accepted",
              containsSensitiveRawData: false,
              contributorId: "contributor:visible-001",
              limitMaxReports: 5,
              limitWindowHours: 1,
              reason: "accepted_under_rate_limit",
              recentReportCount: 1,
              recordedAt: "2026-05-07T22:30:01.000Z"
            }
          ],
          containsSensitiveRawData: false
        })
      };
    }
    if (String(url).endsWith("/contributors/contributor%3Avisible-001/moderation-notes") && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          note: mockContributorModerationNote
        })
      };
    }
    if (String(url).endsWith("/contributors/contributor%3Avisible-001/moderation-notes")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          containsSensitiveRawData: false,
          notes: [mockContributorModerationNote]
        })
      };
    }
    if (String(url).endsWith("/public-estimates/snapshots")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          snapshot: mockPublicEstimate
        })
      };
    }
    if (String(url).endsWith("/public-estimates/import-fixture")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          adapterMode: "fixture_replay",
          allowlistStatus: "allowlisted",
          liveFetchAttempted: false,
          parserDriftDetected: false,
          quarantineByDefault: true,
          sourceId: "travel_state_global_wait_times",
          slotAlertTriggerAttempted: false,
          snapshot: mockPublicEstimate
        })
      };
    }
    if (String(url).startsWith("http://127.0.0.1:8000/v1/public-estimates/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          estimates: [mockPublicEstimate],
          quarantinedCount: 1
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...mockSlotReportResponse
      })
    };
  }
});
const response = await client.submitSlotReport(contribution);

assert.equal(response.reportId, "slot-report:test:001");
assert.equal(response.trust.status, "accepted_unique");
assert.equal(response.trust.provenance.officialAvailabilitySource, false);
assert.equal(requests[0].url, "http://127.0.0.1:8000/v1/slot-reports");
assert.equal(requests[0].init.method, "POST");
assert.equal(requests[0].init.headers["Content-Type"], "application/json");
assert.equal(requests[0].init.headers.Authorization, "Bearer client-token");
assert.equal(JSON.parse(requests[0].init.body).portalAutomationUsed, false);

const subscriptionPayload = buildAlertSubscriptionPayload({
  availableDates: response.availableDates,
  country: response.country,
  postCity: response.postCity,
  visaClass: response.visaClass
});
assert.doesNotThrow(() => SlotReportAlertSubscriptionPayloadSchema.parse(subscriptionPayload));
assert.deepEqual(subscriptionPayload.channels, ["browser"]);
assert.equal(subscriptionPayload.cooldownMinutes, 15);
assert.equal(subscriptionPayload.deliveryMode, "immediate");
assert.equal(subscriptionPayload.digestWindowMinutes, 60);
assert.equal(subscriptionPayload.targetStartDate, "2026-06-12");
assert.equal(subscriptionPayload.targetEndDate, "2026-06-18");

const subscription = await client.createAlertSubscription(subscriptionPayload);
assert.equal(subscription.subscription.subscriptionId, "slot-alert:test:001");
assert.equal(requests[1].url, "http://127.0.0.1:8000/v1/alert-subscriptions");

const pending = await client.fetchPendingAlertNotifications();
assert.doesNotThrow(() => AlertNotificationQueueResponseSchema.parse(pending));
assert.equal(pending.pendingMatches[0].reportTrust.visibleMetadataOnly, true);
assert.equal(pending.pendingMatches[0].reportTrust.eligibleForNotification, true);
assert.equal(requests[2].url, "http://127.0.0.1:8000/v1/alert-notifications/pending");

const deliveryPlan = createPendingSlotAlertDeliveryPlan({
  deliveredNotificationIds: new Set(["notification:already:sent"]),
  pendingMatches: pending.pendingMatches
});
assert.equal(deliveryPlan.deliveries.length, 1);
assert.equal(deliveryPlan.suppressed.length, 0);
assert.equal(deliveryPlan.deliveries[0].safeMessage.title, "Community visa slot report");
assert.match(deliveryPlan.deliveries[0].safeMessage.body, /Chennai/);
assert.equal(deliveryPlan.deliveries[0].safeMessage.containsBookingConfirmation, false);

const duplicatePlan = createPendingSlotAlertDeliveryPlan({
  deliveredNotificationIds: new Set(["notification:slot-alert:test:001"]),
  pendingMatches: pending.pendingMatches
});
assert.equal(duplicatePlan.deliveries.length, 0);
assert.equal(duplicatePlan.suppressed[0].reason, "already_delivered");

const digestSuppressionPlan = createPendingSlotAlertDeliveryPlan({
  deliveredNotificationIds: new Set(),
  pendingMatches: [{ ...pending.pendingMatches[0], deliveryMode: "digest" }]
});
assert.equal(digestSuppressionPlan.deliveries.length, 0);
assert.equal(digestSuppressionPlan.suppressed[0].reason, "digest_mode_deferred");

const retrySuppressionPlan = createPendingSlotAlertDeliveryPlan({
  deliveredNotificationIds: new Set(),
  now: new Date("2026-05-07T22:30:03.000Z"),
  pendingMatches: [{ ...pending.pendingMatches[0], nextRetryAt: "2026-05-07T22:31:03.000Z", retryAttemptCount: 1 }]
});
assert.equal(retrySuppressionPlan.deliveries.length, 0);
assert.equal(retrySuppressionPlan.suppressed[0].reason, "retry_backoff_active");

const ackPayload = AlertDeliveryAckPayloadSchema.parse({
  acknowledgedAt: "2026-05-07T22:30:03.000Z",
  containsSensitiveRawData: false,
  deliveryAttemptedInBrowser: true,
  deliveryStatus: "sent",
  reason: "browser_notification_created"
});
const ack = await client.acknowledgeAlertDelivery("notification:slot-alert:test:001", ackPayload);
assert.doesNotThrow(() => SlotReportAlertDeliveryAckResponseSchema.parse(ack));
assert.equal(ack.notificationEvent.deliveryStatus, "sent");
assert.equal(ack.deliveryAudit.reason, "browser_notification_created");
assert.equal(requests[3].url, "http://127.0.0.1:8000/v1/alert-notifications/notification%3Aslot-alert%3Atest%3A001/delivery-ack");

const latestReports = await client.fetchLatestSlotReports({
  country: "India",
  includeLowTrust: true,
  includeStale: true,
  postCity: "Chennai",
  targetEndDate: "2026-06-30",
  targetStartDate: "2026-06-01",
  visaClass: "B1/B2"
});
assert.equal(latestReports.reports.length, 1);
assert.equal(latestReports.reports[0].matchedDates[0], "2026-06-12");
assert.match(requests[4].url, /includeLowTrust=true/);
assert.match(requests[4].url, /includeStale=true/);

const deliveryHistory = await client.fetchAlertDeliveryHistory();
assert.doesNotThrow(() => AlertDeliveryHistoryResponseSchema.parse(deliveryHistory));
assert.equal(deliveryHistory.countsByStatus.sent, 1);
assert.equal(requests[5].url, "http://127.0.0.1:8000/v1/alert-notifications/delivery-history");

const slotSignalExport = await client.exportSlotSignalRecords();
assert.doesNotThrow(() => SlotSignalExportResponseSchema.parse(slotSignalExport));
assert.equal(slotSignalExport.containsSensitiveRawData, false);
assert.equal(slotSignalExport.publicEstimates[0].triggersSlotAlerts, false);
assert.equal(slotSignalExport.reports[0].reportId, "slot-report:test:001");
assert.equal(requests[6].url, "http://127.0.0.1:8000/v1/slot-signal/export");

const deleteResponse = await client.deleteSlotSignalReport("slot-report:test:001");
assert.doesNotThrow(() => SlotSignalDeleteResponseSchema.parse(deleteResponse));
assert.equal(deleteResponse.deletedReports, 1);
assert.equal(requests[7].url, "http://127.0.0.1:8000/v1/slot-signal/reports/slot-report%3Atest%3A001");

const pruneResponse = await client.pruneSlotSignalRecords({
  cutoffBefore: "2026-05-01T00:00:00.000Z",
  dryRun: true
});
assert.doesNotThrow(() => SlotSignalRetentionPruneResponseSchema.parse(pruneResponse));
assert.equal(pruneResponse.matchedReports, 2);
assert.equal(requests[8].url, "http://127.0.0.1:8000/v1/slot-signal/retention/prune");

const subscriptionList = await client.fetchAlertSubscriptions(true);
assert.doesNotThrow(() => AlertSubscriptionListResponseSchema.parse(subscriptionList));
assert.equal(subscriptionList.subscriptions[0].status, "active");
assert.equal(requests[9].url, "http://127.0.0.1:8000/v1/alert-subscriptions?includeDeleted=true");

const pausedSubscription = await client.updateAlertSubscription("slot-alert:test:001", {
  active: false,
  auditReason: "pause test",
  containsSensitiveRawData: false
});
assert.doesNotThrow(() => AlertSubscriptionUpdateResponseSchema.parse(pausedSubscription));
assert.equal(pausedSubscription.auditEvent.action, "paused");
assert.equal(requests[10].init.method, "PATCH");

const deletedSubscription = await client.deleteAlertSubscription("slot-alert:test:001");
assert.doesNotThrow(() => AlertSubscriptionDeleteResponseSchema.parse(deletedSubscription));
assert.equal(deletedSubscription.subscription.status, "deleted");
assert.equal(requests[11].init.method, "DELETE");

const contributorTrust = await client.fetchContributorTrust("contributor:visible-001");
assert.doesNotThrow(() => ContributorTrustResponseSchema.parse(contributorTrust));
assert.equal(contributorTrust.trust.piiStored, false);
assert.equal(contributorTrust.trust.conflictQuorumPolicy.met, true);
assert.equal(contributorTrust.trust.localIdentitySeen, true);
assert.equal(contributorTrust.trust.identityHealth, "stable");
assert.equal(contributorTrust.trust.localReviewStatus, "restricted");
assert.equal(contributorTrust.trust.moderationNoteCount, 1);

const contributorIdentityPayload = buildContributorIdentityPayload({
  contributorKeyId: "contributor-key:visible-001",
  createdAt: "2026-05-07T22:30:00.000Z",
  lastSeenAt: "2026-05-07T22:30:06.000Z",
  rotationCount: 0
});
assert.equal(contributorIdentityPayload.containsSensitiveRawData, false);
assert.equal(contributorIdentityPayload.piiStored, false);
const contributorIdentity = await client.upsertContributorIdentity("contributor:visible-001", contributorIdentityPayload);
assert.doesNotThrow(() => ContributorIdentityResponseSchema.parse(contributorIdentity));
assert.equal(contributorIdentity.identity.contributorKeyId, "contributor-key:visible-001");
const contributorIdentityReadback = await client.fetchContributorIdentity("contributor:visible-001");
assert.doesNotThrow(() => ContributorIdentityResponseSchema.parse(contributorIdentityReadback));
assert.equal(contributorIdentityReadback.auditEvents[0].containsSensitiveRawData, false);
assert.throws(
  () =>
    buildContributorIdentityPayload({
      contributorKeyId: "person@example.com",
      createdAt: "2026-05-07T22:30:00.000Z",
      rotationCount: 0
    }),
  /invalid|regular expression|string/i
);

const publicEstimatePayload = buildPublicEstimateSnapshotPayload({
  country: "India",
  estimateLabel: "Visitor visa interview wait time",
  estimateValueDays: 120,
  freshUntil: "2026-05-08T22:30:00.000Z",
  postCity: "Chennai",
  sourceUrl: "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
  visaClass: "B1/B2"
});
assert.equal(publicEstimatePayload.triggersSlotAlerts, false);
const publicEstimate = await client.submitPublicEstimateSnapshot(publicEstimatePayload);
assert.doesNotThrow(() => PublicEstimateSnapshotCreateResponseSchema.parse(publicEstimate));
assert.equal(publicEstimate.snapshot.availabilityClaim, "public_estimate_not_slot_availability");

const publicEstimates = await client.fetchLatestPublicEstimates({
  country: "India",
  includeQuarantined: true,
  postCity: "Chennai"
});
assert.doesNotThrow(() => PublicEstimateLatestResponseSchema.parse(publicEstimates));
assert.equal(publicEstimates.estimates[0].triggersSlotAlerts, false);
assert.match(requests[16].url, /includeQuarantined=true/);

const abuseAudit = await client.fetchContributorAbuseAudit("contributor:visible-001");
assert.doesNotThrow(() => ContributorAbuseAuditResponseSchema.parse(abuseAudit));
assert.equal(abuseAudit.containsSensitiveRawData, false);
assert.equal(abuseAudit.auditEvents[0].reason, "accepted_under_rate_limit");

const moderationNotePayload = buildContributorModerationNotePayload({
  note: "Local review: restricted after non-PII abuse-review evidence.",
  reason: "rate_limit_review",
  reviewStatus: "restricted"
});
assert.equal(moderationNotePayload.containsSensitiveRawData, false);
const moderationNote = await client.addContributorModerationNote("contributor:visible-001", moderationNotePayload);
assert.doesNotThrow(() => ContributorModerationNoteCreateResponseSchema.parse(moderationNote));
assert.equal(moderationNote.note.reviewStatus, "restricted");
const moderationNotes = await client.fetchContributorModerationNotes("contributor:visible-001");
assert.doesNotThrow(() => ContributorModerationNotesResponseSchema.parse(moderationNotes));
assert.equal(moderationNotes.containsSensitiveRawData, false);
assert.equal(moderationNotes.notes[0].reason, "rate_limit_review");
assert.throws(
  () =>
    buildContributorModerationNotePayload({
      note: "Email person@example.com and OTP copied here.",
      reason: "manual_review",
      reviewStatus: "watch"
    }),
  /sensitive|contact/i
);

const digestQueue = await client.fetchDigestAlertNotifications();
assert.doesNotThrow(() => AlertNotificationDigestResponseSchema.parse(digestQueue));
assert.equal(digestQueue.slotAlertsDelivered, false);
assert.equal(digestQueue.groups[0].deliveryMode, "digest");
const digestAck = await client.acknowledgeDigestDelivery("slot-alert:test:001", {
  acknowledgedAt: "2026-05-07T22:30:07.000Z",
  containsSensitiveRawData: false,
  deliveryAttemptedInBrowser: false,
  deliveryStatus: "sent",
  reason: "digest_summary_sent"
});
assert.doesNotThrow(() => AlertDigestDeliveryAckResponseSchema.parse(digestAck));
assert.equal(digestAck.acknowledgedCount, 1);
assert.equal(digestAck.deliveryAudits[0].reason, "digest_summary_sent");
await assert.rejects(
  () =>
    client.acknowledgeDigestDelivery("slot-alert:test:001", {
      acknowledgedAt: "2026-05-07T22:30:07.000Z",
      containsSensitiveRawData: false,
      deliveryAttemptedInBrowser: false,
      deliveryStatus: "sent",
      reason: "digest_suppressed_by_user"
    }),
  /sent digest/i
);

const cleanupResponse = await client.cleanupPendingAlertNotifications({
  checkedAt: "2026-05-08T15:00:00.000Z",
  dryRun: false
});
assert.doesNotThrow(() => AlertPendingCleanupResponseSchema.parse(cleanupResponse));
assert.equal(cleanupResponse.cleanupReason, "stale_pending_cleanup");
assert.equal(cleanupResponse.deletedPendingMatches, 1);

const fixtureImportPayload = buildPublicEstimateFixtureImportPayload({
  capturedAt: "2026-05-07T22:30:00.000Z",
  country: "India",
  estimateLabel: "Visitor visa interview wait time",
  fixtureText: "Visitor visa interview wait time: 120 days",
  postCity: "Chennai",
  sourceUrl: "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html",
  visaClass: "B1/B2"
});
assert.equal(fixtureImportPayload.adapterMode, "fixture_replay");
assert.equal(fixtureImportPayload.quarantineByDefault, true);
assert.equal(fixtureImportPayload.sourceId, "travel_state_global_wait_times");
assert.equal(fixtureImportPayload.triggersSlotAlerts, false);
const fixtureImport = await client.importPublicEstimateFixture(fixtureImportPayload);
assert.doesNotThrow(() => PublicEstimateFixtureImportResponseSchema.parse(fixtureImport));
assert.equal(fixtureImport.allowlistStatus, "allowlisted");
assert.equal(fixtureImport.liveFetchAttempted, false);
assert.equal(fixtureImport.slotAlertTriggerAttempted, false);

assert.doesNotThrow(() => AlertNotificationAdapterSandboxPayloadSchema.parse(mockNotificationAdapterSandboxPayload));
assert.doesNotThrow(() => AlertNotificationAdapterSandboxDeliverySchema.parse(mockNotificationAdapterSandboxDelivery));
assert.doesNotThrow(() => AlertNotificationAdapterSandboxDeliverySchema.parse(mockSlackNotificationAdapterSandboxDelivery));
const sandboxResult = await client.sandboxNotificationAdapters({
  adapterMode: "sandbox_only",
  channels: ["email"],
  containsSensitiveRawData: false,
  includeDigest: false,
  recordedAt: "2026-05-07T22:30:08.000Z"
});
assert.doesNotThrow(() => AlertNotificationAdapterSandboxResponseSchema.parse(sandboxResult));
assert.equal(sandboxResult.adapterMode, "sandbox_only");
assert.equal(sandboxResult.externalNetworkCallAttempted, false);
assert.equal(sandboxResult.liveProviderConfigured, false);
assert.equal(sandboxResult.slotAlertsDelivered, false);
assert.equal(sandboxResult.deliveries[0].payload.providerEndpoint, "not_called");
assert.equal(sandboxResult.deliveries[0].payload.containsBookingConfirmation, false);
assert.equal(sandboxResult.countsByStatus.recorded, 1);
const sandboxHistory = await client.fetchNotificationAdapterSandboxHistory();
assert.doesNotThrow(() => AlertNotificationAdapterSandboxHistoryResponseSchema.parse(sandboxHistory));
assert.equal(sandboxHistory.deliveries[0].channel, "email");
assert.equal(sandboxHistory.externalNetworkCallAttempted, false);

const providerReadiness = await client.fetchProviderDeliveryReadiness();
assert.doesNotThrow(() => ProviderDeliveryReadinessResponseSchema.parse(providerReadiness));
assert.equal(providerReadiness.externalProviderDeliveryEnabled, false);
assert.equal(providerReadiness.liveProviderConfigured, false);
assert.deepEqual(providerReadiness.safeDefaultDeliveryModes, ["browser", "digest"]);

const providerOutbox = await client.createProviderOutbox({
  adapterMode: "provider_safe_outbox",
  channels: ["email"],
  containsSensitiveRawData: false,
  externalDeliveryEnabled: false,
  includeDigest: false
});
assert.doesNotThrow(() => AlertNotificationProviderOutboxResponseSchema.parse(providerOutbox));
assert.doesNotThrow(() => AlertNotificationProviderOutboxPayloadSchema.parse(mockProviderOutboxPayload));
assert.doesNotThrow(() => AlertNotificationProviderOutboxDeliverySchema.parse(mockProviderOutboxDelivery));
assert.equal(providerOutbox.externalDeliveryEnabled, false);
assert.equal(providerOutbox.externalNetworkCallAttempted, false);
assert.equal(providerOutbox.deliveries[0].payload.providerEndpoint, "disabled_by_default");

const providerOutboxHistory = await client.fetchProviderOutboxHistory();
assert.doesNotThrow(() => AlertNotificationProviderOutboxHistoryResponseSchema.parse(providerOutboxHistory));
assert.equal(providerOutboxHistory.deliveries[0].status, "queued_disabled");
assert.equal(providerOutboxHistory.slotAlertsDelivered, false);

const publicContextSummary = await client.fetchPublicContextSummary({
  country: "India",
  includeQuarantined: true,
  postCity: "Chennai",
  visaClass: "B1/B2"
});
assert.doesNotThrow(() => PublicContextSummaryResponseSchema.parse(publicContextSummary));
assert.equal(publicContextSummary.liveFetchAttempted, false);
assert.equal(publicContextSummary.slotAlertTriggerAttempted, false);
assert.equal(publicContextSummary.contexts[0].availabilityClaim, "public_context_not_slot_availability");
assert.equal(publicContextSummary.contexts[0].recommendedUse, "decision_context_only");
assert.equal(publicContextSummary.contexts[0].triggersSlotAlerts, false);
assert.equal(publicContextSummary.contexts[0].quarantinedEstimateCount, 1);

const sourcePolicy = await client.fetchSourcePolicy();
assert.doesNotThrow(() => SourcePolicyResponseSchema.parse(sourcePolicy));
assert.equal(sourcePolicy.livePortalAutomationAllowed, false);
assert.equal(sourcePolicy.records.find((record) => record.sourceKind === "community_report")?.canTriggerSlotAlerts, true);
assert.equal(sourcePolicy.records.find((record) => record.sourceKind === "public_estimate")?.alertEligibility, "context_only");
assert.equal(
  sourcePolicy.records.find((record) => record.sourceKind === "authorized_partner_api")?.alertEligibility,
  "blocked_pending_authorization"
);

console.log("Slot report contract tests passed.");
