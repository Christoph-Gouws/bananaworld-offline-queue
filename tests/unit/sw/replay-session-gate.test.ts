// Unit test — CR-DC-068: a queued write is never replayed without a session of its own.
//
// Anchors: CR-DC-068, PRD-NFR-005 (zero data loss), SEC-AUTH-004 (auto-logoff), SEC-AUTH-013
//          (the token stays SW-internal), D-038 (HACCP / GlobalGAP attribution, retention >= 5y),
//          CLAUDE.md data discipline ("attributable to user + station + timestamp + warehouse_id").
//
// THIS SUITE IS THE PROBE FROM THE CHANGE REQUEST, INVERTED. On `main` the probe proved that an
// operator who taps in, captures three pallets offline and is then auto-logged-off loses all three:
// Authorization headers actually sent were [none, none, none] and all three rows dead-lettered as
// `failed` with reason UNKNOWN. Every assertion below is that same scenario asserting the opposite.
//
// 🔴 The two properties that matter most and are easiest to get subtly wrong:
//   · a skipped write must NOT burn an attempt (the gate runs before markWriteAttempt), and
//   · a held write must not merely be "not synced" — NO FETCH may be issued for it at all. Asserting
//     the outcome alone would pass for a loop that sends nothing ever, which is why AC-6 exists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWrite,
  generateIdempotencyKey,
  getPendingWrites,
  markWriteFailed,
  openOfflineQueueDB,
  type OfflineQueueDB,
  type PendingWriteRecord,
} from "@/lib/offline-queue";
import { runReplay } from "@/sw/replay-loop";
import { handleMessage } from "@/sw/message-handlers";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const OPERATOR_B = "operator-b";
const NOW = new Date("2026-08-19T12:00:00.000Z");

async function seed(
  identity: Partial<Pick<PendingWriteRecord, "operatorId" | "stationId" | "warehouseId">> = {},
): Promise<string> {
  const key = generateIdempotencyKey();
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url: "https://app.bananaworld-dc.test/api/item-receipt",
    headers: {},
    body: JSON.stringify({ pallet: key }),
    queuedAt: "2026-08-19T11:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
    ...identity,
  });
  return key;
}

async function rowFor(key: string): Promise<PendingWriteRecord> {
  const row = (await getPendingWrites(db)).find((w) => w.idempotencyKey === key);
  if (row === undefined) throw new Error(`row ${key} is gone from the queue — it must not be`);
  return row;
}

describe("CR-DC-068 — a replay requires a usable session of its own", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // AC-1 — THE PROBE, INVERTED. On `main` this is three `failed`.
  it("AC-1: token cleared → three writes stay queued, replayable, and no attempt is burned", async () => {
    const keys = [await seed(), await seed(), await seed()];
    const fetchSpy = vi.fn();

    const outcomes = await runReplay({
      db,
      // The auto-logoff has cleared the SW token. This is the state performLogoff leaves behind.
      readToken: async () => null,
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    // Nothing was sent AT ALL — not sent-and-rejected, not sent unauthenticated. Not sent.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe("skipped");
      if (outcome.outcome === "skipped") expect(outcome.reason).toBe("unauthenticated");
    }
    // Every row survives, still queued, still replayable, with its retry budget intact.
    for (const key of keys) {
      const row = await rowFor(key);
      expect(row.status).toBe("queued");
      expect(row.attemptCount).toBe(0); // numeric, not "falsy" — the budget was not spent
      expect(row.lastAttemptAt).toBeNull();
      expect(row.failureReason).toBeNull();
    }
  });

  // AC-2 — the wider hole. A station token's life is `login + auto_logoff_minutes`; the floor default
  // is FIVE MINUTES, so a stored, uncleared token is very often ALREADY EXPIRED at replay time — on a
  // tablet where nobody ever tapped Sign out. A presence-only check would leave this open.
  it("AC-2: a stored token that is PAST expiresAt is treated exactly like no token", async () => {
    const key = await seed();
    const fetchSpy = vi.fn();

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ expiresAt: "2026-08-19T11:59:59.000Z" }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes[0]?.outcome).toBe("skipped");
    if (outcomes[0]?.outcome === "skipped") expect(outcomes[0].reason).toBe("unauthenticated");
    const row = await rowFor(key);
    expect(row.status).toBe("queued");
    expect(row.attemptCount).toBe(0);
  });

  // AC-5 — the misattribution. Operator A captures offline; auto-logoff fires; operator B taps in.
  it("AC-5: operator A's write is NOT sent under operator B's session", async () => {
    const key = await seed({ operatorId: "operator-a" });
    const fetchSpy = vi.fn();

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: OPERATOR_B }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    // Assert the SPY, not just the outcome: the whole defect was a request leaving the device.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes[0]?.outcome).toBe("skipped");
    if (outcomes[0]?.outcome === "skipped") expect(outcomes[0].reason).toBe("held-for-operator");
    const row = await rowFor(key);
    expect(row.status).toBe("queued");
    expect(row.attemptCount).toBe(0);
    expect(row.operatorId).toBe("operator-a"); // never rewritten to the live session's operator
  });

  // AC-6 — THE OVER-BLOCK GUARD. Without this, AC-1 / AC-2 / AC-5 are all satisfied by a loop that
  // never sends anything at all, which would be a worse bug than the one being fixed.
  it("AC-6: same operator + station + warehouse → the write IS sent, WITH Authorization", async () => {
    await seed();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ token: "live-station-jwt" }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(outcomes[0]?.outcome).toBe("synced");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer live-station-jwt");
  });

  // AC-7 — the other two legs of the triple, including the re-pairing case (§6.5 of the plan).
  it("AC-7: a different STATION is held; a different WAREHOUSE is held and is never rewritten", async () => {
    const wrongStation = await seed({ stationId: "station-b" });
    const wrongWarehouse = await seed({ warehouseId: "wh-zulu" });
    const fetchSpy = vi.fn();

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe("skipped");
      if (outcome.outcome === "skipped") expect(outcome.reason).toBe("held-for-operator");
    }
    expect((await rowFor(wrongStation)).stationId).toBe("station-b");
    // 🔴 A tablet re-paired to another depot must NEVER have its warehouse claim rewritten to match
    // the live session — that would carry the write into the wrong depot's books.
    expect((await rowFor(wrongWarehouse)).warehouseId).toBe("wh-zulu");
  });

  // AC-9 — fail-closed on a legacy row, proven WITHOUT relying on the v2 backfill having run. The
  // identity fields are left `undefined` here, exactly as a version-1 row read back would be.
  it("AC-9: a row with NO identity is held, whether its fields are null or absent entirely", async () => {
    const nulled = await seed({ operatorId: null, stationId: null });
    const key = generateIdempotencyKey();
    // A version-1 row as it actually reads back: the two fields are not there at all.
    await db.add("pending_writes", {
      idempotencyKey: key,
      method: "POST",
      url: "https://app.bananaworld-dc.test/api/item-receipt",
      headers: {},
      body: null,
      queuedAt: "2026-08-19T09:11:00.000Z",
      lastAttemptAt: null,
      attemptCount: 0,
      status: "queued",
      failureReason: null,
      failureMessage: null,
      warehouseId: TEST_SESSION_WAREHOUSE,
    } as unknown as PendingWriteRecord);

    const fetchSpy = vi.fn();
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe("skipped");
      if (outcome.outcome === "skipped") expect(outcome.reason).toBe("held-for-operator");
    }
    expect((await rowFor(nulled)).status).toBe("queued");
    expect((await rowFor(key)).status).toBe("queued");
  });

  // A session with no operator (one stored by an older app build) must not be able to claim a
  // legacy row either. Two unknowns do NOT cancel out into a match.
  it("AC-9b: a session with NO operator cannot claim an identity-less row", async () => {
    const key = await seed({ operatorId: null, stationId: null });
    const fetchSpy = vi.fn();

    await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: null }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await rowFor(key)).status).toBe("queued");
  });

  // AC-10 — ordering. A row that cannot be sent at all must say so, not "waiting to retry":
  // otherwise the operator-facing state is wrong for the whole backoff window.
  it("AC-10: the session gate runs BEFORE the backoff skip", async () => {
    const key = generateIdempotencyKey();
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "https://app.bananaworld-dc.test/api/item-receipt",
      headers: {},
      body: null,
      queuedAt: "2026-08-19T11:00:00.000Z",
      warehouseId: TEST_SESSION_WAREHOUSE,
      operatorId: "operator-a",
      stationId: TEST_SESSION_STATION,
    });
    // Put the row deep inside a backoff window: one attempt, half a second ago.
    const tx = db.transaction("pending_writes", "readwrite");
    const store = tx.objectStore("pending_writes");
    const existing = await store.index("by_idempotency_key").get(key);
    if (existing?.id !== undefined) {
      await store.put({
        ...existing,
        attemptCount: 1,
        lastAttemptAt: "2026-08-19T11:59:59.500Z",
      });
    }
    await tx.done;

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: OPERATOR_B }),
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(outcomes[0]?.outcome).toBe("skipped");
    // Not "backoff" — the reason an operator is shown must be the real one.
    if (outcomes[0]?.outcome === "skipped") expect(outcomes[0].reason).toBe("held-for-operator");
  });

  // AC-11 — the gate runs before markWriteAttempt, proven on the OTHER field that call writes.
  it("AC-11: a skipped pass leaves lastAttemptAt untouched", async () => {
    const key = await seed({ operatorId: "operator-a" });
    const before = await rowFor(key);
    expect(before.lastAttemptAt).toBeNull();

    await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: OPERATOR_B }),
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    });

    const after = await rowFor(key);
    expect(after.lastAttemptAt).toBeNull();
    expect(after.attemptCount).toBe(0);
  });

  // AC-16 — universality. The gate is client-URL-based and screen-agnostic, so a write from any
  // tablet route is gated identically. ⚠ Asserted via the queued row's URL rather than by mounting
  // sixteen screens — a per-screen matrix would invite a per-screen implementation.
  it("AC-16: writes from non-receiving tablet routes are gated identically", async () => {
    const ripening = await seed({ operatorId: "operator-a" });
    const preTrip = await seed({ operatorId: "operator-a" });
    const tx = db.transaction("pending_writes", "readwrite");
    const store = tx.objectStore("pending_writes");
    for (const [key, url] of [
      [ripening, "https://app.bananaworld-dc.test/api/ripening/qc"],
      [preTrip, "https://app.bananaworld-dc.test/api/pre-trip"],
    ] as const) {
      const row = await store.index("by_idempotency_key").get(key);
      if (row?.id !== undefined) await store.put({ ...row, url });
    }
    await tx.done;

    const fetchSpy = vi.fn();
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: OPERATOR_B }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      if (outcome.outcome === "skipped") expect(outcome.reason).toBe("held-for-operator");
      else throw new Error(`expected a skip, got ${outcome.outcome}`);
    }
    // And the same two rows go through cleanly once their own operator is back — the gate is about
    // identity, never about which screen the work came from.
    const okFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const back = await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: "operator-a" }),
      fetch: okFetch as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(back.every((o) => o.outcome === "synced")).toBe(true);
    expect(okFetch).toHaveBeenCalledTimes(2);
  });

  // AC-18 — the Global Station. ⚠ Asserted on the session/row identity, NOT on the station kind:
  // the gate is kind-agnostic and a kind-aware test would invite a kind-aware implementation.
  it("AC-18: a global-station session is gated by the same triple, with no special case", async () => {
    // The global station is an ordinary station row: its own station_id, its own warehouse_id, the
    // 5-minute floor auto-logoff. Nothing about the gate is per-kind.
    const globalStation = "station-global-01";
    const key = await seed({ operatorId: "operator-a", stationId: globalStation });
    const fetchSpy = vi.fn();

    // Held for a different operator on the same go-anywhere tablet — the routine case there.
    await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: OPERATOR_B, stationId: globalStation }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await rowFor(key)).status).toBe("queued");

    // And unauthenticated when the tablet has signed itself out.
    await runReplay({
      db,
      readToken: async () => null,
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // AC-19 — 🔴 THE PICKED ROOM IS NOT IN THE IDENTITY MATCH. An implementation that folded the
  // Global Station's picked room into the triple would hold this row forever, on exactly the tablet
  // this change most needed to protect (the room is cleared at every logoff). This AC is the fence.
  it("AC-19: the same operator returning to a DIFFERENT room still sends, and the body keeps room R1", async () => {
    const key = generateIdempotencyKey();
    const globalStation = "station-global-01";
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "https://app.bananaworld-dc.test/api/quality-check",
      headers: {},
      // The room rides in the BODY, frozen at Save — a later room switch cannot retarget it.
      body: JSON.stringify({ room_id: "room-R1", colour_stage: 3 }),
      queuedAt: "2026-08-19T11:00:00.000Z",
      warehouseId: TEST_SESSION_WAREHOUSE,
      operatorId: "operator-a",
      stationId: globalStation,
    });

    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    // The session ended (which cleared the pick); the SAME operator taps back in and picks room R2.
    // The picked room is not on the token and is not part of the triple, so the row matches.
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession({ operatorId: "operator-a", stationId: globalStation }),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(outcomes[0]?.outcome).toBe("synced");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    // Byte-identical: the check replays into the room it was CAPTURED in, whatever is picked now.
    expect(init?.body).toBe(JSON.stringify({ room_id: "room-R1", colour_stage: 3 }));
  });
});

describe("CR-DC-068 — a 401/403 mid-replay is retryable, never dead-lettered", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // AC-3 / AC-4 — even with the gate above, a token can lapse between the check and the send.
  // That is "cannot send right now", not "the server rejected this".
  for (const status of [401, 403] as const) {
    it(`AC-3/4: a ${status} with a valid token stays queued with no failure reason`, async () => {
      const key = generateIdempotencyKey();
      await enqueueWrite(db, {
        idempotencyKey: key,
        method: "POST",
        url: "https://app.bananaworld-dc.test/api/item-receipt",
        headers: {},
        body: null,
        queuedAt: "2026-08-19T11:00:00.000Z",
        warehouseId: TEST_SESSION_WAREHOUSE,
        operatorId: TEST_SESSION_OPERATOR,
        stationId: TEST_SESSION_STATION,
      });

      const outcomes = await runReplay({
        db,
        readToken: async () => stationSession(),
        fetch: vi.fn().mockResolvedValue(new Response(null, { status })) as unknown as typeof fetch,
        now: () => NOW,
      });

      expect(outcomes[0]?.outcome).toBe("retry-later");
      const row = (await getPendingWrites(db)).find((w) => w.idempotencyKey === key);
      expect(row?.status).toBe("queued");
      expect(row?.failureReason).toBeNull();
      expect(row?.failureMessage).toBeNull();
      // ⚠ A real send DID happen here, so the attempt is correctly spent — unlike the gate above.
      expect(row?.attemptCount).toBe(1);
    });
  }

  it("a 400 still dead-letters — the 401/403 arm did not swallow the whole 4xx range", async () => {
    const key = generateIdempotencyKey();
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "https://app.bananaworld-dc.test/api/item-receipt",
      headers: {},
      body: null,
      queuedAt: "2026-08-19T11:00:00.000Z",
      warehouseId: TEST_SESSION_WAREHOUSE,
      operatorId: TEST_SESSION_OPERATOR,
      stationId: TEST_SESSION_STATION,
    });

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 400 })) as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(outcomes[0]?.outcome).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // CR-DC-069 — the new triggers do not open a door around this gate
  // -------------------------------------------------------------------------
  //
  // 🔴 CR-DC-069 adds four ways to reach the replay loop (Retry all, Retry one, DRAIN_QUEUE, and a
  // drain on PIN sign-in) on top of the two that existed. Every one of them ends in the SAME
  // `runReplay`, so the gate above governs them all — but "obviously" is not evidence, and the whole
  // reason CR-DC-068 exists is that a declared outcome went eight months without a code path. These
  // two assert it as behaviour: through the door the operator's Retry opens, and through the door
  // the reconnect drain opens.

  // T-10 — a held row stays held no matter WHICH trigger ran the pass.
  it("T-10: a drain triggered by the operator's own Retry still refuses somebody else's held row", async () => {
    const mine = await seed({ operatorId: TEST_SESSION_OPERATOR });
    const theirs = await seed({ operatorId: OPERATOR_B });
    // Both rows are `failed`, so RETRY_ALL re-queues BOTH — the operator can only press one button
    // and it does not know whose work is whose. The gate is what keeps the other person's work in.
    await markWriteFailed(db, mine, "UNKNOWN", "server unreachable", NOW.toISOString());
    await markWriteFailed(db, theirs, "UNKNOWN", "server unreachable", NOW.toISOString());

    await handleMessage({ type: "RETRY_ALL" }, { db, isOnline: () => true, now: () => NOW });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    // 🔴 The SPY, per row. Exactly one request left the device, and it was mine.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const held = outcomes.find((o) => o.idempotencyKey === theirs);
    expect(held?.outcome).toBe("skipped");
    if (held?.outcome === "skipped") expect(held.reason).toBe("held-for-operator");
    // Their row survives, queued and replayable, with its restored budget untouched.
    const theirRow = await rowFor(theirs);
    expect(theirRow.status).toBe("queued");
    expect(theirRow.attemptCount).toBe(0);
  });

  // T-11 — the drain that fires on the LOGIN screen, with nobody signed in. The tablet layout wraps
  // that screen too, so this happens on every cold start before a PIN is entered.
  it("T-11: a drain with no session sends nothing and burns no attempt", async () => {
    const keys = [await seed(), await seed()];
    const fetchSpy = vi.fn();

    const reply = await handleMessage(
      { type: "DRAIN_QUEUE" },
      { db, isOnline: () => true, now: () => NOW },
    );
    expect(reply).toEqual({ type: "DRAIN_REPLY", accepted: true });
    await runReplay({
      db,
      readToken: async () => null,
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => NOW,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const key of keys) {
      const row = await rowFor(key);
      expect(row.status).toBe("queued");
      expect(row.attemptCount).toBe(0); // AC-10's ordering: the gate runs BEFORE markWriteAttempt
      expect(row.lastAttemptAt).toBeNull();
    }
  });
});
