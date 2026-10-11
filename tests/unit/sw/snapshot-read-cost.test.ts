// Unit test — CR-DC-070: showing "Online" no longer costs more as the station gets older.
//
// Anchors: CR-DC-070 (§0.2, §3.1, §4 test 3), TECH-FE-010, UX-DS-013, UX-SCREEN-230.
//
// THE DEFECT. `buildSyncSnapshot` runs on EVERY `SYNC_STATUS_REQUEST` and again after EVERY replay
// batch, and the chip that fires those requests is mounted in the tablet layout — on every station
// screen including the PIN-login screen. It called `getRecentHistory`, which read the WHOLE
// `sync_history` store, sorted it in JS and sliced twenty. Combined with a store that was never
// pruned, the cost of the "Online" badge grew with every write the station had ever made.
//
// 🔴 HOW THIS IS ASSERTED, AND WHY NOT WITH A CLOCK. Wall-clock timing is a CI flake generator and
// proves nothing about the algorithm. `countingHistoryDb` counts the rows actually yielded out of
// `sync_history` by ANY read path — `getAll` on the store, `getAll` on an index, and every cursor
// step — so the number is exact and the OLD implementation cannot hide behind an uninstrumented
// path. T-0 below proves the instrument itself is not vacuous before anything else relies on it, and
// the assertion is then made at TWO store sizes an order of magnitude apart: a counter stuck at zero
// cannot satisfy "exactly 20 at 500 rows AND exactly 20 at 2 000 rows".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyncSnapshot } from "@/sw/message-handlers";
import { getRecentHistory, openOfflineQueueDB, type OfflineQueueDB } from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";
import { countingHistoryDb } from "../../helpers/counting-idb";

let db: OfflineQueueDB;

const BASE_MS = Date.parse("2026-08-19T06:00:00.000Z");

/** Seeded in ONE transaction — 2 000 separate `db.add` calls are 2 000 transactions. */
async function seedHistory(count: number): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  const tx = db.transaction("sync_history", "readwrite");
  const store = tx.objectStore("sync_history");
  for (let n = 0; n < count; n += 1) {
    writes.push(
      store.add({
        idempotencyKey: `synced-${n}`,
        outcome: "synced",
        finalisedAt: new Date(BASE_MS + n * 60_000).toISOString(),
        method: "POST",
        url: `https://app.test/api/item-receipt/${n}`,
        discardReasonCode: null,
        discardReasonText: null,
      }),
    );
  }
  await Promise.all(writes);
  await tx.done;
}

describe("CR-DC-070 — the sync snapshot does not scale with the history store", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // T-0 — THE INSTRUMENT ITSELF. Before any "≤ 21" claim is allowed to mean anything, prove the
  // counter can see a full-store read at all: this is EXACTLY the call the old implementation made,
  // and it must register 500. Without this test, a counter that silently observed nothing would make
  // every assertion below pass for the wrong reason.
  it("counts a whole-store read — the instrument is not vacuous", async () => {
    await seedHistory(500);
    const { db: counted, counter } = countingHistoryDb(db);

    const tx = counted.transaction("sync_history", "readonly");
    const all = await tx.objectStore("sync_history").index("by_finalised_at").getAll();
    await tx.done;

    expect(all.length).toBe(500);
    expect(counter.rowsRead).toBe(500);
  });

  it("reads exactly the 20 rows it returns, not the 500 in the store", async () => {
    await seedHistory(500);
    const { db: counted, counter } = countingHistoryDb(db);

    const rows = await getRecentHistory(counted);

    expect(rows.length).toBe(20);
    expect(counter.rowsRead).toBe(20);
  });

  // 🔴 TWO SIZES, ONE NUMBER. This is the assertion that cannot be satisfied vacuously and cannot be
  // satisfied by the old implementation.
  it("builds the snapshot at a constant history cost — 500 rows and 2 000 rows read the same 20", async () => {
    await seedHistory(500);
    const small = countingHistoryDb(db);
    const snapshotSmall = await buildSyncSnapshot({ db: small.db, isOnline: () => true });

    // A second seeding pass of 2 000 rows on top of the first 500 — the store now holds 2 500.
    await seedHistory(2_000);
    expect((await db.getAll("sync_history")).length).toBe(2_500);
    const large = countingHistoryDb(db);
    const snapshotLarge = await buildSyncSnapshot({ db: large.db, isOnline: () => true });

    expect(small.counter.rowsRead).toBeLessThanOrEqual(21);
    expect(large.counter.rowsRead).toBeLessThanOrEqual(21);
    // The store grew five-fold; the read did not grow at all. 🔴 THIS is the assertion no vacuous
    // counter and no whole-store read can satisfy at both sizes.
    expect(large.counter.rowsRead).toBe(small.counter.rowsRead);
    expect(small.counter.rowsRead).toBe(20);

    // And the snapshot is still CORRECT — a read that returned nothing would also be "constant cost".
    expect(snapshotSmall.recentHistory.length).toBe(20);
    expect(snapshotLarge.recentHistory.length).toBe(20);
    expect(snapshotLarge.lastSyncAt).not.toBeNull();
    // The newest row in the store (the second pass's highest index) is the one it reports first, and
    // is the row `lastSyncAt` is derived from.
    const newest = snapshotLarge.recentHistory[0];
    expect(newest).toBeDefined();
    expect(newest?.idempotencyKey).toBe("synced-1999");
    expect(snapshotLarge.lastSyncAt).toBe(newest?.finalisedAt);
  });

  it("reads nothing at all from an empty history store", async () => {
    const { db: counted, counter } = countingHistoryDb(db);
    const snapshot = await buildSyncSnapshot({ db: counted, isOnline: () => true });
    expect(counter.rowsRead).toBe(0);
    expect(snapshot.recentHistory).toEqual([]);
    expect(snapshot.lastSyncAt).toBeNull();
  });
});
