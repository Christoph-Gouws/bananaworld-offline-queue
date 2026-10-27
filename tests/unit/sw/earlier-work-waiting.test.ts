// CR-DC-267 (debt D-c) — an online save must not jump ahead of earlier work still waiting on the device.
//
// With signal and a usable session a write used to go STRAIGHT to the office even while earlier rows sat
// in backoff or were held, so the new save took the next number. Now an ordinary write joins the queue
// (202) and a live-only write is refused (409, nothing queued). With nothing waiting, behaviour is as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadCache } from "../../../src/read-cache";
import { createFetchHandler } from "../../../src/sw/fetch-handler";
import { enqueueWrite, getPendingWrites, hasEarlierWaitingWork } from "../../../src/queue";
import type { OfflineQueueDB } from "../../../src/schema";
import { openOfflineQueueDB } from "../../support/schema";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { ORIGIN } from "../../support/fakes";
import { stationSession, withFakeIndexedDB } from "../../helpers/fake-indexeddb";

const NOW = new Date("2026-10-27T08:00:00.000Z");

const handler = createFetchHandler({
  isTabletSurfacePath: NEUTRAL_SETTINGS.isTabletSurfacePath,
  authPathPrefix: NEUTRAL_SETTINGS.authPathPrefix,
  authLogoutPath: NEUTRAL_SETTINGS.authLogoutPath,
  stationPairRedeemPath: NEUTRAL_SETTINGS.stationPairRedeemPath,
  isNeverQueuedWrite: NEUTRAL_SETTINGS.isNeverQueuedWrite,
  isCachedReadPath: NEUTRAL_SETTINGS.isCachedReadPath,
  readCache: createReadCache(NEUTRAL_SETTINGS),
  queueFullCode: NEUTRAL_SETTINGS.queueFullCode,
  queueFullMessage: NEUTRAL_SETTINGS.queueFullMessage,
  isLiveOnlyWrite: NEUTRAL_SETTINGS.isLiveOnlyWrite,
  earlierWorkWaitingMessage: NEUTRAL_SETTINGS.earlierWorkWaitingMessage,
});

const live = () =>
  stationSession({
    expiresAt: new Date(NOW.getTime() + 8 * 60 * 1000).toISOString(),
    storedAt: new Date(NOW.getTime() - 12 * 60 * 1000).toISOString(),
    lastActivityAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
    autoLogoffMinutes: 5,
  });

const write = (path: string): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

let db: OfflineQueueDB;
withFakeIndexedDB();
beforeEach(async () => {
  db = await openOfflineQueueDB();
});
afterEach(() => db.close());

async function seedWaiting(overrides: Partial<Parameters<typeof enqueueWrite>[1]> = {}) {
  await enqueueWrite(db, {
    idempotencyKey: "earlier",
    method: "POST",
    url: `${ORIGIN}/api/jobs/earlier`,
    headers: {},
    body: "{}",
    queuedAt: "2026-10-27T07:00:00.000Z",
    warehouseId: "wh-a",
    operatorId: "operator-a",
    stationId: "station-a",
    ...overrides,
  });
}

function run(path: string, fetchImpl: ReturnType<typeof vi.fn>) {
  return handler.handleTabletWrite(write(path), {
    db,
    readToken: async () => live(),
    isTabletFlowRequest: () => true,
    isOnline: () => true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });
}

describe("CR-DC-267 — an online save waits its turn", () => {
  it("nothing waiting: sent live exactly as before", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    expect((await run("/api/jobs/save", fetchImpl))?.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("earlier work waiting: an ordinary write is QUEUED behind it (202), not sent", async () => {
    await seedWaiting();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const response = await run("/api/jobs/save", fetchImpl);
    expect(response?.status).toBe(202);
    expect(response?.headers.get("X-Queued-Locally")).toBe("true");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toHaveLength(2);
  });

  it("earlier work waiting: a LIVE-ONLY write is refused 409 EARLIER_WORK_WAITING and nothing is queued", async () => {
    await seedWaiting();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const response = await run("/api/live-only", fetchImpl);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: { code: "EARLIER_WORK_WAITING", message: NEUTRAL_SETTINGS.earlierWorkWaitingMessage },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getPendingWrites(db)).toHaveLength(1);
  });

  it("nothing waiting: a live-only write is sent live", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    expect((await run("/api/live-only", fetchImpl))?.status).toBe(201);
  });

  it("a REFUSED earlier row (failed) does not make later saves wait", async () => {
    await seedWaiting();
    const row = (await getPendingWrites(db))[0]!;
    await db.put("pending_writes", { ...row, status: "failed" });
    expect(await hasEarlierWaitingWork(db)).toBe(false);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    expect((await run("/api/jobs/save", fetchImpl))?.status).toBe(201);
  });

  it("a PRE-UPDATE earlier row does not make later saves wait", async () => {
    await seedWaiting();
    const row = (await getPendingWrites(db))[0]!;
    const { replayGeneration: _drop, ...old } = row;
    void _drop;
    await db.put("pending_writes", old);
    expect(await hasEarlierWaitingWork(db)).toBe(false);
  });

  it("a `syncing` row counts as waiting", async () => {
    await seedWaiting();
    const row = (await getPendingWrites(db))[0]!;
    await db.put("pending_writes", { ...row, status: "syncing" });
    expect(await hasEarlierWaitingWork(db)).toBe(true);
  });
});
