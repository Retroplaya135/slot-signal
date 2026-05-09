import { Activity, BellRing, CalendarCheck2, Database, Globe2, PauseCircle, PlayCircle, Send, ShieldAlert, Trash2, UserRoundCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";
import {
  buildAlertSubscriptionPayload,
  buildContributorIdentityPayload,
  buildContributorModerationNotePayload,
  buildPublicEstimateFixtureImportPayload,
  buildPublicEstimateSnapshotPayload,
  buildSlotReportContributionPayload,
  createPendingSlotAlertDeliveryPlan,
  createSlotReportApiClient,
  validateSlotReportContributionDraft,
  type AlertDeliveryAckPayload,
  type AlertDigestDeliveryAckResponse,
  type AlertDeliveryHistoryResponse,
  type AlertNotificationDigestResponse,
  type AlertPendingCleanupResponse,
  type AlertSubscriptionListResponse,
  type ContributorAbuseAuditResponse,
  type ContributorIdentityResponse,
  type ContributorModerationNoteCreateResponse,
  type ContributorModerationNotesResponse,
  type ContributorTrustResponse,
  type PublicEstimateFixtureImportResponse,
  type PublicEstimateLatestResponse,
  type PublicEstimateSnapshotCreateResponse,
  type SlotSignalExportResponse,
  type SlotReportAlertSubscription,
  type SlotReportAlertSubscriptionResponse,
  type SlotReportLatestResponse,
  type SlotReportResponse
} from "@slot-signal/contracts";
import { sendRuntimeMessage, type ExtensionMessage, type VisaQueueStatePayload } from "@slot-signal/extension-bridge";
import { readApiAuthToken } from "../../src/shared/apiAuth";
import { defaultApiBaseUrl } from "../../src/shared/apiConfig";
import { PRODUCT_BOUNDARY } from "../../src/shared/constants";
import {
  candidateTimeline,
  cooldownState,
  dashboardStats,
  notificationChannels,
  runtimeStates,
  stageWarnings,
  statusModel,
  watchedLocations
} from "../../src/shared/status";
import { TRUST_CENTER_LINKS } from "../../src/shared/trust";
import {
  BookingAssistPreview,
  CandidateTimeline,
  CooldownBanner,
  GlassPanel,
  MetricTile,
  NotificationChannelList,
  PermissionNotice,
  StatusPill,
  TrustCenterLinks
} from "../../src/ui/components";

const DELIVERED_SLOT_ALERTS_STORAGE_KEY = "slot-signal.slotAlertNotifications.delivered.v1";
const LOCAL_CONTRIBUTOR_ID_STORAGE_KEY = "slot-signal.slotReports.localContributorId.v1";
const LOCAL_CONTRIBUTOR_IDENTITY_STORAGE_KEY = "slot-signal.slotReports.localContributorIdentity.v1";

type AlertSyncState = {
  acknowledgedCount: number;
  browserApiAvailable: boolean;
  deliveredCount: number;
  deliveryAckFailedCount: number;
  failedCount: number;
  pendingCount: number;
  suppressedCount: number;
};

type LatestReportFilters = {
  country: string;
  includeLowTrust: boolean;
  includeStale: boolean;
  postCity: string;
  targetEndDate: string;
  targetStartDate: string;
  visaClass: string;
};

type BrowserNotificationApi = {
  create?: (
    notificationId: string,
    options: {
      iconUrl: string;
      message: string;
      priority?: number;
      title: string;
      type: "basic";
    }
  ) => Promise<string | void>;
};

type LocalContributorIdentity = {
  contributorKeyId: string;
  createdAt: string;
  rotationCount: number;
};

function safeStoredNotificationIds(): Set<string> {
  try {
    const rawValue = globalThis.localStorage?.getItem(DELIVERED_SLOT_ALERTS_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : [];
    if (!Array.isArray(parsedValue)) return new Set();
    return new Set(parsedValue.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function persistStoredNotificationIds(notificationIds: Set<string>) {
  try {
    globalThis.localStorage?.setItem(DELIVERED_SLOT_ALERTS_STORAGE_KEY, JSON.stringify([...notificationIds].slice(-250)));
  } catch {
    // Local preview storage can be unavailable; delivery still reports visible state.
  }
}

function safeLocalContributorId() {
  try {
    const existing = globalThis.localStorage?.getItem(LOCAL_CONTRIBUTOR_ID_STORAGE_KEY);
    if (existing && existing.length >= 8) return existing;
    const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16) ?? Math.random().toString(36).slice(2, 18);
    const contributorId = `contributor:local-${randomPart}`;
    globalThis.localStorage?.setItem(LOCAL_CONTRIBUTOR_ID_STORAGE_KEY, contributorId);
    return contributorId;
  } catch {
    return "contributor:local-preview";
  }
}

function createLocalContributorKeyId() {
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 18) ?? Math.random().toString(36).slice(2, 20);
  return `contributor-key:local-${randomPart}`;
}

function safeLocalContributorIdentity(): LocalContributorIdentity {
  try {
    const existing = globalThis.localStorage?.getItem(LOCAL_CONTRIBUTOR_IDENTITY_STORAGE_KEY);
    if (existing) {
      const parsed = JSON.parse(existing) as Partial<LocalContributorIdentity>;
      if (
        typeof parsed.contributorKeyId === "string" &&
        parsed.contributorKeyId.startsWith("contributor-key:") &&
        typeof parsed.createdAt === "string" &&
        typeof parsed.rotationCount === "number"
      ) {
        return {
          contributorKeyId: parsed.contributorKeyId,
          createdAt: parsed.createdAt,
          rotationCount: Math.max(0, Math.min(100, Math.trunc(parsed.rotationCount)))
        };
      }
    }
    const identity = {
      contributorKeyId: createLocalContributorKeyId(),
      createdAt: new Date().toISOString(),
      rotationCount: 0
    };
    globalThis.localStorage?.setItem(LOCAL_CONTRIBUTOR_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    return identity;
  } catch {
    return {
      contributorKeyId: "contributor-key:local-preview",
      createdAt: new Date().toISOString(),
      rotationCount: 0
    };
  }
}

function persistLocalContributorIdentity(identity: LocalContributorIdentity) {
  try {
    globalThis.localStorage?.setItem(LOCAL_CONTRIBUTOR_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Local identity display still works in preview even when storage is blocked.
  }
}

function contributorIdentityAgeDays(identity: LocalContributorIdentity) {
  const createdAt = new Date(identity.createdAt).valueOf();
  if (Number.isNaN(createdAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - createdAt) / (24 * 60 * 60 * 1000)));
}

function formatTrustStatus(status: SlotReportResponse["trust"]["status"]) {
  return status.replaceAll("_", " ");
}

function formatQualityLabels(values: string[]) {
  if (values.length === 0) return "none";
  return values.map((value) => value.replaceAll("_", " ")).join(", ");
}

function buildContributionInput(form: {
  availableDatesText: string;
  contributorId: string;
  country: string;
  notes: string;
  postCity: string;
  visaClass: string;
}) {
  return {
    availableDatesText: form.availableDatesText,
    contributorId: form.contributorId,
    country: form.country,
    notes: form.notes,
    postCity: form.postCity,
    visaClass: form.visaClass
  };
}

function formatSubscriptionStatus(subscription: SlotReportAlertSubscription) {
  if (subscription.status === "deleted") return "deleted";
  if (subscription.status === "paused" || !subscription.active) return "paused";
  return "active";
}

function createDeliveryAckPayload({
  deliveryAttemptedInBrowser,
  deliveryStatus,
  reason
}: Pick<AlertDeliveryAckPayload, "deliveryAttemptedInBrowser" | "deliveryStatus" | "reason">): AlertDeliveryAckPayload {
  return {
    acknowledgedAt: new Date().toISOString(),
    containsSensitiveRawData: false,
    deliveryAttemptedInBrowser,
    deliveryStatus,
    reason
  };
}

function suppressionReasonToAckReason(
  reason: "already_delivered" | "digest_mode_deferred" | "not_browser_channel" | "not_eligible" | "retry_backoff_active"
): AlertDeliveryAckPayload["reason"] | null {
  if (reason === "already_delivered") return "already_delivered_locally";
  if (reason === "digest_mode_deferred" || reason === "retry_backoff_active") return null;
  return reason;
}

export default function App() {
  const StatusIcon = statusModel.icon;
  const runtimeApi = browser.runtime as typeof browser.runtime | undefined;
  const [runtimeMessage, setRuntimeMessage] = useState<ExtensionMessage | null>(null);
  const [queueState, setQueueState] = useState<VisaQueueStatePayload | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBaseUrl);
  const [apiAuthToken, setApiAuthToken] = useState("");
  const [contributionForm, setContributionForm] = useState({
    availableDatesText: "",
    contributorId: safeLocalContributorId(),
    country: "India",
    notes: "",
    postCity: "Chennai",
    visaClass: "B1/B2"
  });
  const [contributionError, setContributionError] = useState<string | null>(null);
  const [contributionResult, setContributionResult] = useState<SlotReportResponse | null>(null);
  const [contributionStatus, setContributionStatus] = useState<"idle" | "submitting" | "submitted" | "failed">("idle");
  const [alertError, setAlertError] = useState<string | null>(null);
  const [alertStatus, setAlertStatus] = useState<"idle" | "subscribing" | "syncing" | "synced" | "failed">("idle");
  const [alertSubscription, setAlertSubscription] = useState<SlotReportAlertSubscriptionResponse | null>(null);
  const [alertCooldownMinutes, setAlertCooldownMinutes] = useState(15);
  const [alertDeliveryMode, setAlertDeliveryMode] = useState<"immediate" | "digest">("immediate");
  const [alertDigestWindowMinutes, setAlertDigestWindowMinutes] = useState(60);
  const [alertDigestAckResult, setAlertDigestAckResult] = useState<AlertDigestDeliveryAckResponse | null>(null);
  const [alertDigestQueue, setAlertDigestQueue] = useState<AlertNotificationDigestResponse | null>(null);
  const [alertPendingCleanup, setAlertPendingCleanup] = useState<AlertPendingCleanupResponse | null>(null);
  const [alertSubscriptions, setAlertSubscriptions] = useState<AlertSubscriptionListResponse | null>(null);
  const [alertSyncState, setAlertSyncState] = useState<AlertSyncState | null>(null);
  const [localContributorIdentity, setLocalContributorIdentity] = useState<LocalContributorIdentity>(safeLocalContributorIdentity());
  const [contributorIdentity, setContributorIdentity] = useState<ContributorIdentityResponse | null>(null);
  const [contributorTrust, setContributorTrust] = useState<ContributorTrustResponse | null>(null);
  const [contributorAbuseAudit, setContributorAbuseAudit] = useState<ContributorAbuseAuditResponse | null>(null);
  const [contributorModerationNotes, setContributorModerationNotes] = useState<ContributorModerationNotesResponse | null>(null);
  const [contributorModerationResult, setContributorModerationResult] = useState<ContributorModerationNoteCreateResponse | null>(null);
  const [contributorModerationForm, setContributorModerationForm] = useState({
    note: "Local review: restricted after non-PII abuse-review evidence.",
    reason: "rate_limit_review" as "rate_limit_review" | "conflict_review" | "manual_review" | "false_report_review",
    reviewStatus: "restricted" as "clear" | "watch" | "restricted"
  });
  const [contributorTrustError, setContributorTrustError] = useState<string | null>(null);
  const [contributorTrustStatus, setContributorTrustStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [latestFilters, setLatestFilters] = useState<LatestReportFilters>({
    country: "India",
    includeLowTrust: false,
    includeStale: false,
    postCity: "Chennai",
    targetEndDate: "2026-12-31",
    targetStartDate: "2026-06-01",
    visaClass: "B1/B2"
  });
  const [latestReports, setLatestReports] = useState<SlotReportLatestResponse["reports"]>([]);
  const [latestReportsError, setLatestReportsError] = useState<string | null>(null);
  const [latestReportsStatus, setLatestReportsStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [deliveryHistory, setDeliveryHistory] = useState<AlertDeliveryHistoryResponse | null>(null);
  const [deliveryHistoryError, setDeliveryHistoryError] = useState<string | null>(null);
  const [deliveryHistoryStatus, setDeliveryHistoryStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [publicEstimateForm, setPublicEstimateForm] = useState({
    estimateLabel: "Visitor visa interview wait time",
    estimateValueDays: "120",
    fixtureText: "Visitor visa interview wait time: 120 days",
    parserStatus: "parsed" as "parsed" | "parser_failed" | "source_stale",
    sourceId: "travel_state_global_wait_times" as "travel_state_global_wait_times",
    sourceUrl: "https://travel.state.gov/content/travel/en/us-visas/visa-information-services/wait-times.html"
  });
  const [publicEstimateResult, setPublicEstimateResult] = useState<PublicEstimateSnapshotCreateResponse | null>(null);
  const [publicEstimateImportResult, setPublicEstimateImportResult] = useState<PublicEstimateFixtureImportResponse | null>(null);
  const [publicEstimateError, setPublicEstimateError] = useState<string | null>(null);
  const [publicEstimateStatus, setPublicEstimateStatus] = useState<"idle" | "submitting" | "loading" | "loaded" | "failed">("idle");
  const [publicEstimates, setPublicEstimates] = useState<PublicEstimateLatestResponse | null>(null);
  const [showQuarantinedEstimates, setShowQuarantinedEstimates] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [maintenanceResult, setMaintenanceResult] = useState<string | null>(null);
  const [maintenanceStatus, setMaintenanceStatus] = useState<"idle" | "exporting" | "pruning" | "deleting" | "done" | "failed">("idle");
  const [slotSignalExport, setSlotSignalExport] = useState<SlotSignalExportResponse | null>(null);
  const [retentionCutoff, setRetentionCutoff] = useState("2026-01-01T00:00");
  const [activeCustomerView, setActiveCustomerView] = useState<"home" | "report" | "alerts" | "signals" | "settings">("home");
  const [advancedAccessCode, setAdvancedAccessCode] = useState("");
  const [advancedUnlocked, setAdvancedUnlocked] = useState(false);
  const contributionPreview = useMemo(
    () => validateSlotReportContributionDraft(buildContributionInput(contributionForm)),
    [contributionForm]
  );

  useEffect(() => {
    async function loadRuntimeStatus() {
      setApiAuthToken(await readApiAuthToken());
      if (!runtimeApi?.sendMessage) return;

      const statusResponse = await sendRuntimeMessage(runtimeApi, {
        actor: "sidepanel",
        payload: { reason: "sidepanel_opened" },
        type: "extension.status.requested"
      });
      setRuntimeMessage(statusResponse);

      const queueResponse = await sendRuntimeMessage(runtimeApi, {
        actor: "sidepanel",
        payload: {
          requestedAt: new Date().toISOString(),
          source: "sidepanel"
        },
        type: "visa.queue.state_requested"
      });
      setRuntimeMessage(queueResponse);
      if (queueResponse.type === "visa.queue.state_responded") {
        setQueueState(queueResponse.payload);
      }
    }

    void loadRuntimeStatus();
  }, [runtimeApi]);

  const metricItems = queueState
    ? [
        {
          label: "Fixture snapshots",
          value: String(queueState.snapshots.length),
          detail: "Validated signal records",
          icon: CalendarCheck2,
          tone: "success" as const
        },
        {
          label: "Queue depth",
          value: String(queueState.queueDepth),
          detail: queueState.restartRecovery.replaceAll("_", " "),
          icon: Activity,
          tone: "info" as const
        },
        {
          label: "Duplicates",
          value: String(queueState.duplicateSuppressedCount),
          detail: "Suppressed by record keys",
          icon: ShieldAlert,
          tone: queueState.duplicateSuppressedCount > 0 ? ("warning" as const) : ("success" as const)
        },
        {
          label: "Integrity",
          value: String(queueState.integrity?.corruptRecordCount ?? 0),
          detail: `${queueState.integrity?.quarantineStoreCount ?? 0} quarantined rows`,
          icon: ShieldAlert,
          tone: (queueState.integrity?.corruptRecordCount ?? 0) > 0 ? ("danger" as const) : ("success" as const)
        },
        {
          label: "Cooldown",
          value: queueState.cooldown.active ? "Active" : "Clear",
          detail: `${queueState.cooldown.minimumIntervalMinutes}+ minute policy`,
          icon: BellRing,
          tone: queueState.cooldown.active ? ("warning" as const) : ("success" as const)
        },
        {
          label: "Spam guard",
          value: queueState.notificationSpamGuard.status,
          detail: queueState.notificationSpamGuard.nextAllowedNotificationAt
            ? `Next alert after ${new Date(queueState.notificationSpamGuard.nextAllowedNotificationAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Ready for first safe alert",
          icon: BellRing,
          tone: queueState.notificationSpamGuard.status === "ready" ? ("success" as const) : ("warning" as const)
        }
      ]
    : dashboardStats;
  const timelineItems =
    queueState?.snapshots.flatMap((snapshot) => {
      return snapshot.candidates.map((candidate) => {
        return {
          title: `${candidate.consulateName} fixture`,
          meta: `${candidate.appointmentDate} ${candidate.appointmentTime ?? "TBD"}`,
          detail: `${candidate.appointmentType} candidate from ${snapshot.sourceKind}. Action allowed: open official page only.`,
          tone: "success" as const,
          icon: CalendarCheck2
        };
      });
    }) ?? candidateTimeline;
  const activeCooldown = queueState?.cooldown.active
    ? {
        title: "Fixture cooldown active",
        value: queueState.cooldown.cooldownUntil
          ? new Date(queueState.cooldown.cooldownUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : `${queueState.cooldown.minimumIntervalMinutes} min`,
        detail: `${queueState.cooldown.reason ?? "fixture"} result is held to the safe ${queueState.cooldown.minimumIntervalMinutes}+ minute policy.`,
        tone: "warning" as const,
        icon: BellRing
      }
    : cooldownState;
  const dynamicRuntimeStates = queueState
    ? [
        {
          label: "Backend",
          value: "Offline fixture",
          detail: "No live API delivery is attempted",
          tone: "neutral" as const,
          icon: Activity
        },
        {
          label: "Restart recovery",
          value: queueState.restartRecovery.replaceAll("_", " "),
          detail: "State is derived from IndexedDB records",
          tone: "info" as const,
          icon: CalendarCheck2
        },
        {
          label: "AIS permission",
          value: queueState.permissionState,
          detail: "Optional host access remains user-controlled",
          tone: queueState.permissionState === "missing" ? ("warning" as const) : ("success" as const),
          icon: ShieldAlert
        },
        {
          label: "Queue integrity",
          value: `${queueState.integrity?.validRecordCount ?? queueState.queueDepth} valid`,
          detail: `${queueState.integrity?.compactedRecordCount ?? 0} compacted by retention policy`,
          tone: (queueState.integrity?.corruptRecordCount ?? 0) > 0 ? ("danger" as const) : ("success" as const),
          icon: Activity
        },
        {
          label: "Observability",
          value: queueState.observability.logFormat,
          detail: `${queueState.observability.traceCoverage.replaceAll("_", " ")} across ${queueState.observability.traceIds.length} trace id(s)`,
          tone: queueState.observability.traceCoverage === "all_records_with_trace" ? ("success" as const) : ("warning" as const),
          icon: Activity
        },
        {
          label: "Retention",
          value: `${queueState.retentionPolicy.localQueueRetentionRecords} local rows`,
          detail: queueState.retentionPolicy.quarantineInvalidRecords ? "Invalid records quarantine before export" : "Quarantine disabled",
          tone: "info" as const,
          icon: ShieldAlert
        }
      ]
    : runtimeStates;
  const trustLinks = TRUST_CENTER_LINKS.map((link) => ({
    ...link,
    href: runtimeApi?.getURL ? runtimeApi.getURL(link.path) : `/${link.path}`
  }));

  function updateContributionField(field: keyof typeof contributionForm, value: string) {
    setContributionForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateLatestFilter(field: keyof LatestReportFilters, value: boolean | string) {
    setLatestFilters((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updatePublicEstimateField(field: keyof typeof publicEstimateForm, value: string) {
    setPublicEstimateForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function updateContributorModerationField(field: keyof typeof contributorModerationForm, value: string) {
    setContributorModerationForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  async function submitSlotContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setContributionStatus("submitting");
    setContributionError(null);
    setContributionResult(null);

    try {
      const payload = buildSlotReportContributionPayload(buildContributionInput(contributionForm));
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const result = await client.submitSlotReport(payload);
      setContributionResult(result);
      setContributionStatus("submitted");
      if (alertSubscription) {
        await syncPendingSlotAlerts();
      }
      await refreshContributorTrust();
      await refreshLatestReports();
    } catch (error) {
      setContributionError(error instanceof Error ? error.message : "Slot report could not be submitted.");
      setContributionStatus("failed");
    }
  }

  async function enableBrowserAlertFilter() {
    setAlertStatus("subscribing");
    setAlertError(null);

    try {
      const contribution = buildSlotReportContributionPayload(buildContributionInput(contributionForm));
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const subscription = await client.createAlertSubscription(
        buildAlertSubscriptionPayload({
          availableDates: contribution.availableDates,
          cooldownMinutes: alertCooldownMinutes,
          country: contribution.country,
          deliveryMode: alertDeliveryMode,
          digestWindowMinutes: alertDigestWindowMinutes,
          postCity: contribution.postCity,
          visaClass: contribution.visaClass
        })
      );
      setAlertSubscription(subscription);
      setAlertStatus("synced");
      await refreshAlertSubscriptions();
      await syncPendingSlotAlerts();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Browser alert filter could not be created.");
      setAlertStatus("failed");
    }
  }

  async function refreshAlertSubscriptions(includeDeleted = true) {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const response = await client.fetchAlertSubscriptions(includeDeleted);
      setAlertSubscriptions(response);
      setAlertStatus("synced");
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Alert subscriptions could not be loaded.");
      setAlertStatus("failed");
    }
  }

  async function updateAlertSubscription(subscriptionId: string, active: boolean) {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      await client.updateAlertSubscription(subscriptionId, {
        active,
        auditReason: active ? "user resumed filter" : "user paused filter",
        containsSensitiveRawData: false
      });
      await refreshAlertSubscriptions();
      await syncPendingSlotAlerts();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Alert subscription could not be updated.");
      setAlertStatus("failed");
    }
  }

  async function updateAlertCooldown(subscriptionId: string, cooldownMinutes: number) {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      await client.updateAlertSubscription(subscriptionId, {
        auditReason: "user updated cooldown",
        containsSensitiveRawData: false,
        cooldownMinutes
      });
      await refreshAlertSubscriptions();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Alert cooldown could not be updated.");
      setAlertStatus("failed");
    }
  }

  async function deleteAlertSubscription(subscriptionId: string) {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      await client.deleteAlertSubscription(subscriptionId);
      await refreshAlertSubscriptions();
      await syncPendingSlotAlerts();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Alert subscription could not be deleted.");
      setAlertStatus("failed");
    }
  }

  async function syncPendingSlotAlerts() {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const pending = await client.fetchPendingAlertNotifications();
      const deliveredNotificationIds = safeStoredNotificationIds();
      const plan = createPendingSlotAlertDeliveryPlan({
        deliveredNotificationIds,
        pendingMatches: pending.pendingMatches
      });
      const notificationApi = (browser as unknown as { notifications?: BrowserNotificationApi }).notifications;
      const browserApiAvailable = Boolean(notificationApi?.create && runtimeApi?.getURL);
      let acknowledgedCount = 0;
      let deliveredCount = 0;
      let deliveryAckFailedCount = 0;
      let failedCount = 0;

      for (const suppression of plan.suppressed) {
        const ackReason = suppressionReasonToAckReason(suppression.reason);
        if (!ackReason) continue;
        try {
          await client.acknowledgeAlertDelivery(
            suppression.notificationId,
            createDeliveryAckPayload({
              deliveryAttemptedInBrowser: false,
              deliveryStatus: "suppressed",
              reason: ackReason
            })
          );
          acknowledgedCount += 1;
        } catch {
          deliveryAckFailedCount += 1;
        }
      }

      if (browserApiAvailable && notificationApi?.create && runtimeApi?.getURL) {
        for (const delivery of plan.deliveries) {
          try {
            await notificationApi.create(delivery.notificationId, {
              iconUrl: runtimeApi.getURL("/icons/notification.png"),
              message: delivery.safeMessage.body,
              priority: 1,
              title: delivery.safeMessage.title,
              type: "basic"
            });
            deliveredNotificationIds.add(delivery.notificationId);
            deliveredCount += 1;
            try {
              await client.acknowledgeAlertDelivery(
                delivery.notificationId,
                createDeliveryAckPayload({
                  deliveryAttemptedInBrowser: true,
                  deliveryStatus: "sent",
                  reason: "browser_notification_created"
                })
              );
              acknowledgedCount += 1;
            } catch {
              deliveryAckFailedCount += 1;
            }
          } catch {
            failedCount += 1;
            try {
              await client.acknowledgeAlertDelivery(
                delivery.notificationId,
                createDeliveryAckPayload({
                  deliveryAttemptedInBrowser: true,
                  deliveryStatus: "failed",
                  reason: "browser_create_failed"
                })
              );
              acknowledgedCount += 1;
            } catch {
              deliveryAckFailedCount += 1;
            }
          }
        }
        persistStoredNotificationIds(deliveredNotificationIds);
      }

      setAlertSyncState({
        acknowledgedCount,
        browserApiAvailable,
        deliveredCount,
        deliveryAckFailedCount,
        failedCount: browserApiAvailable ? failedCount : plan.deliveries.length,
        pendingCount: pending.pendingMatches.length,
        suppressedCount: plan.suppressed.length
      });
      setAlertStatus(
        failedCount > 0 || deliveryAckFailedCount > 0 || (!browserApiAvailable && plan.deliveries.length > 0)
          ? "failed"
          : "synced"
      );
      if (!browserApiAvailable && plan.deliveries.length > 0) {
        setAlertError("Browser notification API is unavailable in this preview context. Load the built extension to deliver notifications.");
      }
      await refreshDeliveryHistory();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Pending browser alerts could not be synced.");
      setAlertStatus("failed");
    }
  }

  async function refreshDigestAlerts() {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const digestQueue = await client.fetchDigestAlertNotifications();
      setAlertDigestQueue(digestQueue);
      setAlertStatus("synced");
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Digest alerts could not be loaded.");
      setAlertStatus("failed");
    }
  }

  async function acknowledgeDigestGroup(subscriptionId: string, deliveryStatus: "sent" | "suppressed") {
    setAlertStatus("syncing");
    setAlertError(null);
    setAlertDigestAckResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const response = await client.acknowledgeDigestDelivery(subscriptionId, {
        acknowledgedAt: new Date().toISOString(),
        containsSensitiveRawData: false,
        deliveryAttemptedInBrowser: false,
        deliveryStatus,
        reason: deliveryStatus === "sent" ? "digest_summary_sent" : "digest_suppressed_by_user"
      });
      setAlertDigestAckResult(response);
      setAlertStatus("synced");
      await refreshDigestAlerts();
      await refreshAlertSubscriptions();
      await refreshDeliveryHistory();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Digest delivery decision could not be recorded.");
      setAlertStatus("failed");
    }
  }

  async function cleanupStalePendingAlerts() {
    setAlertStatus("syncing");
    setAlertError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const cleanup = await client.cleanupPendingAlertNotifications({
        checkedAt: new Date().toISOString(),
        dryRun: false
      });
      setAlertPendingCleanup(cleanup);
      setAlertStatus("synced");
      await syncPendingSlotAlerts();
    } catch (error) {
      setAlertError(error instanceof Error ? error.message : "Stale pending alerts could not be cleaned.");
      setAlertStatus("failed");
    }
  }

  async function refreshLatestReports() {
    setLatestReportsStatus("loading");
    setLatestReportsError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const response = await client.fetchLatestSlotReports({
        country: latestFilters.country,
        includeLowTrust: latestFilters.includeLowTrust,
        includeStale: latestFilters.includeStale,
        postCity: latestFilters.postCity,
        targetEndDate: latestFilters.targetEndDate,
        targetStartDate: latestFilters.targetStartDate,
        visaClass: latestFilters.visaClass
      });
      setLatestReports(response.reports);
      setLatestReportsStatus("loaded");
    } catch (error) {
      setLatestReportsError(error instanceof Error ? error.message : "Latest reports could not be loaded.");
      setLatestReportsStatus("failed");
    }
  }

  async function refreshDeliveryHistory() {
    setDeliveryHistoryStatus("loading");
    setDeliveryHistoryError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const history = await client.fetchAlertDeliveryHistory();
      setDeliveryHistory(history);
      setDeliveryHistoryStatus("loaded");
    } catch (error) {
      setDeliveryHistoryError(error instanceof Error ? error.message : "Delivery history could not be loaded.");
      setDeliveryHistoryStatus("failed");
    }
  }

  async function refreshContributorTrust() {
    setContributorTrustStatus("loading");
    setContributorTrustError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const identity = await client.upsertContributorIdentity(
        contributionForm.contributorId,
        buildContributorIdentityPayload({
          ...localContributorIdentity,
          lastSeenAt: new Date().toISOString()
        })
      );
      const trust = await client.fetchContributorTrust(contributionForm.contributorId);
      const abuseAudit = await client.fetchContributorAbuseAudit(contributionForm.contributorId);
      const moderationNotes = await client.fetchContributorModerationNotes(contributionForm.contributorId);
      setContributorIdentity(identity);
      setContributorTrust(trust);
      setContributorAbuseAudit(abuseAudit);
      setContributorModerationNotes(moderationNotes);
      setContributorTrustStatus("loaded");
    } catch (error) {
      setContributorTrustError(error instanceof Error ? error.message : "Contributor trust could not be loaded.");
      setContributorTrustStatus("failed");
    }
  }

  async function rotateContributorIdentity() {
    setContributorTrustStatus("loading");
    setContributorTrustError(null);

    const nextIdentity = {
      contributorKeyId: createLocalContributorKeyId(),
      createdAt: localContributorIdentity.createdAt,
      rotationCount: Math.min(localContributorIdentity.rotationCount + 1, 100)
    };
    persistLocalContributorIdentity(nextIdentity);
    setLocalContributorIdentity(nextIdentity);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const identity = await client.upsertContributorIdentity(
        contributionForm.contributorId,
        buildContributorIdentityPayload({
          ...nextIdentity,
          lastSeenAt: new Date().toISOString()
        })
      );
      const trust = await client.fetchContributorTrust(contributionForm.contributorId);
      setContributorIdentity(identity);
      setContributorTrust(trust);
      setContributorTrustStatus("loaded");
    } catch (error) {
      setContributorTrustError(error instanceof Error ? error.message : "Contributor identity rotation could not be synced.");
      setContributorTrustStatus("failed");
    }
  }

  async function addContributorModerationNote() {
    setContributorTrustStatus("loading");
    setContributorTrustError(null);
    setContributorModerationResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const result = await client.addContributorModerationNote(
        contributionForm.contributorId,
        buildContributorModerationNotePayload(contributorModerationForm)
      );
      const trust = await client.fetchContributorTrust(contributionForm.contributorId);
      const moderationNotes = await client.fetchContributorModerationNotes(contributionForm.contributorId);
      setContributorModerationResult(result);
      setContributorTrust(trust);
      setContributorModerationNotes(moderationNotes);
      setContributorTrustStatus("loaded");
    } catch (error) {
      setContributorTrustError(error instanceof Error ? error.message : "Contributor moderation note could not be saved.");
      setContributorTrustStatus("failed");
    }
  }

  async function submitPublicEstimate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPublicEstimateStatus("submitting");
    setPublicEstimateError(null);
    setPublicEstimateResult(null);

    try {
      const estimateValueDays = Number.parseInt(publicEstimateForm.estimateValueDays, 10);
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const result = await client.submitPublicEstimateSnapshot(
        buildPublicEstimateSnapshotPayload({
          country: contributionForm.country,
          estimateLabel: publicEstimateForm.estimateLabel,
          estimateValueDays,
          parserStatus: publicEstimateForm.parserStatus,
          postCity: contributionForm.postCity,
          sourceUrl: publicEstimateForm.sourceUrl,
          visaClass: contributionForm.visaClass
        })
      );
      setPublicEstimateResult(result);
      setPublicEstimateStatus("loaded");
      await refreshPublicEstimates();
    } catch (error) {
      setPublicEstimateError(error instanceof Error ? error.message : "Public estimate could not be submitted.");
      setPublicEstimateStatus("failed");
    }
  }

  async function importPublicEstimateFixture() {
    setPublicEstimateStatus("submitting");
    setPublicEstimateError(null);
    setPublicEstimateImportResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const result = await client.importPublicEstimateFixture(
        buildPublicEstimateFixtureImportPayload({
          country: contributionForm.country,
          estimateLabel: publicEstimateForm.estimateLabel,
          fixtureText: publicEstimateForm.fixtureText,
          postCity: contributionForm.postCity,
          sourceId: publicEstimateForm.sourceId,
          sourceUrl: publicEstimateForm.sourceUrl,
          visaClass: contributionForm.visaClass
        })
      );
      setPublicEstimateImportResult(result);
      setPublicEstimateStatus("loaded");
      await refreshPublicEstimates();
    } catch (error) {
      setPublicEstimateError(error instanceof Error ? error.message : "Public estimate fixture import failed.");
      setPublicEstimateStatus("failed");
    }
  }

  async function refreshPublicEstimates() {
    setPublicEstimateStatus("loading");
    setPublicEstimateError(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const response = await client.fetchLatestPublicEstimates({
        country: contributionForm.country,
        includeQuarantined: showQuarantinedEstimates,
        postCity: contributionForm.postCity,
        visaClass: contributionForm.visaClass
      });
      setPublicEstimates(response);
      setPublicEstimateStatus("loaded");
    } catch (error) {
      setPublicEstimateError(error instanceof Error ? error.message : "Public estimates could not be loaded.");
      setPublicEstimateStatus("failed");
    }
  }

  async function exportSlotSignalState() {
    setMaintenanceStatus("exporting");
    setMaintenanceError(null);
    setMaintenanceResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const exported = await client.exportSlotSignalRecords();
      setSlotSignalExport(exported);
      setMaintenanceResult(
        `Export ready: ${exported.reports.length} report(s), ${exported.pendingMatches.length} pending alert(s), ${exported.deliveryAuditEvents.length} delivery audit event(s).`
      );
      setMaintenanceStatus("done");
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : "Slot-signal export failed.");
      setMaintenanceStatus("failed");
    }
  }

  async function dryRunRetentionPrune() {
    setMaintenanceStatus("pruning");
    setMaintenanceError(null);
    setMaintenanceResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const cutoffBefore = new Date(retentionCutoff).toISOString();
      const result = await client.pruneSlotSignalRecords({
        cutoffBefore,
        dryRun: true
      });
      setMaintenanceResult(
        `Dry run matched ${result.matchedReports} report(s); delete would remove ${result.deletedReports} report(s), ${result.deletedPendingMatches} pending alert(s), and ${result.deletedDeliveryAuditEvents} audit event(s).`
      );
      setMaintenanceStatus("done");
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : "Retention dry run failed.");
      setMaintenanceStatus("failed");
    }
  }

  async function deleteSlotSignalReport(reportId: string) {
    setMaintenanceStatus("deleting");
    setMaintenanceError(null);
    setMaintenanceResult(null);

    try {
      const client = createSlotReportApiClient({ apiBaseUrl, authToken: apiAuthToken || undefined });
      const result = await client.deleteSlotSignalReport(reportId);
      setMaintenanceResult(
        result.deleted
          ? `Deleted ${result.deletedReports} report(s), ${result.deletedPendingMatches} pending alert(s), and ${result.deletedDeliveryAuditEvents} audit event(s).`
          : "No matching report was deleted."
      );
      setLatestReports((current) => current.filter((report) => report.reportId !== reportId));
      setMaintenanceStatus("done");
      await refreshDeliveryHistory();
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : "Slot report delete failed.");
      setMaintenanceStatus("failed");
    }
  }

  const activeFilterCount =
    alertSubscriptions?.subscriptions.filter((subscription) => formatSubscriptionStatus(subscription) === "active").length ??
    (alertSubscription ? 1 : 0);
  const latestSignalCount = latestReports.length + (contributionResult ? 1 : 0);
  const customerStatusLabel = alertSyncState?.deliveredCount
    ? `${alertSyncState.deliveredCount} sent`
    : alertSyncState?.pendingCount
      ? `${alertSyncState.pendingCount} ready`
      : statusModel.label;
  const latestSignal = contributionResult ?? latestReports[0] ?? null;
  const customerViews: Array<{ id: typeof activeCustomerView; label: string; icon: typeof Activity }> = [
    { id: "home", label: "Home", icon: Activity },
    { id: "report", label: "Report", icon: Send },
    { id: "alerts", label: "Alerts", icon: BellRing },
    { id: "signals", label: "Signals", icon: CalendarCheck2 },
    { id: "settings", label: "Settings", icon: ShieldAlert }
  ];

  function unlockAdvancedTools() {
    const normalized = advancedAccessCode.trim();
    if (normalized === "preview-advanced" || normalized.length >= 12 || apiAuthToken.length >= 24) {
      setAdvancedUnlocked(true);
    }
  }

  function renderLatestSignalCard() {
    if (!latestSignal) {
      return (
        <section className="signal-empty-state" aria-label="No recent signals">
          <CalendarCheck2 className="icon" />
          <div>
            <strong>No matching signal yet</strong>
            <span>Add a watch filter or submit visible appointment dates to begin.</span>
          </div>
        </section>
      );
    }

    const trust = latestSignal.trust;
    const signalRecord = latestSignal as unknown as { availableDates?: string[]; matchedDates?: string[] };
    const dates = Array.isArray(signalRecord.matchedDates) ? signalRecord.matchedDates : signalRecord.availableDates ?? [];
    return (
      <article className="signal-signal-card" data-trust={trust.status}>
        <div className="signal-card-head">
          <div>
            <span className="signal-label">Latest signal</span>
            <strong>
              {latestSignal.postCity} · {latestSignal.visaClass}
            </strong>
          </div>
          <StatusPill icon={ShieldAlert} label={trust.eligibleForNotification ? "Alert ready" : "Review first"} tone={trust.eligibleForNotification ? "success" : "warning"} />
        </div>
        <p>{dates.join(", ") || "No visible date captured"}</p>
        <div className="signal-mini-grid">
          <span>
            <strong>{trust.qualityScore}/100</strong>
            Confidence
          </span>
          <span>
            <strong>{formatTrustStatus(trust.status)}</strong>
            Review state
          </span>
          <span>
            <strong>{trust.independentContributorCount}</strong>
            Contributors
          </span>
        </div>
        <details className="signal-details">
          <summary>Why this matters</summary>
          <p>
            Source: {trust.provenance.sourceKind.replaceAll("_", " ")}. Quality: {formatQualityLabels(trust.qualitySignals)}.
            {trust.suppressionReasons.length > 0 ? ` Not sent because ${formatQualityLabels(trust.suppressionReasons)}.` : ""}
          </p>
        </details>
      </article>
    );
  }

  function renderCustomerHome() {
    return (
      <section className="signal-view-grid" aria-label="Slot Signal home">
        <GlassPanel className="signal-hero-card liquid-glass-regular" ariaLabel="Watch summary">
          <div className="signal-hero-copy">
            <span className="signal-label">Slot Signal</span>
            <h2>Community appointment signals, without portal automation.</h2>
            <p>Watch locations, review fresh signals, and get browser alerts while you complete decisions on the official site yourself.</p>
          </div>
          <div className="signal-actions">
            <button className="primary-button" type="button" onClick={() => setActiveCustomerView("report")}>
              <Send className="icon" />
              Add signal
            </button>
            <button className="secondary-button" type="button" onClick={() => setActiveCustomerView("alerts")}>
              <BellRing className="icon" />
              Manage alerts
            </button>
          </div>
        </GlassPanel>

        <section className="signal-stat-strip" aria-label="Current status">
          <MetricTile icon={BellRing} label="Active filters" value={String(activeFilterCount)} detail="Watching your chosen city and visa class" tone={activeFilterCount > 0 ? "success" : "warning"} />
          <MetricTile icon={CalendarCheck2} label="Visible signals" value={String(latestSignalCount)} detail="Community reports in this session" tone={latestSignalCount > 0 ? "success" : "info"} />
          <MetricTile icon={Activity} label="Alert status" value={customerStatusLabel} detail="Browser alerts stay user-controlled" tone={alertStatus === "failed" ? "danger" : "info"} />
        </section>

        {renderLatestSignalCard()}

        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Safe boundary">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Boundary</span>
              <strong>Manual decision, always</strong>
            </div>
            <StatusPill icon={UserRoundCheck} label="User confirmed" tone="success" />
          </div>
          <p>No credentials, cookies, screenshots, or appointment-changing actions are collected by this extension.</p>
        </GlassPanel>
        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Trust center links">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Trust</span>
              <strong>Privacy, safety, and support</strong>
            </div>
            <ShieldAlert className="icon" />
          </div>
          <TrustCenterLinks links={trustLinks} />
        </GlassPanel>
      </section>
    );
  }

  function renderReportView() {
    return (
      <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Submit visible appointment signal">
        <div className="signal-card-head">
          <div>
            <span className="signal-label">Add signal</span>
            <h2 className="section-title">Share visible appointment dates</h2>
          </div>
          <StatusPill icon={Send} label={contributionStatus === "submitting" ? "Sending" : contributionStatus === "submitted" ? "Saved" : "Ready"} tone={contributionStatus === "failed" ? "danger" : contributionStatus === "submitted" ? "success" : "info"} />
        </div>
        <form className="signal-form" onSubmit={submitSlotContribution}>
          <div className="signal-form-grid">
            <label className="setting" htmlFor="signal-country">
              <span>Country</span>
              <input id="signal-country" list="slot-country-options" onChange={(event) => updateContributionField("country", event.target.value)} required value={contributionForm.country} />
            </label>
            <label className="setting" htmlFor="signal-city">
              <span>Post city</span>
              <input id="signal-city" list="slot-post-city-options" onChange={(event) => updateContributionField("postCity", event.target.value)} required value={contributionForm.postCity} />
            </label>
            <label className="setting" htmlFor="signal-class">
              <span>Visa class</span>
              <input id="signal-class" list="slot-visa-class-options" onChange={(event) => updateContributionField("visaClass", event.target.value)} required value={contributionForm.visaClass} />
            </label>
          </div>
          <datalist id="slot-country-options">
            <option value="Brazil" />
            <option value="Canada" />
            <option value="Colombia" />
            <option value="India" />
            <option value="Mexico" />
            <option value="United Kingdom" />
          </datalist>
          <datalist id="slot-post-city-options">
            <option value="Chennai" />
            <option value="Hyderabad" />
            <option value="Kolkata" />
            <option value="Mumbai" />
            <option value="New Delhi" />
          </datalist>
          <datalist id="slot-visa-class-options">
            <option value="B1/B2" />
            <option value="F-1" />
            <option value="H-1B" />
            <option value="J-1" />
            <option value="L-1" />
            <option value="O-1" />
          </datalist>
          <label className="setting" htmlFor="signal-dates">
            <span>Visible dates</span>
            <textarea id="signal-dates" onChange={(event) => updateContributionField("availableDatesText", event.target.value)} placeholder="2026-06-12, 2026-06-18" required value={contributionForm.availableDatesText} />
          </label>
          <label className="setting" htmlFor="signal-notes">
            <span>Optional note</span>
            <input id="signal-notes" onChange={(event) => updateContributionField("notes", event.target.value)} placeholder="Example: morning view, one date disappeared" value={contributionForm.notes} />
          </label>
          <section className="signal-preview" data-valid={contributionPreview.valid ? "true" : "false"}>
            <strong>{contributionPreview.valid ? "Ready to share" : "Needs one more detail"}</strong>
            <span>{contributionPreview.normalizedDates.join(", ") || contributionPreview.errors.join(", ")}</span>
          </section>
          <div className="signal-actions">
            <button className="primary-button" disabled={contributionStatus === "submitting" || !contributionPreview.valid} type="submit">
              <Send className="icon" />
              {contributionStatus === "submitting" ? "Sending" : "Share signal"}
            </button>
            <span className="signal-fineprint">Only visible metadata is sent.</span>
          </div>
        </form>
        {contributionResult ? renderLatestSignalCard() : null}
        {contributionError ? (
          <section className="signal-inline-alert" data-tone="danger">
            <strong>Could not save signal</strong>
            <span>{contributionError}</span>
          </section>
        ) : null}
      </GlassPanel>
    );
  }

  function renderAlertsView() {
    return (
      <section className="signal-view-grid" aria-label="Alert controls">
        <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Alert setup">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Alerts</span>
              <h2 className="section-title">Watch this search</h2>
            </div>
            <StatusPill icon={BellRing} label={alertStatus === "syncing" ? "Syncing" : alertStatus === "failed" ? "Needs attention" : "Ready"} tone={alertStatus === "failed" ? "danger" : "info"} />
          </div>
          <div className="signal-form-grid">
            <label className="setting" htmlFor="signal-delivery-mode">
              <span>Delivery mode</span>
              <select id="signal-delivery-mode" onChange={(event) => setAlertDeliveryMode(event.target.value as "immediate" | "digest")} value={alertDeliveryMode}>
                <option value="immediate">Instant browser alert</option>
                <option value="digest">Digest</option>
              </select>
            </label>
            <label className="setting" htmlFor="signal-cooldown">
              <span>Cooldown minutes</span>
              <input id="signal-cooldown" min="15" onChange={(event) => setAlertCooldownMinutes(Number(event.target.value))} type="number" value={alertCooldownMinutes} />
            </label>
            <label className="setting" htmlFor="signal-digest-window">
              <span>Digest window</span>
              <input id="signal-digest-window" min="30" onChange={(event) => setAlertDigestWindowMinutes(Number(event.target.value))} type="number" value={alertDigestWindowMinutes} />
            </label>
          </div>
          <div className="signal-actions">
            <button className="primary-button" disabled={alertStatus === "subscribing" || alertStatus === "syncing"} onClick={enableBrowserAlertFilter} type="button">
              <BellRing className="icon" />
              Start watching
            </button>
            <button className="secondary-button" disabled={alertStatus === "syncing"} onClick={syncPendingSlotAlerts} type="button">
              <Activity className="icon" />
              Sync alerts
            </button>
            <button className="secondary-button" disabled={alertStatus === "syncing"} onClick={() => void refreshAlertSubscriptions()} type="button">
              <Database className="icon" />
              Refresh filters
            </button>
          </div>
          {alertSubscription ? (
            <section className="signal-inline-alert" data-tone="success">
              <strong>Watching {alertSubscription.subscription.postCities.join(", ")}</strong>
              <span>{alertSubscription.subscription.deliveryMode} delivery, {alertSubscription.subscription.cooldownMinutes} minute cooldown.</span>
            </section>
          ) : null}
          {alertSyncState ? (
            <section className="signal-inline-alert" data-tone={alertSyncState.failedCount > 0 ? "danger" : "success"}>
              <strong>{alertSyncState.deliveredCount} sent · {alertSyncState.suppressedCount} not sent</strong>
              <span>{alertSyncState.pendingCount} ready alert(s) checked.</span>
            </section>
          ) : null}
          {alertError ? (
            <section className="signal-inline-alert" data-tone="danger">
              <strong>Alert action stopped</strong>
              <span>{alertError}</span>
            </section>
          ) : null}
        </GlassPanel>

        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Managed filters">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Watchlist</span>
              <strong>{alertSubscriptions?.subscriptions.length ?? activeFilterCount} filter(s)</strong>
            </div>
          </div>
          <div className="signal-stack-list">
            {alertSubscriptions?.subscriptions.map((subscription) => (
              <article className="signal-list-row" data-status={formatSubscriptionStatus(subscription)} key={subscription.subscriptionId}>
                <div>
                  <strong>{subscription.postCities.join(", ")} · {subscription.visaClasses.join(", ")}</strong>
                  <span>{formatSubscriptionStatus(subscription)} · {subscription.cooldownMinutes} minute cooldown · {subscription.deliveryMode}</span>
                </div>
                <div className="signal-row-actions">
                  <button className="secondary-button compact-button" disabled={subscription.status === "deleted" || alertStatus === "syncing"} onClick={() => void updateAlertSubscription(subscription.subscriptionId, subscription.status !== "active")} type="button">
                    {subscription.status === "active" ? <PauseCircle className="icon" /> : <PlayCircle className="icon" />}
                    {subscription.status === "active" ? "Pause" : "Resume"}
                  </button>
                  <button className="secondary-button compact-danger-button" disabled={subscription.status === "deleted" || alertStatus === "syncing"} onClick={() => void deleteAlertSubscription(subscription.subscriptionId)} type="button">
                    <Trash2 className="icon" />
                    Delete
                  </button>
                </div>
              </article>
            ))}
            {!alertSubscriptions?.subscriptions.length ? (
              <section className="signal-empty-state">
                <BellRing className="icon" />
                <div>
                  <strong>No saved filters loaded</strong>
                  <span>Start watching or refresh filters.</span>
                </div>
              </section>
            ) : null}
          </div>
        </GlassPanel>
      </section>
    );
  }

  function renderSignalsView() {
    return (
      <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Latest community signals">
        <div className="signal-card-head">
          <div>
            <span className="signal-label">Signals</span>
            <h2 className="section-title">Latest community reports</h2>
          </div>
          <StatusPill icon={CalendarCheck2} label={latestReportsStatus === "loading" ? "Loading" : `${latestReports.length} shown`} tone={latestReportsStatus === "failed" ? "danger" : "info"} />
        </div>
        <div className="signal-form-grid">
          <label className="setting" htmlFor="signal-latest-country">
            <span>Country</span>
            <input id="signal-latest-country" onChange={(event) => updateLatestFilter("country", event.target.value)} value={latestFilters.country} />
          </label>
          <label className="setting" htmlFor="signal-latest-city">
            <span>Post city</span>
            <input id="signal-latest-city" onChange={(event) => updateLatestFilter("postCity", event.target.value)} value={latestFilters.postCity} />
          </label>
          <label className="setting" htmlFor="signal-latest-class">
            <span>Visa class</span>
            <input id="signal-latest-class" onChange={(event) => updateLatestFilter("visaClass", event.target.value)} value={latestFilters.visaClass} />
          </label>
        </div>
        <div className="signal-actions">
          <button className="primary-button" disabled={latestReportsStatus === "loading"} onClick={refreshLatestReports} type="button">
            <Activity className="icon" />
            Refresh signals
          </button>
          <label className="signal-check">
            <input checked={latestFilters.includeLowTrust} onChange={(event) => updateLatestFilter("includeLowTrust", event.target.checked)} type="checkbox" />
            Include review-only signals
          </label>
          <label className="signal-check">
            <input checked={latestFilters.includeStale} onChange={(event) => updateLatestFilter("includeStale", event.target.checked)} type="checkbox" />
            Include expired signals
          </label>
        </div>
        {latestReportsError ? (
          <section className="signal-inline-alert" data-tone="danger">
            <strong>Could not load signals</strong>
            <span>{latestReportsError}</span>
          </section>
        ) : null}
        <div className="signal-stack-list">
          {latestReports.map((report) => (
            <article className="signal-signal-card compact" data-trust={report.trust.status} key={report.reportId}>
              <div className="signal-card-head">
                <div>
                  <strong>{report.postCity} · {report.visaClass}</strong>
                  <span>{report.matchedDates.join(", ")}</span>
                </div>
                <StatusPill icon={ShieldAlert} label={`${report.trust.qualityScore}/100`} tone={report.trust.eligibleForNotification ? "success" : "warning"} />
              </div>
              <details className="signal-details">
                <summary>Review details</summary>
                <p>
                  {formatTrustStatus(report.trust.status)} · {report.trust.independentContributorCount} contributor(s) · {formatQualityLabels(report.trust.qualitySignals)}.
                  {report.trust.conflictingReportIds.length > 0 ? " Conflicting reports require review." : ""}
                </p>
              </details>
            </article>
          ))}
          {latestReportsStatus === "loaded" && latestReports.length === 0 ? (
            <section className="signal-empty-state">
              <SearchIconFallback />
              <div>
                <strong>No matches for this filter</strong>
                <span>Try another city, class, or date range.</span>
              </div>
            </section>
          ) : null}
        </div>
      </GlassPanel>
    );
  }

  function SearchIconFallback() {
    return <Globe2 className="icon" />;
  }

  function renderSettingsView() {
    return (
      <section className="signal-view-grid" aria-label="Settings and advanced access">
        <GlassPanel className="signal-card liquid-glass-regular" ariaLabel="Access and privacy settings">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Settings</span>
              <h2 className="section-title">Access and privacy</h2>
            </div>
            <StatusPill icon={ShieldAlert} label={apiAuthToken ? "Access key saved" : "Access key needed"} tone={apiAuthToken ? "success" : "warning"} />
          </div>
          <label className="setting" htmlFor="signal-api-base">
            <span>API origin</span>
            <input id="signal-api-base" onChange={(event) => setApiBaseUrl(event.target.value)} required value={apiBaseUrl} />
          </label>
          <div className="signal-actions">
            <button className="secondary-button" type="button" onClick={() => void browser.runtime.openOptionsPage()}>
              <ShieldAlert className="icon" />
              Open full settings
            </button>
            <span className="signal-fineprint">The backend API key stays local. Beta access codes are handled separately.</span>
          </div>
          <div className="signal-privacy-grid">
            <span>No portal password</span>
            <span>No appointment changes</span>
            <span>No hidden page capture</span>
          </div>
        </GlassPanel>

        <GlassPanel className="signal-card liquid-glass-clear" ariaLabel="Advanced access">
          <div className="signal-card-head">
            <div>
              <span className="signal-label">Advanced</span>
              <strong>Beta access code required</strong>
            </div>
            <StatusPill icon={advancedUnlocked ? UserRoundCheck : ShieldAlert} label={advancedUnlocked ? "Unlocked" : "Locked"} tone={advancedUnlocked ? "success" : "warning"} />
          </div>
          {!advancedUnlocked ? (
            <div className="signal-access-gate">
              <p>Reviewer tools and support exports use beta entitlement. This code is separate from the backend API key.</p>
              <label className="setting" htmlFor="signal-access-code">
                <span>Access code</span>
                <input id="signal-access-code" onChange={(event) => setAdvancedAccessCode(event.target.value)} placeholder="preview-advanced" type="password" value={advancedAccessCode} />
              </label>
              <button className="primary-button" type="button" onClick={unlockAdvancedTools}>
                <UserRoundCheck className="icon" />
                Unlock
              </button>
            </div>
          ) : (
            <div className="signal-stack-list">
              <article className="signal-list-row">
                <div>
                  <strong>Support export</strong>
                  <span>Redacted state for troubleshooting.</span>
                </div>
                <button className="secondary-button compact-button" disabled={maintenanceStatus === "exporting"} onClick={() => void exportSlotSignalState()} type="button">
                  <Database className="icon" />
                  Export
                </button>
              </article>
              <article className="signal-list-row">
                <div>
                  <strong>Public context</strong>
                  <span>Review allowed source summaries. These do not trigger alerts.</span>
                </div>
                <button className="secondary-button compact-button" disabled={publicEstimateStatus === "loading"} onClick={() => void refreshPublicEstimates()} type="button">
                  <Globe2 className="icon" />
                  Refresh
                </button>
              </article>
              <article className="signal-list-row">
                <div>
                  <strong>Record retention</strong>
                  <span>Preview old-record cleanup before deleting anything.</span>
                </div>
                <button className="secondary-button compact-button" disabled={maintenanceStatus === "pruning"} onClick={() => void dryRunRetentionPrune()} type="button">
                  <ShieldAlert className="icon" />
                  Dry run
                </button>
              </article>
              {maintenanceResult ? (
                <section className="signal-inline-alert" data-tone="success">
                  <strong>Advanced action complete</strong>
                  <span>{maintenanceResult}</span>
                </section>
              ) : null}
              {maintenanceError ? (
                <section className="signal-inline-alert" data-tone="danger">
                  <strong>Advanced action stopped</strong>
                  <span>{maintenanceError}</span>
                </section>
              ) : null}
            </div>
          )}
        </GlassPanel>
      </section>
    );
  }

  return (
    <main className="app-shell sidepanel-shell signal-shell">
      <section className="signal-topline liquid-glass-regular">
        <div>
          <span className="signal-label">US Visa Appointment Checker</span>
          <h1>Slot Signal</h1>
          <p>Minimal community signals, browser alerts, and human-controlled booking decisions.</p>
        </div>
        <StatusPill icon={StatusIcon} label={statusModel.label} tone={statusModel.tone} />
      </section>

      <nav className="signal-nav" aria-label="Primary">
        {customerViews.map((view) => {
          const Icon = view.icon;
          return (
            <button data-active={activeCustomerView === view.id ? "true" : "false"} key={view.id} onClick={() => setActiveCustomerView(view.id)} type="button">
              <Icon className="icon" />
              <span>{view.label}</span>
            </button>
          );
        })}
      </nav>

      {activeCustomerView === "home" ? renderCustomerHome() : null}
      {activeCustomerView === "report" ? renderReportView() : null}
      {activeCustomerView === "alerts" ? renderAlertsView() : null}
      {activeCustomerView === "signals" ? renderSignalsView() : null}
      {activeCustomerView === "settings" ? renderSettingsView() : null}

      <footer className="signal-footer">
        <span>Community signals only.</span>
        <span>Official booking remains manual.</span>
      </footer>
    </main>
  );
}
