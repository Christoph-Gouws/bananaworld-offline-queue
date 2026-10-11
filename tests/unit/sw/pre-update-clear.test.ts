// Unit test — CR-DC-240: work saved by a pre-fix worker is cleared once, recorded, reported, never sent.
//
// Anchors: CR-DC-240 (owner ruling 2026-10-11), KI-227-01, KI-M007-001, PRD-NFR-005.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRE_UPDATE_CLEAR_ID,
  clearPreUpdateWrites,
  enqueueWrite,
  generateIdempotencyKey,
  getPendingWrites,
  markWriteFailed,
  openOfflineQueueDB,
  readPreUpdateClear,
  type OfflineQueueDB,
  type PendingWriteRecord,
} from "@/lib/offline-queue";
import { runReplay } from "@/sw/replay-loop";
import { buildSyncSnapshot } from "@/sw/message-handlers";
import {
  QUEUE_ACTION_PATH,
  REPORTS_PER_PASS,
  entityTypeOf,
  reportPreUpdateClears,
  runPreUpdateClear,
} from "@/sw/pre-update-clear";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;
const NOW = new Date("2026-10-12T07:14:00.000Z");
const URL_BASE = "https://app.bananaworld-dc.test";

/** A row exactly as a PRE-FIX worker wrote it: no `replayGeneration`, a body and a header worth hiding. */
async function seedOld(
  overrides: Partial<PendingWriteRecord> = {},
  key = generateIdempotencyKey(),
): Promise<string> {
  const row: PendingWriteRecord = {
    idempotencyKey: key,
    method: "POST",
    url: `${URL_BASE}/api/item-receipt/abc/pallet?secret=1`,
    headers: { "Content-Type": "application/json", "X-Secret-Header": "do-not-copy" },
    body: JSON.stringify({ pallet: "do-not-copy-this-body" }),
    queuedAt: "2026-06-03T07:12:00.000Z",
    lastAttemptAt: null,
    attemptCount: 0,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
    ...overrides,
  };
  await db.add("pending_writes", row);
  return key;
}

async function seedNew(): Promise<string> {
  const key = generateIdempotencyKey();
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url: `${URL_BASE}/api/item-receipt`,
    headers: {},
    body: "{}",
    queuedAt: "2026-10-12T07:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
  });
  return key;
}

describe("CR-DC-240 — the pre-update clear", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  describe("the sweep", () => {
    it("clears queued, syncing and failed pre-fix rows and keeps stamped ones", async () => {
      await seedOld();
      await seedOld({ status: "syncing" });
      await seedOld({ status: "failed" });
      const keep = await seedNew();

      const result = await clearPreUpdateWrites(db, NOW.toISOString());

      expect(result).toEqual({ ran: true, cleared: 3 });
      expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual([keep]);
    });

    it("records per row the method, path, time, status — and NO body, headers or query", async () => {
      const key = await seedOld({ status: "failed" });
      await clearPreUpdateWrites(db, NOW.toISOString());

      const record = await readPreUpdateClear(db);
      expect(record?.id).toBe(PRE_UPDATE_CLEAR_ID);
      expect(record?.clearedAt).toBe(NOW.toISOString());
      expect(record?.rows).toEqual([
        {
          idempotencyKey: key,
          method: "POST",
          path: "/api/item-receipt/abc/pallet",
          queuedAt: "2026-06-03T07:12:00.000Z",
          status: "failed",
          operatorId: TEST_SESSION_OPERATOR,
          stationId: TEST_SESSION_STATION,
          report: { state: "pending", at: null },
        },
      ]);
      // The KEY SET is the guard: a later field copied over from the row fails here.
      expect(Object.keys(record?.rows[0] ?? {}).sort()).toEqual([
        "idempotencyKey",
        "method",
        "operatorId",
        "path",
        "queuedAt",
        "report",
        "stationId",
        "status",
      ]);
      expect(JSON.stringify(record)).not.toContain("do-not-copy");
      expect(JSON.stringify(record)).not.toContain("secret=1");
    });

    it("runs once: the second call is a no-op and later pre-fix rows survive it", async () => {
      await seedOld();
      await clearPreUpdateWrites(db, NOW.toISOString());
      const late = await seedOld({}, generateIdempotencyKey());

      expect(await clearPreUpdateWrites(db, NOW.toISOString())).toEqual({
        ran: false,
        cleared: 0,
      });
      expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual([late]);
    });

    it("writes the marker on a clean tablet too (rows: [])", async () => {
      expect(await clearPreUpdateWrites(db, NOW.toISOString())).toEqual({ ran: true, cleared: 0 });
      expect((await readPreUpdateClear(db))?.rows).toEqual([]);
    });

    it("never clears a row the fixed worker saved, even if the sweep re-runs late", async () => {
      const fresh = await seedNew();
      await db.delete("queue_maintenance", PRE_UPDATE_CLEAR_ID); // simulate "the sweep never committed"
      const result = await clearPreUpdateWrites(db, NOW.toISOString());
      expect(result.cleared).toBe(0);
      expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual([fresh]);
    });

    it("two concurrent callers produce exactly one sweep", async () => {
      await seedOld();
      await seedOld();
      const [a, b] = await Promise.all([
        clearPreUpdateWrites(db, NOW.toISOString()),
        clearPreUpdateWrites(db, NOW.toISOString()),
      ]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect((await readPreUpdateClear(db))?.rows).toHaveLength(2);
    });

    it("runPreUpdateClear never throws, even when the database refuses", async () => {
      const broken = {
        transaction: () => {
          throw new Error("idb is down");
        },
      } as unknown as OfflineQueueDB;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await expect(runPreUpdateClear(broken)).resolves.toBeUndefined();
      warn.mockRestore();
    });
  });

  describe("the replay loop", () => {
    it("refuses a pre-fix row: no fetch, attempt count untouched; sends a stamped one", async () => {
      const old = await seedOld();
      const fresh = await seedNew();
      const sent: string[] = [];
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        sent.push(String(input));
        return new Response("{}", { status: 200 });
      });

      const outcomes = await runReplay({
        db,
        readToken: async () => stationSession(),
        fetch: fetchSpy as unknown as typeof fetch,
        now: () => NOW,
      });

      expect(sent).toEqual([`${URL_BASE}/api/item-receipt`]);
      expect(outcomes).toEqual([{ idempotencyKey: fresh, outcome: "synced" }]);
      const rows = await getPendingWrites(db);
      expect(rows.map((r) => r.idempotencyKey)).toEqual([old]);
      expect(rows[0]?.attemptCount).toBe(0);
      expect(rows[0]?.status).toBe("queued");
    });
  });

  describe("the report to the office", () => {
    async function cleared(n: number): Promise<string[]> {
      const keys: string[] = [];
      for (let i = 0; i < n; i += 1) keys.push(await seedOld());
      await clearPreUpdateWrites(db, NOW.toISOString());
      return keys;
    }
    const ok = () => Promise.resolve(new Response("{}", { status: 200 }));
    const states = async () => (await readPreUpdateClear(db))?.rows.map((r) => r.report.state);

    it("sends nothing without a usable session (none / expired / idle)", async () => {
      await cleared(1);
      const spy = vi.fn(ok);
      for (const session of [
        null,
        stationSession({ expiresAt: "2026-10-12T07:00:00.000Z" }),
        stationSession({
          lastActivityAt: "2026-10-12T05:00:00.000Z",
          autoLogoffMinutes: 15,
        }),
      ]) {
        await reportPreUpdateClears({
          db,
          readToken: async () => session,
          fetch: spy as unknown as typeof fetch,
          now: () => NOW,
        });
      }
      expect(spy).not.toHaveBeenCalled();
      expect(await states()).toEqual(["pending"]);
    });

    it("posts one discard audit request per row with the exact body, then marks it sent", async () => {
      const [key] = await cleared(1);
      const spy = vi.fn(ok);
      await reportPreUpdateClears({
        db,
        readToken: async () => stationSession({ token: "tok-1" }),
        fetch: spy as unknown as typeof fetch,
        now: () => NOW,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(QUEUE_ACTION_PATH);
      // The path is the SETTING, not a package literal: the neutral one is not the DC's.
      expect(url).toBe("/api/identity/queue-audit");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
      // Written out in full, never computed by the module under test.
      expect(JSON.parse(init.body as string)).toEqual({
        queue_action: "discard",
        client_mutation_id: key,
        entity_type: "item-receipt",
        reason_code: "PRE_UPDATE_CLEARED",
        reason_text:
          "Cleared automatically by the tablet update (CR-DC-240): never reached the office. " +
          "POST /api/item-receipt/abc/pallet, saved 2026-06-03T07:12:00.000Z, was queued, " +
          "captured by operator operator-a at station station-a.",
      });
      expect(init.body as string).not.toContain("do-not-copy");
      expect(await states()).toEqual(["sent"]);
    });

    it("200 → sent, 400 → refused (never retried), 503 and a thrown error → stay pending", async () => {
      await cleared(4);
      const statuses = [200, 400, 503];
      const spy = vi.fn(async () => {
        const status = statuses.shift();
        if (status === undefined) throw new TypeError("offline");
        return new Response("{}", { status });
      });
      const deps = {
        db,
        readToken: async () => stationSession(),
        fetch: spy as unknown as typeof fetch,
        now: () => NOW,
      };
      await reportPreUpdateClears(deps);
      expect(await states()).toEqual(["sent", "refused", "pending", "pending"]);

      // The next pass only retries what is still pending; the refused row is not re-sent.
      spy.mockClear();
      const okAll = vi.fn(ok);
      await reportPreUpdateClears({ ...deps, fetch: okAll as unknown as typeof fetch });
      expect(okAll).toHaveBeenCalledTimes(2);
      expect(await states()).toEqual(["sent", "refused", "sent", "sent"]);
    });

    it(`reports at most ${REPORTS_PER_PASS} rows per pass`, async () => {
      await cleared(REPORTS_PER_PASS + 3);
      const spy = vi.fn(ok);
      await reportPreUpdateClears({
        db,
        readToken: async () => stationSession(),
        fetch: spy as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(spy).toHaveBeenCalledTimes(REPORTS_PER_PASS);
    });

    it("derives the entity type from the first path segment after /api/", () => {
      expect(entityTypeOf("/api/item-receipt/x/pallet")).toBe("item-receipt");
      expect(entityTypeOf("/not-api/x")).toBe("unknown");
    });
  });

  describe("the sync snapshot", () => {
    it("carries no preUpdateCleared before the sweep or when it cleared nothing", async () => {
      const deps = { db, isOnline: () => true, now: () => NOW };
      expect((await buildSyncSnapshot(deps)).preUpdateCleared).toBeUndefined();
      await clearPreUpdateWrites(db, NOW.toISOString());
      expect((await buildSyncSnapshot(deps)).preUpdateCleared).toBeUndefined();
    });

    it("carries the count and the time once rows were cleared — and no rows", async () => {
      await seedOld();
      await seedOld({ status: "failed" });
      await clearPreUpdateWrites(db, NOW.toISOString());
      const snapshot = await buildSyncSnapshot({ db, isOnline: () => true, now: () => NOW });
      expect(snapshot.preUpdateCleared).toEqual({ count: 2, clearedAt: NOW.toISOString() });
      expect(snapshot.pendingWrites).toEqual([]);
    });
  });

  // A write that failed under the pre-fix worker is just another old row: cleared, not retried.
  it("a pre-fix FAILED row is cleared and is not offered for retry", async () => {
    const key = await seedOld();
    await markWriteFailed(db, key, "UNKNOWN", "Exceeded 100 retry attempts", NOW.toISOString());
    await clearPreUpdateWrites(db, NOW.toISOString());
    expect(await getPendingWrites(db)).toEqual([]);
  });
});
