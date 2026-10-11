// Unit test — CR-DC-070: the retention sweep actually runs on the real trigger, and can never
// change what happened to an operator's work.
//
// Anchors: CR-DC-070 (§3.2, §4 test 9), PRD-NFR-005 (zero data loss), TECH-COMP-006.
//
// 🔴 WHY THE PRUNE LIVES IN `runReplay` AND NOT IN THE SW ENTRY, and why that matters to this file.
// Nothing under tests/** can import `src/sw/index.ts` — it registers service-worker listeners at
// module scope and is serwist-compiled to public/sw.js. A prune call placed there would be
// UNPROVABLE, which is exactly the shape of claim this estate has been burned by. Putting it at the
// end of `runReplay` turns "the housekeeping actually runs" into an assertion. CR-DC-069 set the
// precedent by moving the decision into a tested module for the same reason.
//
// The second half of the file is the safety property: housekeeping is allowed to fail, and when it
// does, every replay outcome must be byte-identical to a run where it succeeded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReplay } from "@/sw/replay-loop";
import {
  SYNCED_HISTORY_RETENTION,
  enqueueWrite,
  getPendingWrites,
  openOfflineQueueDB,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const NOW = new Date("2026-08-19T12:00:00.000Z");
const ORIGIN = "https://app.bananaworld-dc.test";
// 🔴 The seeded history is entirely OLDER than NOW, deliberately. The retention rule keeps the newest
// 200 rows in the store regardless of which pass wrote them, so a fixture whose seeded timestamps
// straddled NOW would have the replayed write's OWN history row fall outside the window — correct
// behaviour, but it would read as a bug in the prune. A day earlier, and 640 minutes of it, is
// unambiguously before 12:00 on the 19th.
const BASE_MS = Date.parse("2026-08-18T00:00:00.000Z");

function okFetch() {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
}

async function seedHistory(
  count: number,
  outcome: "synced" | "discarded" = "synced",
): Promise<void> {
  const writes: Array<Promise<unknown>> = [];
  const tx = db.transaction("sync_history", "readwrite");
  const store = tx.objectStore("sync_history");
  for (let n = 0; n < count; n += 1) {
    writes.push(
      store.add({
        idempotencyKey: `${outcome}-${n}`,
        outcome,
        finalisedAt: new Date(BASE_MS + n * 60_000).toISOString(),
        method: "POST",
        url: `${ORIGIN}/api/item-receipt/${n}`,
        discardReasonCode: outcome === "discarded" ? "OPERATOR_OBSOLETED" : null,
        discardReasonText: outcome === "discarded" ? "no longer needed" : null,
      }),
    );
  }
  await Promise.all(writes);
  await tx.done;
}

async function seedPending(key: string): Promise<void> {
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url: `${ORIGIN}/api/item-receipt`,
    headers: {},
    body: JSON.stringify({ pallet: key }),
    queuedAt: "2026-08-19T11:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
  });
}

function replayDeps(overrides: Partial<Parameters<typeof runReplay>[0]> = {}) {
  return {
    db,
    readToken: async () => stationSession(),
    fetch: okFetch() as unknown as typeof fetch,
    now: () => NOW,
    swOrigin: ORIGIN,
    ...overrides,
  };
}

describe("CR-DC-070 — the prune runs on the real replay trigger", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("leaves an over-bound history store at the bound after one replay pass", async () => {
    await seedHistory(640);
    await seedPending("key-1");

    await runReplay(replayDeps());

    const remaining = await db.getAll("sync_history");
    // 641 rows existed at the end of the pass (640 seeded + the one the replayed write finalised);
    // the store is left holding exactly the newest 200 of them.
    expect(remaining.length).toBe(SYNCED_HISTORY_RETENTION);
    // And the replayed write's own row — the newest of all — is one of them. A prune that kept the
    // OLDEST 200 would also leave 200 rows behind, so the count alone proves nothing.
    expect(remaining.some((r) => r.idempotencyKey === "key-1")).toBe(true);
  });

  it("runs even when the pass had nothing to send — housekeeping is not conditional on work", async () => {
    await seedHistory(300);
    const outcomes = await runReplay(replayDeps());
    expect(outcomes).toEqual([]);
    expect((await db.getAll("sync_history")).length).toBe(SYNCED_HISTORY_RETENTION);
  });

  it("still refuses to delete discarded rows when it runs from the replay loop (D-1)", async () => {
    await seedHistory(5, "discarded");
    await seedHistory(300, "synced");

    await runReplay(replayDeps());

    const remaining = await db.getAll("sync_history");
    expect(remaining.filter((r) => r.outcome === "discarded").length).toBe(5);
  });

  it("never touches pending writes on the way through", async () => {
    await seedHistory(640);
    await seedPending("stays-queued");
    // No session → the row is skipped, not sent, so it is still pending after the pass. That makes
    // it the right probe: the prune runs on a pass that changed nothing.
    const before = JSON.stringify(await getPendingWrites(db));

    await runReplay(replayDeps({ readToken: async () => null }));

    expect(JSON.stringify(await getPendingWrites(db))).toBe(before);
    expect((await db.getAll("sync_history")).length).toBe(SYNCED_HISTORY_RETENTION);
  });
});

describe("CR-DC-070 — a prune that fails cannot change a replay outcome", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  /**
   * A DB that refuses EXACTLY the transaction `pruneSyncHistory` opens — `("sync_history",
   * "readwrite")` with a string store name. Every other transaction, including
   * `dequeueWriteOnSuccess`'s `(["pending_writes", "sync_history"], "readwrite")` array form, passes
   * straight through, so the replay itself behaves completely normally.
   */
  function dbWhosePruneThrows(): OfflineQueueDB {
    return new Proxy(db as object, {
      get(target, prop) {
        if (prop === "transaction") {
          return (names: string | string[], mode?: string, ...rest: unknown[]) => {
            if (names === "sync_history" && mode === "readwrite") {
              throw new Error("simulated prune failure");
            }
            return (target as OfflineQueueDB).transaction(
              names as never,
              mode as never,
              ...(rest as []),
            );
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as OfflineQueueDB;
  }

  it("produces identical outcomes whether the prune succeeds or throws", async () => {
    await seedHistory(640);
    await seedPending("key-a");
    const healthy = await runReplay(replayDeps());

    // Same starting state again, but with a prune that cannot run.
    await db.clear("sync_history");
    await db.clear("pending_writes");
    await seedHistory(640);
    await seedPending("key-a");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = await runReplay(replayDeps({ db: dbWhosePruneThrows() }));

    expect(broken).toEqual(healthy);
    expect(broken).toEqual([{ idempotencyKey: "key-a", outcome: "synced" }]);
    // It failed loudly enough for a diagnostic, and quietly enough for the operator.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not reject the replay pass when the prune throws — the write still synced", async () => {
    await seedHistory(640);
    await seedPending("key-b");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runReplay(replayDeps({ db: dbWhosePruneThrows() }))).resolves.toEqual([
      { idempotencyKey: "key-b", outcome: "synced" },
    ]);

    // The write really did leave the queue — a swallowed housekeeping error must not have taken the
    // replay's own work with it.
    expect(await getPendingWrites(db)).toEqual([]);
    warn.mockRestore();
  });
});
