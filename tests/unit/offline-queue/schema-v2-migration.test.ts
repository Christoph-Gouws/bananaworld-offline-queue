// Unit test — CR-DC-068 AC-8: the IndexedDB version 1 → 2 upgrade keeps every queued write.
//
// Anchors: CR-DC-068 (D-3), PRD-NFR-005 (zero data loss), TECH-COMP-006.
//
// 🔴 WHY THIS SUITE EXISTS AND WHY IT IS SHAPED THIS WAY. Tablets in the field are carrying queued
// writes RIGHT NOW. A version-2 upgrade that recreated `pending_writes` would destroy exactly the
// data this change exists to protect — and it would do so silently, on every tablet, the first time
// the new app build loaded. Reading the upgrade function and satisfying yourself that it looks
// additive is NOT proof of that; the schema file's own rule ("never drop or rename") was already
// written down and would not have stopped the mistake either.
//
// So every test below opens a REAL version-1 database, by hand, at version 1, with rows in it, and
// then opens it through the production `openOfflineQueueDB()`. What survives is what this suite
// asserts.
//
// ⚠ CR-DC-088 MOVED `DB_VERSION` TO 3, SO THIS SUITE NOW EXERCISES A 1 → 3 JUMP IN ONE
//   `versionchange` TRANSACTION — the v2 identity backfill AND the v3 `driver_reads` creation, back
//   to back. THAT IS A STRICTLY STRONGER FENCE, not a weakened one: a tablet that has been offline
//   long enough to skip a release is exactly the tablet carrying the most queued work, and this is
//   the only thing proving its PODs survive two migrations at once. 🔴 NOTHING HERE WAS RELAXED —
//   every byte-identity assertion, the not-recreated assertion and the never-replayed assertion are
//   as CR-DC-068 wrote them. Only the version number and the store LIST moved, and the store list
//   moved by ADDING a name. The 2 → 3 path has its own suite (schema-v3-migration.test.ts).

import { afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  DB_NAME,
  getPendingWrites,
  openOfflineQueueDB,
  writeBelongsToSession,
  type OfflineQueueDB,
  type PendingWriteRecord,
} from "@/lib/offline-queue";
import { stationSession } from "../../helpers/fake-indexeddb";

// The EXACT version-1 row shape: no operatorId, no stationId. Written with the raw IndexedDB API so
// the current typed schema cannot quietly add the new fields for us.
interface V1Row {
  idempotencyKey: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  queuedAt: string;
  lastAttemptAt: string | null;
  attemptCount: number;
  status: string;
  failureReason: string | null;
  failureMessage: string | null;
  warehouseId: string | null;
}

function v1Row(n: number): V1Row {
  return {
    idempotencyKey: `v1-key-${n}`,
    method: "POST",
    url: `https://app.bananaworld-dc.test/api/item-receipt?n=${n}`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pallet: `BANANA-${n.toString().padStart(4, "0")}`, weightKg: 18.4 + n }),
    queuedAt: `2026-08-19T09:0${n}:00.000Z`,
    lastAttemptAt: null,
    attemptCount: 0,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    warehouseId: "wh-a",
  };
}

/**
 * Build a genuine version-1 database: the M007 schema exactly as it shipped, populated with the
 * given rows, then closed. This is the tablet in the cold room, mid-shift, before the app updates.
 */
async function createPopulatedV1DB(rows: V1Row[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
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
    const tx = db.transaction("pending_writes", "readwrite");
    const store = tx.objectStore("pending_writes");
    for (const row of rows) store.add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

let upgraded: OfflineQueueDB | null = null;

describe("CR-DC-068 AC-8 — opening a POPULATED version-1 database at the current version", () => {
  afterEach(() => {
    upgraded?.close();
    upgraded = null;
  });

  it("keeps every queued write — bodies and idempotency keys byte-identical", async () => {
    const seeded = [v1Row(1), v1Row(2), v1Row(3)];
    await createPopulatedV1DB(seeded);

    upgraded = await openOfflineQueueDB();
    expect(upgraded.version).toBe(3);

    const rows = await getPendingWrites(upgraded);
    expect(rows).toHaveLength(3);
    for (const original of seeded) {
      const row = rows.find((r) => r.idempotencyKey === original.idempotencyKey);
      expect(row).toBeDefined();
      // Byte-identical on everything that carries the operator's actual work.
      expect(row?.body).toBe(original.body);
      expect(row?.url).toBe(original.url);
      expect(row?.method).toBe(original.method);
      expect(row?.queuedAt).toBe(original.queuedAt);
      expect(row?.warehouseId).toBe(original.warehouseId);
      expect(row?.attemptCount).toBe(original.attemptCount);
      expect(row?.status).toBe(original.status);
    }
  });

  it("the store was NOT recreated — its indexes and auto-increment keys are the originals", async () => {
    await createPopulatedV1DB([v1Row(1), v1Row(2), v1Row(3)]);

    upgraded = await openOfflineQueueDB();
    const tx = upgraded.transaction("pending_writes", "readonly");
    const store = tx.objectStore("pending_writes");
    // A recreated store would have lost these; a recreated-and-rebuilt one would have renumbered.
    expect([...store.indexNames].sort()).toEqual([
      "by_idempotency_key",
      "by_queued_at",
      "by_status",
    ]);
    const keys = await store.getAllKeys();
    await tx.done;
    expect(keys).toEqual([1, 2, 3]);
  });

  it("backfills the identity fields to null — present, and explicitly unknown", async () => {
    await createPopulatedV1DB([v1Row(1)]);

    upgraded = await openOfflineQueueDB();
    const rows = await getPendingWrites(upgraded);
    expect(rows[0]?.operatorId).toBeNull();
    expect(rows[0]?.stationId).toBeNull();
  });

  // 🔴 The correctness of this change does NOT depend on the backfill: the comparison is the
  // control and the backfill is tidiness. A migrated row is held for a human either way.
  it("a migrated version-1 row can never be replayed under a live session", async () => {
    await createPopulatedV1DB([v1Row(1), v1Row(2), v1Row(3)]);

    upgraded = await openOfflineQueueDB();
    const rows = await getPendingWrites(upgraded);
    for (const row of rows) {
      expect(writeBelongsToSession(row, stationSession())).toBe(false);
    }
  });

  it("sync_history and session_token survive the upgrade untouched", async () => {
    await createPopulatedV1DB([v1Row(1)]);
    upgraded = await openOfflineQueueDB();
    expect([...upgraded.objectStoreNames].sort()).toEqual([
      "driver_reads",
      "pending_writes",
      "session_token",
      "sync_history",
    ]);
  });

  it("a FRESH install still gets the whole schema (the version-0 path is intact)", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });

    upgraded = await openOfflineQueueDB();
    expect(upgraded.version).toBe(3);
    expect([...upgraded.objectStoreNames].sort()).toEqual([
      "driver_reads",
      "pending_writes",
      "session_token",
      "sync_history",
    ]);
    const rows: PendingWriteRecord[] = await getPendingWrites(upgraded);
    expect(rows).toEqual([]);
  });
});
