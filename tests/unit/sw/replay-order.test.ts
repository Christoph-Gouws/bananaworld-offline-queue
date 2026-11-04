// Unit test — CR-DC-267: a tablet sends its queue in the order it was saved.
//
// THE DEFECT (bananaworld-ph PR #55, pallet-close.spec.ts:320): the loop stepped over a row still inside
// its own backoff window and sent the next one, so a later save overtook an earlier one and the two
// pallets got each other's numbers. W1 has more failed attempts than W2, so its window is longer.
//
// RULE UNDER TEST: a row is never sent while an earlier row OF THE SAME PERSON (operator + station +
// depot; v0.5.0) is still waiting — held, backed off, or mid-send. A REFUSED (`failed`) row, a pre-update row and a cross-origin row never
// hold anything back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWrite,
  getPendingWrites,
  markWriteAttempt,
  openOfflineQueueDB,
  type OfflineQueueDB,
  type PendingWriteRecord,
} from "@/lib/offline-queue";
import { REPLAY_FETCH_TIMEOUT_MS, runReplay } from "@/sw/replay-loop";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

const T0 = "2026-10-27T08:00:00.000Z";
const at = (seconds: number) => new Date(new Date(T0).getTime() + seconds * 1000);

let db: OfflineQueueDB;

/** A row saved at `savedAt` that has already failed `attempts` times, the last at T0. */
async function seed(
  name: string,
  savedAt: string,
  attempts = 0,
  overrides: Partial<PendingWriteRecord> = {},
): Promise<string> {
  await enqueueWrite(db, {
    idempotencyKey: name,
    method: "POST",
    url: `/api/${name}`,
    headers: {},
    body: JSON.stringify({ name }),
    queuedAt: savedAt,
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
  });
  for (let i = 0; i < attempts; i++) await markWriteAttempt(db, name, "syncing", T0);
  if (attempts > 0) await markWriteAttempt(db, name, "queued", T0);
  if (Object.keys(overrides).length > 0) {
    const row = (await getPendingWrites(db)).find((r) => r.idempotencyKey === name);
    if (!row) throw new Error("seeded row missing");
    await db.put("pending_writes", { ...row, ...overrides });
  }
  return name;
}

const ok = () => new Response(null, { status: 200 });
const sentNames = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => String(c[0]).replace("/api/", ""));

describe("CR-DC-267 — queue order survives backoff, failure, a hung send and a stale syncing row", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  async function replay(fetchImpl: typeof fetch, now: Date, extra = {}) {
    return runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: fetchImpl,
      now: () => now,
      ...extra,
    });
  }

  it("(i) two rows with different backoff: the later row is NOT sent while the earlier is backed off", async () => {
    // W1: 3 attempts → 4s window. W2: 1 attempt → 1s window. At T0+2s only W2's window has ended.
    await seed("w1", "2026-10-27T07:00:00.000Z", 3);
    await seed("w2", "2026-10-27T07:00:01.000Z", 1);
    const fetchMock = vi.fn().mockImplementation(async () => ok());

    const first = await replay(fetchMock as unknown as typeof fetch, at(2));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(first.map((o) => [o.idempotencyKey, o.outcome])).toEqual([
      ["w1", "skipped"],
      ["w2", "skipped"],
    ]);

    // When W1's window ends, both go, W1 first.
    await replay(fetchMock as unknown as typeof fetch, at(5));
    expect(sentNames(fetchMock)).toEqual(["w1", "w2"]);
  });

  it("(ii) an aborted send of W1: W2 is not sent in that pass; the next pass sends W1 then W2", async () => {
    await seed("w1", "2026-10-27T07:00:00.000Z");
    await seed("w2", "2026-10-27T07:00:01.000Z");
    const down = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const first = await replay(down as unknown as typeof fetch, at(0));
    expect(down).toHaveBeenCalledTimes(1);
    expect(first.find((o) => o.idempotencyKey === "w2")?.outcome).toBe("skipped");

    const up = vi.fn().mockImplementation(async () => ok());
    await replay(up as unknown as typeof fetch, at(60));
    expect(sentNames(up)).toEqual(["w1", "w2"]);
  });

  it("(iii) a hung fetch: the pass ends at the timeout, W2 is not sent, the next pass is in order", async () => {
    await seed("w1", "2026-10-27T07:00:00.000Z");
    await seed("w2", "2026-10-27T07:00:01.000Z");
    const hung = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const first = await replay(hung as unknown as typeof fetch, at(0), { fetchTimeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(first.find((o) => o.idempotencyKey === "w1")?.outcome).toBe("retry-later");
    expect(first.find((o) => o.idempotencyKey === "w2")?.outcome).toBe("skipped");

    const up = vi.fn().mockImplementation(async () => ok());
    await replay(up as unknown as typeof fetch, at(60));
    expect(sentNames(up)).toEqual(["w1", "w2"]);
  });

  it("the send timeout is a bounded, exported mechanism value", () => {
    expect(REPLAY_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("the send carries an abort signal and no header changes", async () => {
    await seed("w1", "2026-10-27T07:00:00.000Z");
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await replay(fetchMock as unknown as typeof fetch, at(0));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      "Authorization",
      "Idempotency-Key",
    ]);
  });

  it("a stale `syncing` W1 (killed worker) is retried BEFORE a later `queued` W2", async () => {
    await seed("w1", "2026-10-27T07:00:00.000Z", 1, { status: "syncing" });
    await seed("w2", "2026-10-27T07:00:01.000Z");
    expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual(["w1", "w2"]);
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    await replay(fetchMock as unknown as typeof fetch, at(10));
    expect(sentNames(fetchMock)).toEqual(["w1", "w2"]);
  });

  it("same-millisecond saves keep their insertion order", async () => {
    await seed("w1", "2026-10-27T07:00:00.000Z");
    await seed("w2", "2026-10-27T07:00:00.000Z");
    await seed("w3", "2026-10-27T07:00:00.000Z");
    expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual(["w1", "w2", "w3"]);
  });

  describe("over-block guards — what must NOT hold a row back", () => {
    it("a REFUSED earlier row (failed) does not hold W2 back", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z", 0, {
        status: "failed",
        failureReason: "UNKNOWN",
      });
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["w2"]);
    });

    it("a 4xx refusal of W1 during the pass does not hold W2 back", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z");
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 409 }))
        .mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["w1", "w2"]);
    });

    it("a PRE-UPDATE earlier row does not hold W2 back", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z");
      const row = (await getPendingWrites(db))[0]!;
      const { replayGeneration: _drop, ...old } = row;
      void _drop;
      await db.put("pending_writes", old as PendingWriteRecord);
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["w2"]);
    });

    it("a cross-origin earlier row is discarded and does not hold W2 back", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z", 0, { url: "https://elsewhere.test/api/w1" });
      await seed("w2", "2026-10-27T07:00:01.000Z", 0, { url: "https://app.test/api/w2" });
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0), { swOrigin: "https://app.test" });
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://app.test/api/w2"]);
    });
  });

  // 🔴 v0.5.0 — owner ruling 2026-11-02: the order is kept PER PERSON (operator + station + depot).
  //    Truck station HRZ 710 MP, 2026-11-02: four walk-around rows held for a driver who had signed out
  //    stopped ten later rows by the next driver. Under v0.4.0 the first test below sent nothing.
  describe("v0.5.0 — someone else's waiting work never holds a row back", () => {
    it("rows HELD for another operator do not hold back the signed-in operator's rows", async () => {
      for (const n of [1, 2, 3, 4]) {
        await seed(`a${n}`, `2026-10-27T06:0${n}:00.000Z`, 0, {
          operatorId: "driver-who-signed-out",
        });
      }
      await seed("b1", "2026-10-27T07:00:00.000Z");
      await seed("b2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      const outcomes = await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["b1", "b2"]);
      expect(outcomes.map((o) => (o.outcome === "skipped" ? o.reason : o.outcome))).toEqual([
        // Each held row keeps its OWN reason (the session check runs first, AC-10).
        "held-for-operator",
        "held-for-operator",
        "held-for-operator",
        "held-for-operator",
        "synced",
        "synced",
      ]);
      // The held rows are untouched — still queued, no attempt counted — so they still send the moment
      // their own person signs back in.
      const left = await getPendingWrites(db);
      expect(left.map((r) => [r.idempotencyKey, r.status, r.attemptCount])).toEqual([
        ["a1", "queued", 0],
        ["a2", "queued", 0],
        ["a3", "queued", 0],
        ["a4", "queued", 0],
      ]);
    });

    it("when the held rows' own person signs back in, they send in their saved order", async () => {
      for (const n of [1, 2]) {
        await seed(`a${n}`, `2026-10-27T06:0${n}:00.000Z`, 0, { operatorId: "driver-a" });
      }
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await runReplay({
        db,
        readToken: async () => stationSession({ operatorId: "driver-a" }),
        fetch: fetchMock as unknown as typeof fetch,
        now: () => at(0),
      });
      expect(sentNames(fetchMock)).toEqual(["a1", "a2"]);
    });

    it("a row held under ANOTHER STATION does not hold back this station's row", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z", 0, { stationId: "another-station" });
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["w2"]);
    });

    it("mixed: the signed-in person's own backed-off row still holds THEIR later row; others' rows don't", async () => {
      await seed("held", "2026-10-27T06:00:00.000Z", 0, { operatorId: "driver-who-signed-out" });
      await seed("mine1", "2026-10-27T07:00:00.000Z", 3); // inside its backoff window at T0+1s
      await seed("mine2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      const outcomes = await replay(fetchMock as unknown as typeof fetch, at(1));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcomes.map((o) => (o.outcome === "skipped" ? o.reason : o.outcome))).toEqual([
        "held-for-operator",
        "backoff",
        "behind-earlier",
      ]);
    });
  });

  describe("what MUST hold a row back", () => {
    it("an earlier row of the SAME person, backed off, still holds their later row back", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z", 3);
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      const outcomes = await replay(fetchMock as unknown as typeof fetch, at(1));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcomes.map((o) => (o.outcome === "skipped" ? o.reason : o.outcome))).toEqual([
        "backoff",
        "behind-earlier",
      ]);
    });

    it("no session: every row reports `unauthenticated`, nothing is sent", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z");
      await seed("w2", "2026-10-27T07:00:01.000Z");
      const fetchMock = vi.fn();
      const outcomes = await runReplay({
        db,
        readToken: async () => null,
        fetch: fetchMock as unknown as typeof fetch,
        now: () => at(0),
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(outcomes.map((o) => (o.outcome === "skipped" ? o.reason : o.outcome))).toEqual([
        "unauthenticated",
        "unauthenticated",
      ]);
    });

    it("a behind-earlier row is untouched: no attempt counted, still queued", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z", 3);
      await seed("w2", "2026-10-27T07:00:01.000Z");
      await replay(vi.fn() as unknown as typeof fetch, at(1));
      const w2 = (await getPendingWrites(db)).find((r) => r.idempotencyKey === "w2")!;
      expect([w2.status, w2.attemptCount, w2.lastAttemptAt]).toEqual(["queued", 0, null]);
    });

    it("once W1 syncs, W2 goes in the SAME pass", async () => {
      await seed("w1", "2026-10-27T07:00:00.000Z");
      await seed("w2", "2026-10-27T07:00:01.000Z");
      await seed("w3", "2026-10-27T07:00:02.000Z");
      const fetchMock = vi.fn().mockImplementation(async () => ok());
      await replay(fetchMock as unknown as typeof fetch, at(0));
      expect(sentNames(fetchMock)).toEqual(["w1", "w2", "w3"]);
    });
  });
});
