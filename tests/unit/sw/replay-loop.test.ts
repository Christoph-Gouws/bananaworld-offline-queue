// Unit test — replay loop (PRD-FUNC-130 deterministic conflict resolution).
//
// Anchors: EPIC-001-M007-SCOPE-004, QA-AUTO-041, PRD-FUNC-130, API-FAIL-007,
//          TECH-BE-010, PRD-NFR-005.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENCY_HEADER,
  countPendingWrites,
  enqueueWrite,
  generateIdempotencyKey,
  getFailedWrites,
  getPendingWrites,
  getRecentHistory,
  openOfflineQueueDB,
  retryFailedWrite,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { backoffSecondsFor, runReplay } from "@/sw/replay-loop";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

// CR-DC-068 — a seeded row now carries the identity of the operator who captured it, because a row
// without one can no longer be replayed at all: it is held for a human. `stationSession()` is the
// matching session, so these rows send exactly as they always did.
async function seedQueued(url = "/api/receipt") {
  const key = generateIdempotencyKey();
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url,
    headers: {},
    body: JSON.stringify({ x: 1 }),
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
  });
  return key;
}

describe("backoffSecondsFor (exponential schedule, capped 30s)", () => {
  it("0 attempts → 0s; 1 → 1; 2 → 2; 3 → 4; 4 → 8; 5 → 16; 6+ → 30", () => {
    expect(backoffSecondsFor(0)).toBe(0);
    expect(backoffSecondsFor(1)).toBe(1);
    expect(backoffSecondsFor(2)).toBe(2);
    expect(backoffSecondsFor(3)).toBe(4);
    expect(backoffSecondsFor(4)).toBe(8);
    expect(backoffSecondsFor(5)).toBe(16);
    expect(backoffSecondsFor(6)).toBe(30);
    expect(backoffSecondsFor(100)).toBe(30);
  });
});

describe("runReplay (PRD-FUNC-130 + API-FAIL-007)", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("on 2xx — moves the write to sync_history (queue drains)", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("synced");
    expect(await countPendingWrites(db)).toBe(0);
    expect(await getRecentHistory(db)).toHaveLength(1);
  });

  it("REV-9 — discards a queued cross-origin write (e.g. a pre-fix QC photo PUT) instead of retrying it forever", async () => {
    const ORIGIN = "https://app.bananaworld-dc.test";
    // A poison entry: the QC photo PUT to a cross-origin Supabase signed URL that should never have
    // been queued (captured before the SW same-origin guard). Plus a normal same-origin write.
    const poisonKey = await seedQueued(
      "https://abcdefgh.supabase.co/storage/v1/object/upload/sign/receiving-photos/x.jpg?token=t",
    );
    const goodKey = await seedQueued(`${ORIGIN}/api/item-receipt`);

    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
      swOrigin: ORIGIN,
    });

    // The cross-origin entry is discarded WITHOUT a network attempt; the same-origin one syncs.
    expect(outcomes.find((o) => o.idempotencyKey === poisonKey)?.outcome).toBe("discarded");
    expect(outcomes.find((o) => o.idempotencyKey === goodKey)?.outcome).toBe("synced");
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the same-origin write hit the network
    expect(await countPendingWrites(db)).toBe(0); // both left the queue — nothing stuck "syncing"
    const history = await getRecentHistory(db);
    expect(history.map((h) => h.outcome).sort()).toEqual(["discarded", "synced"]);
  });

  it("on 409 OFFLINE_QUEUE_SYNC_CONFLICT with SERVER_MASTER_WINS — marks failed with reason", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error_code: "OFFLINE_QUEUE_SYNC_CONFLICT",
          user_message: "Manager updated.",
          details: { reason: "SERVER_MASTER_WINS" },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("failed");
    if (outcomes[0]?.outcome === "failed") {
      expect(outcomes[0].reason).toBe("SERVER_MASTER_WINS");
    }
    const failed = await getFailedWrites(db);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failureReason).toBe("SERVER_MASTER_WINS");
  });

  // ==========================================================================
  // CR-DC-086 — THE ENVELOPE THIS APPLICATION ACTUALLY PRODUCES
  //
  // 🔴 WHY THESE CASES EXIST AND WHY THE ONES ABOVE DID NOT CATCH THE BUG. Every case above feeds
  //    `{ error_code, user_message, details }` — a shape emitted by exactly ONE thing in the whole
  //    repository, `app/api/test/queue-echo/route.ts`. Every REAL route answers
  //    `{ error: { code, message } }`. The parser read only the harness shape, so against a real
  //    409 the driver was shown the literal string "Server returned 409 Error" and every 4xx was
  //    filed UNKNOWN. The cases below feed the REAL envelope; the cases above stay UNEDITED, which
  //    is what proves the echo endpoint's own contract did not move.
  // ==========================================================================

  it("CR-DC-086 — on a REAL 409 envelope, the driver reads the route's own sentence, not a status line", async () => {
    await seedQueued("/api/driver-station/stop/abc/confirm");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "ALREADY_CONFIRMED",
            message: "This delivery has already been confirmed.",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes[0]?.outcome).toBe("failed");
    const failed = await getFailedWrites(db);
    // 🔴 THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Before the fix this read
    //    "Server returned 409 Error".
    expect(failed[0]?.failureMessage).toBe("This delivery has already been confirmed.");
    // ⚠ The REASON legitimately stays UNKNOWN: ALREADY_CONFIRMED is not one of the five
    //   ConflictReason values, and inventing a sixth would be a queue-schema change (a non-goal).
    //   The reason chip and the message are two different fields and only the message moves.
    expect(failed[0]?.failureReason).toBe("UNKNOWN");
  });

  it("CR-DC-086 — IDEMPOTENCY_CONFLICT classifies off the REAL envelope too, so it can finally fire", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "IDEMPOTENCY_CONFLICT", message: "Retried with a different payload." },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes[0]?.outcome).toBe("failed");
    if (outcomes[0]?.outcome === "failed") {
      expect(outcomes[0].reason).toBe("IDEMPOTENCY_CONFLICT");
      expect(outcomes[0].message).toBe("Retried with a different payload.");
    }
  });

  it("CR-DC-086 — the REAL envelope wins over the legacy keys when a body somehow carries both", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "ALREADY_CONFIRMED", message: "The real sentence." },
          error_code: "IDEMPOTENCY_CONFLICT",
          user_message: "The legacy sentence.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    const failed = await getFailedWrites(db);
    expect(failed[0]?.failureMessage).toBe("The real sentence.");
    expect(failed[0]?.failureReason).toBe("UNKNOWN");
  });

  it("CR-DC-086 — a body with NO message at all still falls back to the status line", async () => {
    await seedQueued();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "SOMETHING_ELSE" } }), { status: 422 }),
      );
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    const failed = await getFailedWrites(db);
    expect(failed[0]?.failureMessage).toMatch(/^Server returned 422/);
  });

  // 🔴 CR-DC-109 — THE ROW MUST REMEMBER *WHICH* REFUSAL IT WAS, NOT ONLY THAT IT WAS ONE.
  //    `PO_REFERENCE_IN_USE` is not one of the five `ConflictReason` values and is never going to
  //    be (a sixth would be a queue-schema change), so before this change it landed on the row as
  //    reason UNKNOWN — indistinguishable from every other 4xx. The receiving screen has to tell it
  //    apart to re-open the reference box for an OFFLINE capture, and the only alternative would be
  //    matching on the message TEXT: a coupling that breaks the first time the sentence improves.
  it("CR-DC-109 — a 400 PO_REFERENCE_IN_USE lands its CODE on the row, beside the sentence", async () => {
    await seedQueued("/api/item-receipt/pallet");
    const sentence =
      "Already used in this depot — by an order that is no longer open, so it is not in your list.";
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "PO_REFERENCE_IN_USE",
            message: sentence,
            issues: [{ field: "inline_po.reference", message: "Enter a different reference." }],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    const failed = await getFailedWrites(db);
    expect(failed[0]?.failureCode).toBe("PO_REFERENCE_IN_USE");
    // The reason enum is UNCHANGED — this refusal is not one of PRD-FUNC-130's conflicts and must
    // not be dressed up as one. The code is the NEW fact, not a replacement for the old one.
    expect(failed[0]?.failureReason).toBe("UNKNOWN");
    expect(failed[0]?.failureMessage).toBe(sentence);
  });

  it("CR-DC-109 — a 4xx body with no code at all leaves the row's code null, not undefined-ish", async () => {
    await seedQueued();
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "No." } }), { status: 400 }),
      );
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    const failed = await getFailedWrites(db);
    expect(failed[0]?.failureCode).toBeNull();
    expect(failed[0]?.failureMessage).toBe("No.");
  });

  it("on 409 IDEMPOTENCY_CONFLICT — marks failed loudly", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error_code: "IDEMPOTENCY_CONFLICT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes[0]?.outcome).toBe("failed");
    if (outcomes[0]?.outcome === "failed") {
      expect(outcomes[0].reason).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("on 5xx — leaves the write queued + records retry-later outcome", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes[0]?.outcome).toBe("retry-later");
    expect(await countPendingWrites(db)).toBe(1);
    const pending = await getPendingWrites(db);
    expect(pending[0]?.status).toBe("queued");
  });

  it("on network error — leaves the write queued + records retry-later", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network down"));
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: mockFetch as typeof fetch,
    });
    expect(outcomes[0]?.outcome).toBe("retry-later");
    expect(await countPendingWrites(db)).toBe(1);
  });

  it("injects Authorization: Bearer <token> from SW token storage on replay", async () => {
    await seedQueued();
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await runReplay({
      db,
      readToken: async () => stationSession({ token: "fake-bearer" }),
      fetch: mockFetch as typeof fetch,
    });
    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const init = callArgs?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer fake-bearer");
  });

  it("skips writes still inside their backoff window", async () => {
    const key = await seedQueued();
    // First pass — 5xx, stays queued with attemptCount=1, lastAttemptAt=now.
    const fail = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: fail as typeof fetch,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });
    // Second pass 0.5s later — should be skipped (backoff for attempt=1 is 1s).
    const second = vi.fn();
    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: second as typeof fetch,
      now: () => new Date("2026-05-28T12:00:00.500Z"),
    });
    expect(second).not.toHaveBeenCalled();
    const skipped = outcomes.find((o) => o.idempotencyKey === key);
    expect(skipped?.outcome).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// CR-DC-069 — the same Idempotency-Key on every attempt, retries included
// ---------------------------------------------------------------------------

describe("CR-DC-069 — a retry is the SAME write trying again, never a new one", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // T-9. CR-DC-069 makes replays far commoner, which is only safe because every attempt of a row
  // carries the key it was queued with — that is what lets CR-DC-067's server-side guard answer a
  // repeat with `200 …idempotent_replay` instead of writing the pallet twice. A retry that minted a
  // fresh key would defeat that guard completely, and the new attempt-budget reset must not tempt
  // anyone into treating a retried row as a new one.
  it("T-9: every attempt sends the SAME Idempotency-Key — across 5xx retries AND across an operator retry", async () => {
    const key = await seedQueued("/api/item-receipt");
    const sentKeys: string[] = [];
    const capture = (status: number) =>
      vi.fn((_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        /* eslint-disable-next-line security/detect-object-injection -- IDEMPOTENCY_HEADER is a
           module constant, not caller input; `headers` is the bag the replay loop just built. */
        sentKeys.push(headers[IDEMPOTENCY_HEADER] ?? "MISSING");
        return Promise.resolve(new Response(null, { status }));
      });

    // Attempt 1 — 503, stays queued.
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: capture(503) as unknown as typeof fetch,
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    });
    // Attempt 2 — past the backoff window; a 409 conflict dead-letters it to `failed`.
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: capture(409) as unknown as typeof fetch,
      now: () => new Date("2026-08-19T12:00:30.000Z"),
    });
    expect((await getFailedWrites(db))[0]?.idempotencyKey).toBe(key);

    // The operator retries — the budget resets, and the write goes again.
    expect(await retryFailedWrite(db, key)).toBe(true);
    await runReplay({
      db,
      readToken: async () => stationSession(),
      fetch: capture(200) as unknown as typeof fetch,
      now: () => new Date("2026-08-19T12:01:00.000Z"),
    });

    // Three sends, ONE key. 🔴 Asserted as an EQUALITY over the whole list, so a fourth send under a
    // different key cannot hide inside a "contains" check.
    expect(sentKeys).toEqual([key, key, key]);
    expect(await countPendingWrites(db)).toBe(0);
  });
});
