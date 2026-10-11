// Unit test — CR-DC-070: the tablet's sync history is bounded, and reading it no longer costs more
// as the station gets older.
//
// Anchors: CR-DC-070 (D-1, §3.1, §4), CLAUDE.md (audit-log retention >= 5 years, D-038 HACCP /
//          GlobalGAP), PRD-NFR-005 (zero data loss), TECH-COMP-006, UX-SCREEN-230.
//
// 🔴 THE ONE THAT MATTERS MOST IS T-5. `synced` rows are prunable because the SERVER holds the
// record of a write that arrived; `discarded` rows are not, because nothing outside this tablet holds
// them — the write never reached the server, so the server has never heard of it. T-5 reddens the
// moment anyone prunes a discarded row on the synced rule, which is the single edit that would turn
// this housekeeping change into evidence destruction.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SYNCED_HISTORY_RETENTION,
  enqueueWrite,
  getPendingWrites,
  getRecentHistory,
  markWriteFailed,
  openOfflineQueueDB,
  pruneSyncHistory,
  type OfflineQueueDB,
  type SyncHistoryRecord,
} from "@/lib/offline-queue";
import {
  withFakeIndexedDB,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const BASE_MS = Date.parse("2026-08-19T06:00:00.000Z");

/** `finalisedAt` for row `n` — strictly increasing, so "newest" is unambiguous at every index. */
function finalisedAt(n: number): string {
  return new Date(BASE_MS + n * 60_000).toISOString();
}

/** Seeded in ONE transaction — 640 separate `db.add` calls are 640 transactions and are slow enough
 *  to trip vitest's hook timeout on CI. */
async function seedHistory(
  count: number,
  outcome: SyncHistoryRecord["outcome"],
  startIndex = 0,
): Promise<string[]> {
  const keys: string[] = [];
  const writes: Array<Promise<unknown>> = [];
  const tx = db.transaction("sync_history", "readwrite");
  const store = tx.objectStore("sync_history");
  for (let i = 0; i < count; i += 1) {
    const n = startIndex + i;
    const key = `${outcome}-${n}`;
    writes.push(
      store.add({
        idempotencyKey: key,
        outcome,
        finalisedAt: finalisedAt(n),
        method: "POST",
        url: `https://app.test/api/item-receipt/${n}`,
        discardReasonCode: outcome === "discarded" ? "OPERATOR_OBSOLETED" : null,
        discardReasonText: outcome === "discarded" ? "no longer needed" : null,
      }),
    );
    keys.push(key);
  }
  await Promise.all(writes);
  await tx.done;
  return keys;
}

async function allHistory(): Promise<SyncHistoryRecord[]> {
  return db.getAll("sync_history");
}

/** Indexed access under `noUncheckedIndexedAccess`, but LOUD: a fixture that lost a row fails here
 *  rather than quietly comparing against `undefined`. */
function at<T>(rows: readonly T[], index: number): T {
  const row = rows.at(index);
  if (row === undefined) throw new Error(`fixture has no element at index ${index}`);
  return row;
}

describe("CR-DC-070 — pruneSyncHistory", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  // Harness rule: every IndexedDB spec closes its connection, or the next `deleteDatabase` is
  // blocked and the following test silently inherits this one's rows.
  afterEach(() => db.close());

  // T-1 — a store seeded well past the bound is pruned TO it, not merely "reduced".
  it("prunes a store seeded well past the bound down to exactly the retention count", async () => {
    const keys = await seedHistory(640, "synced");
    expect((await allHistory()).length).toBe(640);

    const deleted = await pruneSyncHistory(db);

    expect(deleted).toBe(640 - SYNCED_HISTORY_RETENTION);
    const remaining = await allHistory();
    expect(remaining.length).toBe(SYNCED_HISTORY_RETENTION);
    // And they are the NEWEST 200 — an implementation that kept the oldest 200 would also leave 200
    // rows behind, so the count alone proves nothing.
    const remainingKeys = new Set(remaining.map((row) => row.idempotencyKey));
    expect(remainingKeys.has(at(keys, 639))).toBe(true);
    expect(remainingKeys.has(at(keys, 440))).toBe(true);
    expect(remainingKeys.has(at(keys, 439))).toBe(false);
    expect(remainingKeys.has(at(keys, 0))).toBe(false);
  });

  it("deletes nothing when the store is already inside the bound", async () => {
    await seedHistory(12, "synced");
    expect(await pruneSyncHistory(db)).toBe(0);
    expect((await allHistory()).length).toBe(12);
  });

  it("is idempotent — a second pass over an already-pruned store deletes nothing", async () => {
    await seedHistory(260, "synced");
    expect(await pruneSyncHistory(db)).toBe(60);
    expect(await pruneSyncHistory(db)).toBe(0);
    expect((await allHistory()).length).toBe(SYNCED_HISTORY_RETENTION);
  });

  it("honours an explicit bound so the constant is a default, not a hard-coded rule", async () => {
    await seedHistory(50, "synced");
    expect(await pruneSyncHistory(db, 10)).toBe(40);
    expect((await allHistory()).length).toBe(10);
  });

  // T-4 — un-sent work is never housekeeping. `failed` is in the fixture deliberately: it is the
  // status an operator is most likely to be looking at when a prune happens to run.
  it("leaves every pending write untouched, including failed ones", async () => {
    for (const [n, status] of [
      [0, "queued"],
      [1, "syncing"],
      [2, "failed"],
    ] as const) {
      await enqueueWrite(db, {
        idempotencyKey: `pending-${n}`,
        method: "POST",
        url: `https://app.test/api/item-receipt/p${n}`,
        headers: {},
        body: JSON.stringify({ n }),
        queuedAt: finalisedAt(n),
        warehouseId: TEST_SESSION_WAREHOUSE,
        operatorId: TEST_SESSION_OPERATOR,
        stationId: TEST_SESSION_STATION,
      });
      if (status !== "queued") {
        const row = await db.getFromIndex("pending_writes", "by_idempotency_key", `pending-${n}`);
        if (row) await db.put("pending_writes", { ...row, status });
      }
    }
    await markWriteFailed(db, "pending-2", "SERVER_MASTER_WINS", "rejected", finalisedAt(2));

    await seedHistory(640, "synced");
    const before = JSON.stringify(await getPendingWrites(db));

    await pruneSyncHistory(db);

    // Byte-identical: not "still three rows", but the same three rows with the same field values.
    expect(JSON.stringify(await getPendingWrites(db))).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // T-5 — 🔴 D-1. THE FENCE. Do not relax this test; change the decision first.
  // ---------------------------------------------------------------------------
  //
  // A discard is an operator abandoning work that NEVER REACHED THE SERVER. There is therefore no
  // server-side record to fall back on: `POST /api/audit/queue-action` exists but no client calls it
  // (verified at build — the route file is its only occurrence in src/**, app/** and tests/**), so
  // the M007-DEC-007 deferral is still open in shipped behaviour. This row, and the operator's typed
  // reason on it, is the ONLY evidence the work existed and was abandoned. UX-SCREEN-230 also
  // promises the operator in writing that it is kept.
  //
  // The discarded rows are seeded OLDEST OF ALL on purpose: under any age-based or naive
  // count-based rule they would be the first things deleted.
  it("never deletes a discarded row — at any age, at any count (D-1)", async () => {
    await seedHistory(5, "discarded", 0); // the five OLDEST rows in the store
    await seedHistory(300, "synced", 100);

    const deleted = await pruneSyncHistory(db);

    const remaining = await allHistory();
    const discarded = remaining.filter((row) => row.outcome === "discarded");
    const synced = remaining.filter((row) => row.outcome === "synced");

    // All five survive, with their reasons intact.
    expect(discarded.length).toBe(5);
    expect(discarded.every((row) => row.discardReasonCode === "OPERATOR_OBSOLETED")).toBe(true);
    // And the synced rows were still pruned to the bound around them.
    expect(synced.length).toBe(SYNCED_HISTORY_RETENTION);
    expect(deleted).toBe(100);
  });

  it("does not count discarded rows toward the retention bound", async () => {
    // 200 synced + 40 discarded, and 🔴 THE DISCARDED ONES ARE THE NEWEST — that ordering is the
    // whole test. The cursor walks newest-first, so a counter that ticked on a discarded row would
    // reach 40 before it saw a single synced row, and the OLDEST 40 SYNCED ROWS WOULD BE DELETED to
    // make room for rows that are never deleted anyway. With the discarded rows seeded oldest
    // instead, they come last and the bug is invisible — verified by mutation: with this fixture
    // reversed, moving `kept += 1` above the skip changes nothing and the suite stays green.
    await seedHistory(SYNCED_HISTORY_RETENTION, "synced", 0);
    await seedHistory(40, "discarded", 900);

    expect(await pruneSyncHistory(db)).toBe(0);
    const remaining = await allHistory();
    expect(remaining.filter((r) => r.outcome === "synced").length).toBe(SYNCED_HISTORY_RETENTION);
    expect(remaining.filter((r) => r.outcome === "discarded").length).toBe(40);
  });

  it("prunes a store that is entirely discarded rows down to nothing at all", async () => {
    await seedHistory(500, "discarded");
    expect(await pruneSyncHistory(db)).toBe(0);
    expect((await allHistory()).length).toBe(500);
  });
});

describe("CR-DC-070 — getRecentHistory reads only what it returns", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  // Harness rule: every IndexedDB spec closes its connection, or the next `deleteDatabase` is
  // blocked and the following test silently inherits this one's rows.
  afterEach(() => db.close());

  // T-2 — the twenty rows are the correct twenty, newest first. Ordering is the part a bounded read
  // could silently get wrong (a forward cursor would return the OLDEST twenty and still return
  // twenty), so this asserts the keys, in order, not the length.
  it("returns the newest 20 rows, newest first", async () => {
    const keys = await seedHistory(120, "synced");

    const rows = await getRecentHistory(db);

    expect(rows.length).toBe(20);
    expect(rows.map((r) => r.idempotencyKey)).toEqual(keys.slice(100).reverse());
    expect(at(rows, 0).finalisedAt > at(rows, 19).finalisedAt).toBe(true);
  });

  it("returns every row, newest first, when the store holds fewer than the limit", async () => {
    const keys = await seedHistory(3, "synced");
    const rows = await getRecentHistory(db);
    expect(rows.map((r) => r.idempotencyKey)).toEqual(keys.slice().reverse());
  });

  it("returns an empty list for an empty store", async () => {
    expect(await getRecentHistory(db)).toEqual([]);
  });

  it("honours an explicit limit", async () => {
    const keys = await seedHistory(50, "synced");
    const rows = await getRecentHistory(db, 5);
    expect(rows.map((r) => r.idempotencyKey)).toEqual(keys.slice(45).reverse());
  });

  it("returns nothing, and reads nothing, for a non-positive limit", async () => {
    await seedHistory(10, "synced");
    expect(await getRecentHistory(db, 0)).toEqual([]);
  });

  // Both outcomes appear in the window: this is a history pane, not a success log. The retention
  // rule differs by outcome; the READ does not.
  it("includes discarded rows in the window alongside synced ones", async () => {
    await seedHistory(3, "synced", 0);
    await seedHistory(2, "discarded", 10);
    const rows = await getRecentHistory(db);
    expect(rows.map((r) => r.outcome)).toEqual([
      "discarded",
      "discarded",
      "synced",
      "synced",
      "synced",
    ]);
  });
});
