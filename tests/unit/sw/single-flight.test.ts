// Unit test — CR-DC-069: overlapping replay triggers coalesce into ONE pass.
//
// Anchors: CR-DC-069 (§2.6), CR-DC-067 (the Idempotency-Key backstop this is not a substitute for),
//          PRD-NFR-005, PRD-NFR-006 (multi-station concurrent).
//
// 🔴 WHY THIS SUITE EXISTS. `src/sw/replay-loop.ts` carried a comment asserting that concurrent
// passes were prevented because "the markWriteAttempt status flips to `syncing`". It was false:
// `getPendingWrites` ranks `syncing` rows rather than excluding them, and `replayOneWrite` skips only
// `failed`. Before CR-DC-069 the loop had two triggers that rarely coincided; it now has six, and
// reconnect + visibility + Background Sync all fire within milliseconds of a tablet being picked up
// on WiFi. The first `describe` proves the race is real against the REAL queue; the second proves
// the wrapper closes it. Deleting the wrapper reddens the second and leaves the first as the record
// of why it was needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { singleFlight } from "@/sw/single-flight";
import { runReplay } from "@/sw/replay-loop";
import {
  enqueueWrite,
  generateIdempotencyKey,
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

async function seedWrites(count: number): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = generateIdempotencyKey();
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "https://app.bananaworld-dc.test/api/item-receipt",
      headers: {},
      body: JSON.stringify({ pallet: key }),
      queuedAt: `2026-08-19T11:0${i}:00.000Z`,
      warehouseId: TEST_SESSION_WAREHOUSE,
      operatorId: TEST_SESSION_OPERATOR,
      stationId: TEST_SESSION_STATION,
    });
    keys.push(key);
  }
  return keys;
}

/**
 * A fetch that takes a real tick to answer. That is what makes the overlap genuine: a second pass
 * gets to read `pending_writes` while the first one's request is still in the air, which is exactly
 * the shape of the race on a tablet picked up on WiFi.
 */
function slowFetch() {
  return vi.fn(
    () =>
      new Promise<Response>((resolvePromise) => {
        setTimeout(
          () => resolvePromise(new Response(JSON.stringify({ ok: true }), { status: 200 })),
          5,
        );
      }),
  );
}

describe("CR-DC-069 — the race the old comment claimed did not exist", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // 🔴 THE PROBE. Two UNWRAPPED passes over one row send it TWICE. This is not a hypothetical: it is
  // what every new trigger this change adds would have made routine.
  it("two concurrent RAW runReplay passes send the same write twice", async () => {
    await seedWrites(1);
    const spy = slowFetch();
    const pass = () =>
      runReplay({
        db,
        readToken: async () => stationSession(),
        fetch: spy as unknown as typeof fetch,
        now: () => NOW,
      });

    await Promise.all([pass(), pass()]);

    expect(spy).toHaveBeenCalledTimes(2); // ONE row, sent TWICE
  });

  // T-8 — and with the wrapper, exactly one fetch per row.
  it("T-8: two concurrent single-flighted passes produce exactly ONE fetch per row", async () => {
    await seedWrites(3);
    const spy = slowFetch();
    const pass = singleFlight(() =>
      runReplay({
        db,
        readToken: async () => stationSession(),
        fetch: spy as unknown as typeof fetch,
        now: () => NOW,
      }),
    );

    const a = pass();
    const b = pass();
    const c = pass();
    // All three callers were handed the SAME run — that is what coalescing means.
    expect(b).toBe(a);
    expect(c).toBe(a);

    await Promise.all([a, b, c]);

    expect(spy).toHaveBeenCalledTimes(3); // three rows, three sends — not six, not nine
  });
});

describe("CR-DC-069 — singleFlight itself", () => {
  it("runs the wrapped function once for overlapping callers and returns one shared result", async () => {
    let started = 0;
    let release: () => void = () => {};
    const wrapped = singleFlight(async () => {
      started += 1;
      await new Promise<void>((resolveRun) => {
        release = () => resolveRun();
      });
      return started;
    });

    const first = wrapped();
    const second = wrapped();
    expect(second).toBe(first);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(started).toBe(1);
  });

  it("clears the slot on success, so the NEXT trigger starts a genuinely fresh pass", async () => {
    let started = 0;
    const wrapped = singleFlight(async () => {
      started += 1;
      return started;
    });

    expect(await wrapped()).toBe(1);
    expect(await wrapped()).toBe(2);
    expect(started).toBe(2);
  });

  // 🔴 A failed pass must not wedge the queue forever. If the slot were only cleared on success, one
  // network error would leave every later trigger returning the same rejected promise — silently
  // turning a transient failure into a permanently undrainable tablet.
  it("clears the slot on FAILURE too — one bad pass does not wedge every later trigger", async () => {
    let started = 0;
    const wrapped = singleFlight(async () => {
      started += 1;
      if (started === 1) throw new Error("network");
      return "recovered";
    });

    await expect(wrapped()).rejects.toThrow("network");
    await expect(wrapped()).resolves.toBe("recovered");
    expect(started).toBe(2);
  });

  it("propagates the rejection to every caller coalesced into the failing run", async () => {
    let release: () => void = () => {};
    const wrapped = singleFlight(async () => {
      await new Promise<void>((resolveRun) => {
        release = () => resolveRun();
      });
      throw new Error("boom");
    });

    const first = wrapped();
    const second = wrapped();
    release();
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });
});
