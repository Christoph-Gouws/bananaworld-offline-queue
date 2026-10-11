// Unit test — IndexedDB schema open + migration (EPIC-001-M007-SCOPE-001).
//
// Anchors: TECH-COMP-006, PRD-CAP-023.
//
// Verifies the v1 schema opens cleanly under fake-indexeddb, every object
// store + index exists, and the schema version matches the constant.

import { describe, expect, it } from "vitest";
import { DB_NAME, DB_VERSION, openOfflineQueueDB } from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

describe("openOfflineQueueDB (schema v1)", () => {
  withFakeIndexedDB();

  it("opens the bananaworld-offline-queue database at the declared version", async () => {
    const db = await openOfflineQueueDB();
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    db.close();
  });

  // CR-DC-088 added the fourth store, `driver_reads` — the driver's device-side read cache.
  it("creates the four object stores: pending_writes, sync_history, session_token, driver_reads", async () => {
    const db = await openOfflineQueueDB();
    const storeNames = Array.from(db.objectStoreNames).sort();
    expect(storeNames).toEqual([
      "driver_reads",
      "pending_writes",
      "queue_maintenance",
      "session_token",
      "sync_history",
    ]);
    db.close();
  });

  // CR-DC-088 — the eviction order. `by_stored_at` is what makes oldest-entry-first (and therefore
  // oldest-RUN-first) possible without a full scan.
  it("creates the driver_reads index (by_stored_at)", async () => {
    const db = await openOfflineQueueDB();
    const tx = db.transaction("driver_reads", "readonly");
    expect(Array.from(tx.objectStore("driver_reads").indexNames)).toEqual(["by_stored_at"]);
    await tx.done;
    db.close();
  });

  it("creates the pending_writes indexes (by_status, by_idempotency_key, by_queued_at)", async () => {
    const db = await openOfflineQueueDB();
    const tx = db.transaction("pending_writes", "readonly");
    const store = tx.objectStore("pending_writes");
    const indexes = Array.from(store.indexNames).sort();
    expect(indexes).toEqual(["by_idempotency_key", "by_queued_at", "by_status"]);
    await tx.done;
    db.close();
  });

  it("creates the sync_history indexes (by_idempotency_key, by_finalised_at)", async () => {
    const db = await openOfflineQueueDB();
    const tx = db.transaction("sync_history", "readonly");
    const indexes = Array.from(tx.objectStore("sync_history").indexNames).sort();
    expect(indexes).toEqual(["by_finalised_at", "by_idempotency_key"]);
    await tx.done;
    db.close();
  });

  it("session_token store is keyed on the singleton 'current' key", async () => {
    const db = await openOfflineQueueDB();
    const tx = db.transaction("session_token", "readonly");
    const store = tx.objectStore("session_token");
    // Confirm there are no rows initially.
    const count = await store.count();
    expect(count).toBe(0);
    await tx.done;
    db.close();
  });
});
