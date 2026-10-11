// Unit test — page-side queue API (EPIC-001-M007-SCOPE-002).
//
// Anchors: PRD-FUNC-127..130, TECH-COMP-006, API-PRINCIPLE-008.
// Exercises: enqueueWrite, dequeueWriteOnSuccess, markWriteFailed,
//            markWriteAttempt, retryFailedWrite, discardFailedWrite,
//            getPendingWrites, getFailedWrites, getRecentHistory,
//            countPendingWrites.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countPendingWrites,
  dequeueWriteOnSuccess,
  discardFailedWrite,
  enqueueWrite,
  generateIdempotencyKey,
  getFailedWrites,
  getPendingWrites,
  getRecentHistory,
  markWriteAttempt,
  markWriteFailed,
  openOfflineQueueDB,
  retryFailedWrite,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

describe("offline-queue.queue (enqueue / dequeue / read APIs)", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });

  afterEach(() => {
    db.close();
  });

  describe("enqueueWrite", () => {
    it("persists a new pending write with status 'queued' and attemptCount 0", async () => {
      const key = generateIdempotencyKey();
      const record = await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palletCount: 12 }),
        warehouseId: "wh-a",
      });
      expect(record.status).toBe("queued");
      expect(record.attemptCount).toBe(0);
      expect(record.id).toBeDefined();
      const pending = await getPendingWrites(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.idempotencyKey).toBe(key);
    });

    it("preserves warehouseId on the queued row (M002 multi-DC isolation carry-forward)", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-b",
      });
      const pending = await getPendingWrites(db);
      expect(pending[0]?.warehouseId).toBe("wh-b");
    });
  });

  describe("dequeueWriteOnSuccess", () => {
    it("removes the pending row + adds a sync_history row with outcome=synced", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await dequeueWriteOnSuccess(db, key, "2026-05-28T12:00:00.000Z");
      const pending = await getPendingWrites(db);
      const history = await getRecentHistory(db);
      expect(pending).toHaveLength(0);
      expect(history).toHaveLength(1);
      expect(history[0]?.outcome).toBe("synced");
      expect(history[0]?.finalisedAt).toBe("2026-05-28T12:00:00.000Z");
    });

    it("is idempotent — calling twice with the same key does not duplicate history", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await dequeueWriteOnSuccess(db, key);
      await dequeueWriteOnSuccess(db, key); // no-op
      const history = await getRecentHistory(db);
      expect(history).toHaveLength(1);
    });
  });

  describe("markWriteFailed", () => {
    it("transitions a queued write to failed with the server-supplied reason", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteFailed(db, key, "SERVER_MASTER_WINS", "A manager updated the master record.");
      const failed = await getFailedWrites(db);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("failed");
      expect(failed[0]?.failureReason).toBe("SERVER_MASTER_WINS");
      expect(failed[0]?.failureMessage).toContain("master");
      expect(failed[0]?.attemptCount).toBe(1);
    });
  });

  describe("retryFailedWrite", () => {
    it("re-queues a failed write and clears the failure metadata", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteFailed(db, key, "EARLIER_TIMESTAMP_LOSES", "Later wrote won.");
      const ok = await retryFailedWrite(db, key);
      expect(ok).toBe(true);
      const pending = await getPendingWrites(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe("queued");
      expect(pending[0]?.failureReason).toBeNull();
      expect(pending[0]?.failureMessage).toBeNull();
      const failed = await getFailedWrites(db);
      expect(failed).toHaveLength(0);
    });

    it("returns false when no failed write with the key exists (concurrent safety)", async () => {
      const ok = await retryFailedWrite(db, "no-such-key");
      expect(ok).toBe(false);
    });

    // CR-DC-069 — 🔴 THE DATA-LOSS FIX, at queue level. Before this, a retry reset the status and
    // the two failure fields but NOT `attemptCount`, so a row that had reached the ceiling came
    // straight back as `failed` on the next pass with zero server calls and Discard — permanent
    // deletion of work the tablet had already told the operator was saved — was the only exit.
    it("resets the attempt budget so an exhausted write is genuinely replayable again", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        queuedAt: "2026-08-19T11:00:00.000Z",
        warehouseId: "wh-a",
      });
      const seeded = (await getPendingWrites(db))[0];
      if (seeded === undefined) throw new Error("seed row missing");
      await db.put("pending_writes", {
        ...seeded,
        status: "failed",
        attemptCount: 100,
        lastAttemptAt: "2026-08-19T11:59:00.000Z",
        failureReason: "UNKNOWN",
        failureMessage: "Exceeded 100 retry attempts — server unreachable.",
      });

      expect(await retryFailedWrite(db, key)).toBe(true);

      const row = (await getPendingWrites(db))[0];
      expect(row?.status).toBe("queued");
      expect(row?.attemptCount).toBe(0); // numeric, not merely falsy — the budget is real
      expect(row?.lastAttemptAt).toBeNull();
      // 🔴 The write's IDENTITY is untouched: the same key and the same queuedAt, so the server's
      // idempotency guard still recognises a retry as the SAME write and PRD-FUNC-130's
      // later-timestamp rule still reads the moment the operator tapped Save.
      expect(row?.idempotencyKey).toBe(key);
      expect(row?.queuedAt).toBe("2026-08-19T11:00:00.000Z");
    });

    it("still refuses a row that is not `failed` — a retry is an action on a failed row only", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteAttempt(db, key, "syncing");
      const before = (await getPendingWrites(db))[0];

      expect(await retryFailedWrite(db, key)).toBe(false);
      // …and it did not quietly reset the in-flight row's budget on the way past.
      expect((await getPendingWrites(db))[0]).toEqual(before);
    });
  });

  describe("discardFailedWrite", () => {
    it("removes the failed row + writes a discarded entry to sync_history with reason", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteFailed(db, key, "STATE_DOES_NOT_ALLOW", "Record was Posted.");
      const ok = await discardFailedWrite(
        db,
        key,
        "OPERATOR_OBSOLETED",
        null,
        "2026-05-28T12:00:00.000Z",
      );
      expect(ok).toBe(true);
      const pending = await getPendingWrites(db);
      const history = await getRecentHistory(db);
      expect(pending).toHaveLength(0);
      expect(history).toHaveLength(1);
      expect(history[0]?.outcome).toBe("discarded");
      expect(history[0]?.discardReasonCode).toBe("OPERATOR_OBSOLETED");
    });

    it("stores discardReasonText when reason code is OTHER", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteFailed(db, key, "UNKNOWN", "Unrecognised rejection.");
      await discardFailedWrite(db, key, "OTHER", "Test operator note for audit.");
      const history = await getRecentHistory(db);
      expect(history[0]?.discardReasonCode).toBe("OTHER");
      expect(history[0]?.discardReasonText).toBe("Test operator note for audit.");
    });
  });

  describe("getPendingWrites ordering", () => {
    it("sorts by status precedence then by queuedAt within each status group", async () => {
      const kA = generateIdempotencyKey();
      const kB = generateIdempotencyKey();
      const kC = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: kA,
        method: "POST",
        url: "/api/a",
        headers: {},
        body: null,
        queuedAt: "2026-05-28T10:00:00.000Z",
        warehouseId: "wh-a",
      });
      await enqueueWrite(db, {
        idempotencyKey: kB,
        method: "POST",
        url: "/api/b",
        headers: {},
        body: null,
        queuedAt: "2026-05-28T11:00:00.000Z",
        warehouseId: "wh-a",
      });
      await enqueueWrite(db, {
        idempotencyKey: kC,
        method: "POST",
        url: "/api/c",
        headers: {},
        body: null,
        queuedAt: "2026-05-28T12:00:00.000Z",
        warehouseId: "wh-a",
      });
      // B fails; A + C stay queued. Expect order: A, C, B (queued before failed).
      await markWriteFailed(db, kB, "SERVER_MASTER_WINS", "x");
      const pending = await getPendingWrites(db);
      expect(pending.map((p) => p.idempotencyKey)).toEqual([kA, kC, kB]);
    });
  });

  describe("countPendingWrites", () => {
    it("counts all rows regardless of status (queued + syncing + failed)", async () => {
      await enqueueWrite(db, {
        idempotencyKey: generateIdempotencyKey(),
        method: "POST",
        url: "/api/a",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await enqueueWrite(db, {
        idempotencyKey: generateIdempotencyKey(),
        method: "POST",
        url: "/api/b",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      expect(await countPendingWrites(db)).toBe(2);
    });
  });

  describe("markWriteAttempt", () => {
    it("flips a queued write to syncing + bumps attemptCount", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteAttempt(db, key, "syncing");
      const pending = await getPendingWrites(db);
      expect(pending[0]?.status).toBe("syncing");
      expect(pending[0]?.attemptCount).toBe(1);
    });

    it("does NOT bump attemptCount when flipping back to queued (only on syncing transition)", async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "/api/receipt",
        headers: {},
        body: null,
        warehouseId: "wh-a",
      });
      await markWriteAttempt(db, key, "syncing");
      await markWriteAttempt(db, key, "queued");
      const pending = await getPendingWrites(db);
      expect(pending[0]?.attemptCount).toBe(1);
    });
  });
});
