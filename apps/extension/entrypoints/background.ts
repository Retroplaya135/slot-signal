import { browser, type Browser } from "wxt/browser";
import {
  createClientErrorEnvelope,
  createEnvelope,
  createStructuredObservabilityEvent,
  parseExtensionMessage,
  type ClientErrorPayload,
  type ExtensionMessage,
  type ExtensionMessageByType,
  type StructuredObservabilityEvent,
  type VisaQueueStatePayload
} from "@slot-signal/contracts";
import { MIN_SCHEDULED_CHECK_MINUTES, PRODUCT_BOUNDARY, SUPPORTED_PORTAL_ORIGINS } from "../src/shared/constants";
import {
  createFixtureDebugExport,
  ensureFixtureQueueState,
  persistFixtureNotificationDispatch,
  recordFixtureCheck
} from "../src/shared/fixtureQueue";
import { deliverFixtureBrowserNotification } from "../src/shared/notifications";

function formatCheckTime(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  });
}

function createStatusPayload(
  queueState: VisaQueueStatePayload,
  permissionState: VisaQueueStatePayload["permissionState"]
) {
  return {
    mode: queueState.cooldown.active ? "cooldown" : "ready",
    boundary: PRODUCT_BOUNDARY,
    livePortalChecksEnabled: false,
    lastCheck: formatCheckTime(queueState.latestSnapshot?.capturedAt, "Not run"),
    nextCheck: queueState.cooldown.active ? formatCheckTime(queueState.cooldown.cooldownUntil, "Cooldown") : "Manual check",
    minScheduledCheckMinutes: MIN_SCHEDULED_CHECK_MINUTES,
    permissions: {
      aisHostPermissionGranted: permissionState === "granted"
    },
    runtime: "fixture_only"
  } as const;
}

function writeStructuredLog(event: StructuredObservabilityEvent) {
  console.info(JSON.stringify(event));
}

function logRuntimeEvent(input: Parameters<typeof createStructuredObservabilityEvent>[0]) {
  writeStructuredLog(createStructuredObservabilityEvent(input));
}

function createStatusResponse(
  request: ExtensionMessage,
  queueState: VisaQueueStatePayload,
  permissionState: VisaQueueStatePayload["permissionState"]
) {
  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request.idempotencyKey,
    payload: createStatusPayload(queueState, permissionState),
    traceId: request.traceId,
    type: "extension.status.responded"
  });
}

function createReadyResponse(request?: ExtensionMessage) {
  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request?.idempotencyKey,
    payload: {
      boundary: PRODUCT_BOUNDARY,
      livePortalChecksEnabled: false,
      minScheduledCheckMinutes: MIN_SCHEDULED_CHECK_MINUTES,
      mode: "fixture_only",
      supportedPortalOrigins: [SUPPORTED_PORTAL_ORIGINS[0]]
    },
    traceId: request?.traceId,
    type: "extension.ready"
  });
}

function createCooldownResponse(
  request: ExtensionMessageByType<"visa.availability.check_requested">,
  queueState: VisaQueueStatePayload
) {
  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request.idempotencyKey,
    payload: {
      cooldownUntil: queueState.cooldown.cooldownUntil ?? undefined,
      detail: `Fixture queue recorded ${queueState.latestSnapshot?.candidates.length ?? 0} candidate(s). Duplicate snapshots suppressed: ${queueState.duplicateSuppressedCount}. Live checks remain disabled.`,
      minimumIntervalMinutes: MIN_SCHEDULED_CHECK_MINUTES,
      reason: "fixture_mode"
    },
    traceId: request.traceId,
    type: "visa.availability.cooldown_started"
  });
}

async function readPermissionState(): Promise<VisaQueueStatePayload["permissionState"]> {
  try {
    const granted = await browser.permissions.contains({
      origins: [`${SUPPORTED_PORTAL_ORIGINS[0]}/*`]
    });
    const permissionState = granted ? "granted" : "missing";
    logRuntimeEvent({
      component: "service_worker",
      eventName: "permission.state.read",
      metadata: { permissionState },
      result: "observed",
      safeSummary: "AIS optional host permission state read without portal data.",
      severity: "debug",
      traceId: "trace:permission:state"
    });
    return permissionState;
  } catch {
    logRuntimeEvent({
      component: "service_worker",
      eventName: "permission.state.read",
      metadata: { permissionState: "unknown" },
      reason: "permissions_api_unavailable",
      result: "failed",
      safeSummary: "AIS optional host permission state could not be read.",
      severity: "warn",
      traceId: "trace:permission:state"
    });
    return "unknown";
  }
}

async function createQueueStateResponse(request: ExtensionMessageByType<"visa.queue.state_requested">) {
  const permissionState = await readPermissionState();
  const queueState = await ensureFixtureQueueState({
    permissionState,
    traceId: request.traceId
  });
  logRuntimeEvent({
    component: "queue",
    eventName: "queue.state.derived",
    idempotencyKey: request.idempotencyKey,
    metadata: {
      cooldownActive: queueState.cooldown.active,
      permissionState,
      queueDepth: queueState.queueDepth,
      restartRecovery: queueState.restartRecovery,
      spamGuardStatus: queueState.notificationSpamGuard.status
    },
    result: "succeeded",
    safeSummary: "Fixture queue state derived for a typed runtime response.",
    severity: "info",
    traceId: request.traceId
  });

  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request.idempotencyKey,
    payload: queueState,
    traceId: request.traceId,
    type: "visa.queue.state_responded"
  });
}

async function createDebugExportResponse(request: ExtensionMessageByType<"visa.debug.export_requested">) {
  const permissionState = await readPermissionState();
  const debugExport = await createFixtureDebugExport({ permissionState });
  logRuntimeEvent({
    component: "service_worker",
    eventName: "debug.export.generated",
    idempotencyKey: request.idempotencyKey,
    metadata: {
      permissionState,
      queueDepth: debugExport.queueState.queueDepth,
      spamGuardStatus: debugExport.notificationSpamGuard.status
    },
    result: "succeeded",
    safeSummary: "Redacted debug export generated with safety metadata.",
    severity: "info",
    traceId: request.traceId
  });

  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request.idempotencyKey,
    payload: debugExport,
    traceId: request.traceId,
    type: "visa.debug.export_responded"
  });
}

async function createNotificationDeliveryResponse(request: ExtensionMessageByType<"visa.notification.test_requested">) {
  const permissionState = await readPermissionState();
  const queueState = await ensureFixtureQueueState({
    permissionState,
    traceId: request.traceId
  });
  const notificationsApi = (browser as unknown as {
    notifications?: {
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
  }).notifications;
  const dispatch = await deliverFixtureBrowserNotification({
    browserNotifications: notificationsApi,
    iconUrl: browser.runtime.getURL("/icons/notification.png"),
    idempotencyKey: request.idempotencyKey,
    queueState,
    traceId: request.traceId
  });
  await persistFixtureNotificationDispatch({
    dispatch,
    idempotencyKey: request.idempotencyKey,
    permissionState,
    traceId: request.traceId
  });
  const browserDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "browser");
  logRuntimeEvent({
    component: "notification",
    eventName:
      browserDelivery?.status === "sent"
        ? "notification.delivery.sent"
        : browserDelivery?.reason === "spam_guard_cooldown"
          ? "notification.delivery.suppressed"
          : "notification.delivery.requested",
    idempotencyKey: request.idempotencyKey,
    metadata: {
      permissionState,
      queueDepth: queueState.queueDepth,
      spamGuardStatus: queueState.notificationSpamGuard.status
    },
    reason: browserDelivery?.reason ?? null,
    result: browserDelivery?.status === "sent" ? "sent" : browserDelivery?.status === "suppressed" ? "suppressed" : "failed",
    safeSummary: "Fixture notification handled without booking-confirmation authority.",
    severity: browserDelivery?.status === "sent" ? "info" : "warn",
    traceId: request.traceId
  });

  return createEnvelope({
    actor: "service_worker",
    idempotencyKey: request.idempotencyKey,
    payload: dispatch,
    traceId: request.traceId,
    type: "visa.notification.delivery_responded"
  });
}

function senderAllowed(message: ExtensionMessage, sender: Browser.runtime.MessageSender) {
  if (message.actor === "content_script") {
    const senderUrl = sender.url ?? sender.tab?.url ?? "";
    return senderUrl.startsWith(`${SUPPORTED_PORTAL_ORIGINS[0]}/`);
  }

  return sender.id === browser.runtime.id || Boolean(sender.url?.startsWith(browser.runtime.getURL("")));
}

function errorResponse(
  request: ExtensionMessage | undefined,
  code: ClientErrorPayload["code"],
  message: string
) {
  return createClientErrorEnvelope({
    actor: "service_worker",
    code,
    idempotencyKey: request?.idempotencyKey,
    message,
    traceId: request?.traceId
  });
}

function sendAsyncResponse(
  request: ExtensionMessage,
  sendResponse: (response?: unknown) => void,
  operation: Promise<ExtensionMessage>,
  failureMessage: string
) {
  void operation.then((response) => {
    logRuntimeEvent({
      component: "service_worker",
      eventName: "message.responded",
      idempotencyKey: request.idempotencyKey,
      metadata: {},
      result: "succeeded",
      safeSummary: `Runtime response emitted for ${request.type}.`,
      severity: "debug",
      traceId: request.traceId
    });
    sendResponse(response);
  }).catch(() => {
    logRuntimeEvent({
      component: "service_worker",
      eventName: "runtime.error",
      idempotencyKey: request.idempotencyKey,
      metadata: {},
      reason: "async_operation_failed",
      result: "failed",
      safeSummary: failureMessage,
      severity: "error",
      traceId: request.traceId
    });
    sendResponse(errorResponse(request, "queue_read_failed", failureMessage));
  });
}

async function openSidePanel(request: ExtensionMessageByType<"extension.sidepanel.open_requested">) {
  try {
    const currentWindow = await browser.windows.getCurrent();
    const sidePanelApi = browser.sidePanel as
      | { open?: (options: { windowId: number }) => Promise<void> }
      | undefined;
    const canOpen = Boolean(sidePanelApi?.open && currentWindow.id);

    if (canOpen && currentWindow.id) {
      await sidePanelApi?.open?.({ windowId: currentWindow.id });
    }

    return createEnvelope({
      actor: "service_worker",
      idempotencyKey: request.idempotencyKey,
      payload: {
        opened: canOpen,
        reason: canOpen ? "opened" : "api_unavailable"
      },
      traceId: request.traceId,
      type: "extension.sidepanel.open_responded"
    });
  } catch {
    return errorResponse(request, "sidepanel_open_failed", "Chrome could not open the side panel.");
  }
}

export default defineBackground(() => {
  logRuntimeEvent({
    component: "service_worker",
    eventName: "service_worker.started",
    metadata: {},
    result: "observed",
    safeSummary: "Fixture-mode service worker started with structured logging.",
    severity: "info",
    traceId: "trace:service-worker:started"
  });

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: Browser.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      const parsed = parseExtensionMessage(message);
      if (!parsed.ok) {
        logRuntimeEvent({
          component: "service_worker",
          eventName: "message.rejected",
          metadata: {},
          reason: "validation_failed",
          result: "rejected",
          safeSummary: "Malformed runtime message rejected by schema validation.",
          severity: "warn",
          traceId: parsed.error.traceId
        });
        sendResponse(parsed.error);
        return false;
      }

      const request = parsed.message;

      if (!senderAllowed(request, sender)) {
        logRuntimeEvent({
          component: "service_worker",
          eventName: "message.rejected",
          idempotencyKey: request.idempotencyKey,
          metadata: {},
          reason: "unsupported_sender",
          result: "rejected",
          safeSummary: "Runtime message rejected because sender was not allowed for the actor.",
          severity: "warn",
          traceId: request.traceId
        });
        sendResponse(errorResponse(request, "unsupported_sender", "Message sender is not allowed for this actor."));
        return false;
      }

      if (request.type === "extension.status.requested") {
        sendAsyncResponse(
          request,
          sendResponse,
          (async () => {
            const permissionState = await readPermissionState();
            const queueState = await ensureFixtureQueueState({
              permissionState,
              traceId: request.traceId
            });
            return createStatusResponse(request, queueState, permissionState);
          })(),
          "Status could not be loaded from the local fixture queue."
        );
        return true;
      }

      if (request.type === "extension.sidepanel.open_requested") {
        sendAsyncResponse(request, sendResponse, openSidePanel(request), "Side panel action failed.");
        return true;
      }

      if (request.type === "visa.portal.context_detected") {
        logRuntimeEvent({
          component: "content_script",
          eventName: "message.responded",
          idempotencyKey: request.idempotencyKey,
          metadata: {},
          result: "observed",
          safeSummary: "Supported AIS page context detected; no page content was logged.",
          severity: "info",
          traceId: request.traceId
        });
        sendResponse(createReadyResponse(request));
        return false;
      }

      if (request.type === "visa.availability.check_requested") {
        sendAsyncResponse(
          request,
          sendResponse,
          (async () => {
            const permissionState = await readPermissionState();
            const queueState = await recordFixtureCheck({
              idempotencyKey: request.idempotencyKey,
              permissionState,
              traceId: request.traceId
            });
            return createCooldownResponse(request, queueState);
          })(),
          "Fixture availability check could not be recorded."
        );
        return true;
      }

      if (request.type === "visa.queue.state_requested") {
        sendAsyncResponse(request, sendResponse, createQueueStateResponse(request), "Queue state could not be loaded.");
        return true;
      }

      if (request.type === "visa.debug.export_requested") {
        sendAsyncResponse(request, sendResponse, createDebugExportResponse(request), "Debug export could not be loaded.");
        return true;
      }

      if (request.type === "visa.notification.test_requested") {
        sendAsyncResponse(
          request,
          sendResponse,
          createNotificationDeliveryResponse(request),
          "Fixture notification could not be delivered."
        );
        return true;
      }

      logRuntimeEvent({
        component: "service_worker",
        eventName: "message.rejected",
        idempotencyKey: request.idempotencyKey,
        metadata: {},
        reason: "unsupported_action",
        result: "rejected",
        safeSummary: "Runtime message type was valid but not handled by this service worker.",
        severity: "warn",
        traceId: request.traceId
      });
      sendResponse(errorResponse(request, "unsupported_action", "Message type is valid but not handled here."));
      return false;
    }
  );
});
