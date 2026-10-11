// Unit test — CR-DC-088: the IndexedDB version 2 → 3 upgrade keeps every queued write.
//
// Anchors: CR-DC-088 (§3.1, §3.6), CR-DC-068 (the suite this is modelled on), PRD-NFR-005.
//
// ============================================================================
// 🔴 WHY THIS SUITE EXISTS, AND WHY THE 1 → 3 SUITE IS NOT ENOUGH
// ============================================================================
// 2 → 3 IS THE REAL FIELD CASE. Every driver tablet is on version 2 right now (CR-DC-068 shipped),
// and deliveries begin the week of 2026-08-25 — so the first thing this change does on a live tablet
// is exactly this upgrade, on a device that may be carrying a PROOF OF DELIVERY it has not yet been
// able to send. If `pending_writes` did not survive, the loss would be silent, immediate, and on
// every tablet at once.
//
// Reading the upgrade branch and satisfying yourself that it looks additive is NOT proof of that —
// the schema file's own "never drop or rename" rule was already written down before CR-DC-068 and
// would not have stopped the mistake either. So this opens a REAL version-2 database, by hand, with
// a queued write in it, and then opens it through the production `openOfflineQueueDB()`.

import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import {
  DB_NAME,
  DB_VERSION,
  getPendingWrites,
  openOfflineQueueDB,
  readStationSession,
  type OfflineQueueDB,
} from "@/lib/offline-queue";

/** A version-2 row: CR-DC-068's shape, identity fields and all. */
function v2Row(n: number) {
  return {
    idempotencyKey: `v2-key-${n}`,
    method: "POST",
    url: "https://app.bananaworld-dc.test/api/driver-station/stop/d-1/confirm",
    headers: { "Content-Type": "application/json" },
    // A proof of delivery: the signature rides in the body (DeliveryConfirmation.tsx).
    body: JSON.stringify({ signature_data_url: `data:image/png;base64,AAAA${n}`, lines: [] }),
    queuedAt: `2026-08-23T05:0${n}:00.000Z`,
    lastAttemptAt: null,
    attemptCount: 0,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    warehouseId: "wh-a",
    operatorId: "operator-a",
    stationId: "station-a",
  };
}

/** The M007 + CR-DC-068 schema exactly as it shipped — the tablet in the truck, mid-shift. */
async function createPopulatedV2DB(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const idb = req.result;
      const pendingWrites = idb.createObjectStore("pending_writes", {
        keyPath: "id",
        autoIncrement: true,
      });
      pendingWrites.createIndex("by_status", "status");
      pendingWrites.createIndex("by_idempotency_key", "idempotencyKey", { unique: true });
      pendingWrites.createIndex("by_queued_at", "queuedAt");

      const syncHistory = idb.createObjectStore("sync_history", {
        keyPath: "id",
        autoIncrement: true,
      });
      syncHistory.createIndex("by_idempotency_key", "idempotencyKey", { unique: false });
      syncHistory.createIndex("by_finalised_at", "finalisedAt");

      idb.createObjectStore("session_token", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["pending_writes", "session_token"], "readwrite");
    tx.objectStore("pending_writes").add(v2Row(1));
    tx.objectStore("pending_writes").add(v2Row(2));
    tx.objectStore("session_token").add({
      id: "current",
      token: "tok",
      expiresAt: "2099-01-01T00:00:00.000Z",
      warehouseId: "wh-a",
      stationId: "station-a",
      operatorId: "operator-a",
      storedAt: "2026-08-23T04:00:00.000Z",
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

let upgraded: OfflineQueueDB | null = null;

describe("CR-DC-088 — opening a POPULATED version-2 database at version 3", () => {
  afterEach(() => {
    upgraded?.close();
    upgraded = null;
  });

  it("arrives at the declared version with the new store present", async () => {
    await createPopulatedV2DB();
    upgraded = await openOfflineQueueDB();
    expect(upgraded.version).toBe(DB_VERSION);
    expect(upgraded.version).toBe(4);
    expect([...upgraded.objectStoreNames].sort()).toEqual([
      "driver_reads",
      "pending_writes",
      "queue_maintenance",
      "session_token",
      "sync_history",
    ]);
  });

  // 🔴 THE ONE THAT MATTERS. A queued proof of delivery survives byte-identical.
  it("keeps every queued write — bodies and idempotency keys byte-identical", async () => {
    await createPopulatedV2DB();
    upgraded = await openOfflineQueueDB();

    const rows = await getPendingWrites(upgraded);
    expect(rows).toHaveLength(2);
    for (const n of [1, 2]) {
      const original = v2Row(n);
      const row = rows.find((r) => r.idempotencyKey === original.idempotencyKey);
      expect(row).toBeDefined();
      expect(row?.body).toBe(original.body);
      expect(row?.url).toBe(original.url);
      expect(row?.queuedAt).toBe(original.queuedAt);
      expect(row?.status).toBe(original.status);
      expect(row?.attemptCount).toBe(original.attemptCount);
      // 🔴 AND THE IDENTITY IS NOT REWRITTEN — CR-DC-068's whole point.
      expect(row?.warehouseId).toBe(original.warehouseId);
      expect(row?.operatorId).toBe(original.operatorId);
      expect(row?.stationId).toBe(original.stationId);
    }
  });

  it("the store was NOT recreated — indexes and auto-increment keys are the originals", async () => {
    await createPopulatedV2DB();
    upgraded = await openOfflineQueueDB();
    const tx = upgraded.transaction("pending_writes", "readonly");
    const store = tx.objectStore("pending_writes");
    expect([...store.indexNames].sort()).toEqual([
      "by_idempotency_key",
      "by_queued_at",
      "by_status",
    ]);
    const keys = await store.getAllKeys();
    await tx.done;
    expect(keys).toEqual([1, 2]);
  });

  it("the stored SESSION survives — the operator is not signed out by an upgrade", async () => {
    await createPopulatedV2DB();
    upgraded = await openOfflineQueueDB();
    const session = await readStationSession(upgraded);
    expect(session?.operatorId).toBe("operator-a");
    expect(session?.warehouseId).toBe("wh-a");
  });

  it("the new store starts EMPTY — nothing is invented for an upgrading tablet", async () => {
    await createPopulatedV2DB();
    upgraded = await openOfflineQueueDB();
    expect(await upgraded.count("driver_reads")).toBe(0);
  });
});
