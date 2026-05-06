import {
  NotificationDispatchBundleSchema,
  createFixtureNotificationDispatch,
  createNotificationPreferences,
  type NotificationDeliveryResult,
  type NotificationDispatchBundle,
  type VisaQueueStatePayload
} from "@slot-signal/contracts";

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

function replaceBrowserDelivery(
  dispatch: NotificationDispatchBundle,
  replacement: NotificationDeliveryResult
): NotificationDispatchBundle {
  return NotificationDispatchBundleSchema.parse({
    ...dispatch,
    deliveries: dispatch.deliveries.map((delivery) => {
      return delivery.channel === "browser" ? replacement : delivery;
    })
  });
}

function failedBrowserDelivery(
  delivery: NotificationDeliveryResult,
  reason: "browser_api_unavailable" | "missing_permission",
  detail?: unknown
): NotificationDeliveryResult {
  const diagnostic =
    detail instanceof Error
      ? `${detail.name}:${detail.message}`.replace(/[^A-Za-z0-9 ._:-]+/g, "").slice(0, 140)
      : null;

  return {
    ...delivery,
    providerMessageId: diagnostic ? `error:${diagnostic}` : null,
    reason,
    status: "failed"
  };
}

export async function deliverFixtureBrowserNotification({
  browserNotifications,
  iconUrl,
  idempotencyKey,
  queueState,
  traceId
}: {
  browserNotifications: BrowserNotificationApi | undefined;
  iconUrl: string;
  idempotencyKey: string;
  queueState: VisaQueueStatePayload;
  traceId: string;
}): Promise<NotificationDispatchBundle> {
  const dispatch = createFixtureNotificationDispatch({
    idempotencyKey,
    preferences: createNotificationPreferences({
      browser: true,
      email: false,
      telegram: true
    }),
    queueState,
    traceId
  });
  const browserDelivery = dispatch.deliveries.find((delivery) => delivery.channel === "browser");
  if (!browserDelivery) return dispatch;
  if (browserDelivery.status === "suppressed") return dispatch;

  if (!browserNotifications?.create) {
    return replaceBrowserDelivery(dispatch, failedBrowserDelivery(browserDelivery, "browser_api_unavailable"));
  }

  try {
    const message = browserDelivery.safeMessage;
    await browserNotifications.create(dispatch.notification.notificationId, {
      iconUrl,
      message: message.body,
      priority: 1,
      title: message.title,
      type: "basic"
    });
    return dispatch;
  } catch (error) {
    return replaceBrowserDelivery(dispatch, failedBrowserDelivery(browserDelivery, "browser_api_unavailable", error));
  }
}
