// Unit test — KI-227-01 / CR-DC-240: the replay loop must call `fetch` UNBOUND.
//
// Anchors: CR-DC-240, KI-227-01 (disclosed by the CR-DC-227 review), PRD-NFR-005.
//
// THE DEFECT. `runReplay` kept the native `fetch` on a context object and called it as a method of
// that object. In a Chromium service worker that throws "TypeError: Failed to execute 'fetch' on
// 'WorkerGlobalScope': Illegal invocation"; the loop read the throw as a network failure, so nothing
// queued offline ever reached a server. Every other suite injects a stub `fetch` that does not care
// what `this` is, which is why none caught it.
//
// THIS SUITE'S STAND-IN DOES CARE. It throws unless it is called with `this` undefined or the global
// object — the same rule the real WebIDL operation enforces — and it is installed as the GLOBAL
// `fetch` (no `deps.fetch`), because the default is exactly where the defect lived.
//
// Ported from the DC (CR-DC-240) by CR-DC-227. It was an `it.fails` pin at package v0.1.0; it is a passing
// test from v0.2.0.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueWrite,
  generateIdempotencyKey,
  getPendingWrites,
  openOfflineQueueDB,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { runReplay } from "@/sw/replay-loop";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

/** A `fetch` that refuses to be called as a method of anything else — like Chromium's. */
function makeBrowserLikeFetch() {
  const calls: string[] = [];
  const fake = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
    }
    calls.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fake: fake as unknown as typeof fetch, calls };
}

let db: OfflineQueueDB;
const NOW = new Date("2026-10-11T12:00:00.000Z");

async function seed(): Promise<string> {
  const key = generateIdempotencyKey();
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url: "https://app.bananaworld-dc.test/api/item-receipt",
    headers: {},
    body: "{}",
    queuedAt: "2026-10-11T11:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
  });
  return key;
}

describe("KI-227-01 — the replay loop calls fetch unbound", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  // Non-vacuity: the stand-in really does refuse a method call. Without this the suite below could
  // pass against a stand-in that accepts anything.
  it("the stand-in refuses a method-form call, as Chromium does", () => {
    const { fake } = makeBrowserLikeFetch();
    const holder = { fetchImpl: fake };
    expect(() => holder.fetchImpl("/x")).toThrow(/Illegal invocation/);
  });

  it("a queued write reaches the (global) fetch exactly once and is synced", async () => {
    const { fake, calls } = makeBrowserLikeFetch();
    vi.stubGlobal("fetch", fake);
    const key = await seed();

    const outcomes = await runReplay({
      db,
      readToken: async () => stationSession(),
      now: () => NOW,
    });

    expect(calls).toEqual(["https://app.bananaworld-dc.test/api/item-receipt"]);
    expect(outcomes).toEqual([{ idempotencyKey: key, outcome: "synced" }]);
    expect(await getPendingWrites(db)).toHaveLength(0);
  });
});
