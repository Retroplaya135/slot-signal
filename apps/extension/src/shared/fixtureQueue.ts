import {
  QueueRecordSchema,
  DEBUG_EXPORT_SCHEMA_VERSION,
  QUEUE_RETENTION_LIMIT,
  createWorkflowFixtureBundle,
  deriveVisaQueueState,
  mergeQueueRecords,
  parseQueueRecordsForIntegrity,
  type QueueRecord,
  type QueueIntegritySummary,
  type QuarantinedQueueRecord,
  type NotificationDispatchBundle,
  type VisaDebugExportPayload,
  type VisaQueueStatePayload
} from "@slot-signal/contracts";

const DB_NAME = "slot-signal-queue_fixture-queue";
const STORE_NAME = "records";
const QUARANTINE_STORE_NAME = "quarantine";
const DB_VERSION = 2;
const DEBUG_EXPORT_FIELD_PATTERNS = ["password", "credential", "secret", "token", "cookie", "rawPortalPayload"] as const;

let memoryRecords: QueueRecord[] = [];

type QueueLoadResult = {
  integrity: QueueIntegritySummary;
  records: QueueRecord[];
  restartRecovery: VisaQueueStatePayload["restartRecovery"];
};

function openDb(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(QUARANTINE_STORE_NAME)) {
        db.createObjectStore(QUARANTINE_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function emptyIntegrity(records: QueueRecord[], compactedRecordCount = 0): QueueIntegritySummary {
  return {
    compactedRecordCount,
    corruptRecordCount: 0,
    quarantineStoreCount: 0,
    retentionLimit: QUEUE_RETENTION_LIMIT,
    validRecordCount: records.length
  };
}

function readObjectStore<T>(transaction: IDBTransaction, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = transaction.objectStore(storeName).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as T[]);
  });
}

async function readQueueStores(db: IDBDatabase): Promise<{ quarantinedRecords: QuarantinedQueueRecord[]; rawRecords: unknown[] }> {
  const transaction = db.transaction([STORE_NAME, QUARANTINE_STORE_NAME], "readonly");
  const rawRecordsPromise = readObjectStore<unknown>(transaction, STORE_NAME);
  const quarantinedPromise = readObjectStore<QuarantinedQueueRecord>(transaction, QUARANTINE_STORE_NAME);

  return {
    quarantinedRecords: await quarantinedPromise,
    rawRecords: await rawRecordsPromise
  };
}

async function loadRecords(): Promise<QueueLoadResult> {
  const db = await openDb();
  if (!db) {
    return {
      integrity: emptyIntegrity(memoryRecords),
      records: memoryRecords,
      restartRecovery: "memory_fallback"
    };
  }

  const stores = await readQueueStores(db);
  const parsed = parseQueueRecordsForIntegrity({
    existingQuarantineCount: stores.quarantinedRecords.length,
    rawRecords: stores.rawRecords
  });

  if (parsed.corruptRecords.length > 0 || parsed.integrity.compactedRecordCount > 0) {
    await persistRecords(parsed.records, parsed.corruptRecords);
  }

  db.close();
  return {
    integrity: parsed.integrity,
    records: parsed.records,
    restartRecovery: parsed.records.length > 0 ? "indexeddb_loaded" : "empty_initialized"
  };
}

async function persistRecords(records: QueueRecord[], quarantinedRecords: QuarantinedQueueRecord[] = []): Promise<QueueIntegritySummary> {
  const parsedRecords = parseQueueRecordsForIntegrity({
    rawRecords: records
  });
  const db = await openDb();
  if (!db) {
    memoryRecords = parsedRecords.records;
    return parsedRecords.integrity;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME, QUARANTINE_STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const quarantineStore = transaction.objectStore(QUARANTINE_STORE_NAME);

    store.clear();
    for (const record of parsedRecords.records) {
      store.put(record);
    }
    for (const record of quarantinedRecords) {
      store.delete(record.key);
      quarantineStore.put(record);
    }

    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
  });

  return parsedRecords.integrity;
}

function hasFixtureSnapshot(records: QueueRecord[]) {
  return records.some((record) => record.kind === "snapshot" && record.payload.sourceKind === "fixture");
}

function deriveState(
  records: QueueRecord[],
  restartRecovery: VisaQueueStatePayload["restartRecovery"],
  permissionState: VisaQueueStatePayload["permissionState"],
  integrity: QueueIntegritySummary
) {
  return deriveVisaQueueState({
    integrity,
    permissionState,
    records,
    restartRecovery
  });
}

function collectBannedFieldFindings(input: unknown, path: string[] = []): string[] {
  if (!input || typeof input !== "object") return [];

  if (Array.isArray(input)) {
    return input.flatMap((item, index) => collectBannedFieldFindings(item, [...path, String(index)]));
  }

  return Object.entries(input).flatMap(([key, value]) => {
    const keyLower = key.toLowerCase();
    const keyPath = [...path, key];
    const ownFindings = DEBUG_EXPORT_FIELD_PATTERNS.some((pattern) => keyLower.includes(pattern.toLowerCase()))
      ? [keyPath.join(".")]
      : [];
    return [...ownFindings, ...collectBannedFieldFindings(value, keyPath)];
  });
}

export async function ensureFixtureQueueState({
  permissionState,
  traceId
}: {
  permissionState: VisaQueueStatePayload["permissionState"];
  traceId: string;
}) {
  const loaded = await loadRecords();
  if (hasFixtureSnapshot(loaded.records)) {
    return deriveState(loaded.records, loaded.restartRecovery, permissionState, loaded.integrity);
  }

  const fixture = createWorkflowFixtureBundle({
    idempotencyKey: "idem:source_adapter:fixture:seed",
    requestId: "request:source_adapter:fixture:seed",
    traceId
  });
  const merged = mergeQueueRecords(loaded.records, fixture.records);
  const integrity = await persistRecords(merged);
  return deriveState(merged, loaded.restartRecovery, permissionState, {
    ...integrity,
    corruptRecordCount: loaded.integrity.corruptRecordCount,
    quarantineStoreCount: loaded.integrity.quarantineStoreCount
  });
}

export async function recordFixtureCheck({
  idempotencyKey,
  permissionState,
  traceId
}: {
  idempotencyKey: string;
  permissionState: VisaQueueStatePayload["permissionState"];
  traceId: string;
}) {
  const loaded = await loadRecords();
  const currentState = deriveState(loaded.records, loaded.restartRecovery, permissionState, loaded.integrity);
  if (currentState.cooldown.active) {
    return currentState;
  }

  const fixture = createWorkflowFixtureBundle({
    idempotencyKey,
    traceId
  });
  const merged = mergeQueueRecords(loaded.records, fixture.records);
  const integrity = await persistRecords(merged);
  return deriveState(merged, loaded.restartRecovery, permissionState, {
    ...integrity,
    corruptRecordCount: loaded.integrity.corruptRecordCount,
    quarantineStoreCount: loaded.integrity.quarantineStoreCount
  });
}

export async function persistFixtureNotificationDispatch({
  dispatch,
  idempotencyKey,
  permissionState,
  traceId
}: {
  dispatch: NotificationDispatchBundle;
  idempotencyKey: string;
  permissionState: VisaQueueStatePayload["permissionState"];
  traceId: string;
}) {
  const loaded = await loadRecords();
  const notificationRecords: QueueRecord[] = [
    QueueRecordSchema.parse({
      createdAt: dispatch.notification.createdAt,
      idempotencyKey,
      key: `notification:${dispatch.notification.notificationId}`,
      kind: "notification",
      payload: dispatch.notification,
      traceId
    }),
    ...dispatch.deliveries.map((delivery) =>
      QueueRecordSchema.parse({
        createdAt: delivery.attemptedAt,
        idempotencyKey,
        key: `delivery:${delivery.deliveryId}`,
        kind: "notification_delivery",
        payload: delivery,
        traceId
      })
    ),
    QueueRecordSchema.parse({
      createdAt: dispatch.auditEvent.occurredAt,
      idempotencyKey,
      key: `audit:${dispatch.auditEvent.auditId}`,
      kind: "audit",
      payload: dispatch.auditEvent,
      traceId
    })
  ];
  const merged = mergeQueueRecords(loaded.records, notificationRecords);
  const integrity = await persistRecords(merged);
  return deriveState(merged, loaded.restartRecovery, permissionState, {
    ...integrity,
    corruptRecordCount: loaded.integrity.corruptRecordCount,
    quarantineStoreCount: loaded.integrity.quarantineStoreCount
  });
}

export async function loadFixtureQueueState({
  permissionState
}: {
  permissionState: VisaQueueStatePayload["permissionState"];
}) {
  const loaded = await loadRecords();
  return deriveState(loaded.records, loaded.restartRecovery, permissionState, loaded.integrity);
}

export async function createFixtureDebugExport({
  permissionState
}: {
  permissionState: VisaQueueStatePayload["permissionState"];
}): Promise<VisaDebugExportPayload> {
  const queueState = await loadFixtureQueueState({ permissionState });
  const findings = collectBannedFieldFindings(queueState);
  const exportedAt = new Date().toISOString();

  return {
    bannedFieldScan: {
      checkedFieldPatterns: [...DEBUG_EXPORT_FIELD_PATTERNS],
      findings
    },
    containsSensitiveRawData: false,
    debugSafety: {
      bannedFieldFindingCount: findings.length,
      containsSensitiveRawData: false,
      generatedAt: exportedAt,
      includesPortalPageDump: false,
      includesPrivateAuthData: false,
      redactionLevel: "no_secrets",
      schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION,
      userShareable: true
    },
    exportedAt,
    generatedBy: "service_worker",
    notificationSpamGuard: queueState.notificationSpamGuard,
    observability: queueState.observability,
    queueState,
    redactionLevel: "no_secrets",
    retentionPolicy: queueState.retentionPolicy,
    schemaVersion: DEBUG_EXPORT_SCHEMA_VERSION
  };
}
