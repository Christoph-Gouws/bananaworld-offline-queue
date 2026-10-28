// The fetch handler, bound to NEUTRAL settings (CR-DC-227).
//
// The DC keeps its own behaviour suites (fetch-handler, never-queued-bearer, idle-gate, storage-full,
// driver-read-serve) and runs them through its own bindings. THIS suite proves the same invariants hold
// for an app whose routes are not the DC's — which is the packhouse's position — so a DC literal that
// leaked into the package would fail here instead of hiding behind a coincidence.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadCache } from "../../../src/read-cache";
import { createFetchHandler, isSameOriginApiUrl } from "../../../src/sw/fetch-handler";
import { getPendingWrites } from "../../../src/queue";
import type { OfflineQueueDB } from "../../../src/schema";
import { openOfflineQueueDB } from "../../support/schema";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { ORIGIN } from "../../support/fakes";
import { stationSession, withFakeIndexedDB } from "../../helpers/fake-indexeddb";

const NOW = new Date("2026-08-22T07:30:00.000Z");
const iso = (minutesAgo: number): string =>
  new Date(NOW.getTime() - minutesAgo * 60 * 1000).toISOString();

const readCache = createReadCache(NEUTRAL_SETTINGS);
const handler = createFetchHandler({
  isTabletSurfacePath: NEUTRAL_SETTINGS.isTabletSurfacePath,
  authPathPrefix: NEUTRAL_SETTINGS.authPathPrefix,
  authLogoutPath: NEUTRAL_SETTINGS.authLogoutPath,
  stationPairRedeemPath: NEUTRAL_SETTINGS.stationPairRedeemPath,
  isNeverQueuedWrite: NEUTRAL_SETTINGS.isNeverQueuedWrite,
  isCachedReadPath: NEUTRAL_SETTINGS.isCachedReadPath,
  readCache,
  queueFullCode: NEUTRAL_SETTINGS.queueFullCode,
  queueFullMessage: NEUTRAL_SETTINGS.queueFullMessage,
  isLiveOnlyWrite: NEUTRAL_SETTINGS.isLiveOnlyWrite,
  earlierWorkWaitingMessage: NEUTRAL_SETTINGS.earlierWorkWaitingMessage,
  earlierWorkHeldMessage: NEUTRAL_SETTINGS.earlierWorkHeldMessage,
});

function liveSession() {
  return stationSession({
    expiresAt: new Date(NOW.getTime() + 8 * 60 * 1000).toISOString(),
    storedAt: iso(12),
    lastActivityAt: iso(1),
    autoLogoffMinutes: 5,
  });
}

const write = (path: string, body: unknown = { u: 1 }): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ALWAYS_TABLET = (): boolean => true;

let db: OfflineQueueDB;
withFakeIndexedDB();
beforeEach(async () => {
  db = await openOfflineQueueDB();
});
afterEach(() => {
  db.close();
});

describe("tablet writes — queue offline, send direct online", () => {
  it("OFFLINE: a 202 X-Queued-Locally, one row, stamped with the session identity at capture", async () => {
    const response = await handler.handleTabletWrite(write("/api/jobs/save"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => false,
      now: () => NOW,
    });
    expect(response?.status).toBe(202);
    expect(response?.headers.get("X-Queued-Locally")).toBe("true");
    const rows = await getPendingWrites(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      warehouseId: "wh-a",
      stationId: "station-a",
      operatorId: "operator-a",
    });
  });

  it("ONLINE: sent direct with the SW-held Bearer, queues nothing", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 201 });
    });
    const response = await handler.handleTabletWrite(write("/api/jobs/save"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(response?.status).toBe(201);
    expect(seen[0]?.headers.get("Authorization")).toBe("Bearer test-station-token");
    expect(await getPendingWrites(db)).toHaveLength(0);
  });

  it("an IDLE session attaches NO token — the write is queued instead (the refuse-to-attach gate)", async () => {
    const idle = stationSession({
      expiresAt: new Date(NOW.getTime() + 8 * 60 * 1000).toISOString(),
      storedAt: iso(60),
      lastActivityAt: iso(30),
      autoLogoffMinutes: 5,
    });
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const response = await handler.handleTabletWrite(write("/api/jobs/save"), {
      db,
      readToken: async () => idle,
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response?.status).toBe(202);
    expect(await getPendingWrites(db)).toHaveLength(1);
  });

  it("a write from a page that is not the app's tablet surface is not intercepted", async () => {
    const response = await handler.handleTabletWrite(write("/api/jobs/save"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: () => false,
      isOnline: () => false,
    });
    expect(response).toBeNull();
    expect(await getPendingWrites(db)).toHaveLength(0);
  });
});

describe("the settings decide what is never queued", () => {
  it("🔴 the app's never-queued write is forwarded WITH the Bearer and queues NOTHING", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response('{"ok":true}', { status: 200 });
    });
    const response = await handler.handleTabletWrite(write("/api/labels/print"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(response?.status).toBe(200);
    expect(seen[0]?.headers.get("Authorization")).toBe("Bearer test-station-token");
    expect(await getPendingWrites(db)).toHaveLength(0);
  });

  it("…and OFFLINE it is neither sent nor queued (today's behaviour: null, the page reports it)", async () => {
    const response = await handler.handleTabletWrite(write("/api/labels/print"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => false,
    });
    expect(response).toBeNull();
    expect(await getPendingWrites(db)).toHaveLength(0);
  });

  it("the PRESENT CONTROL: an ordinary write in the same offline state DOES queue", async () => {
    await handler.handleTabletWrite(write("/api/jobs/save"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => false,
    });
    expect(await getPendingWrites(db)).toHaveLength(1);
  });

  it("a path the DC never-queues is NOT special here — the package carries no DC route", async () => {
    // `/api/print/…` is the DC's never-queued prefix. These settings do not name it, so it queues.
    await handler.handleTabletWrite(write("/api/print/pallet-label"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      isOnline: () => false,
    });
    expect(await getPendingWrites(db)).toHaveLength(1);
  });
});

describe("auth requests — never queued; logout alone is given the Bearer", () => {
  const live = async () => liveSession();

  it("login (the auth prefix) is forwarded unmodified and unauthenticated", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 200 });
    });
    const response = await handler.handleAuthRequest(write("/api/identity/login"), {
      readToken: live,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(response?.status).toBe(200);
    expect(seen[0]?.headers.get("Authorization")).toBeNull();
  });

  it("logout gets the station Bearer injected for attribution", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 200 });
    });
    await handler.handleAuthRequest(write("/api/identity/logout"), {
      readToken: live,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[0]?.headers.get("Authorization")).toBe("Bearer test-station-token");
  });

  it("🔴 the RENEWAL endpoint is NOT given the logout's Bearer (page code gets no live renewal door)", async () => {
    const seen: Request[] = [];
    const fetchImpl = vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 401 });
    });
    await handler.handleAuthRequest(write(NEUTRAL_SETTINGS.sessionRenewalPath), {
      readToken: live,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("Authorization")).toBeNull();
  });

  it("the pairing door is live and unauthenticated, and any other path is not an auth request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const paired = await handler.handleAuthRequest(write(NEUTRAL_SETTINGS.stationPairRedeemPath), {
      readToken: live,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(paired?.status).toBe(200);
    expect(
      await handler.handleAuthRequest(write("/api/jobs/save"), { readToken: live, fetchImpl }),
    ).toBeNull();
  });
});

describe("reads — Bearer on same-origin tablet reads; only the app's cached paths are stored", () => {
  const read = (path: string) => new Request(`${ORIGIN}${path}`, { method: "GET" });
  const body = '{"stops":[1,2]}';

  it("a cached path: 200 is stored, then served when the live fetch THROWS, with the snapshot headers", async () => {
    const keep: Promise<unknown>[] = [];
    const ok = vi.fn(async () => new Response(body, { status: 200 }));
    const live = await handler.handleTabletRead(read("/api/runs/stop/s1"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      fetchImpl: ok as unknown as typeof fetch,
      keepAlive: (p) => keep.push(p),
      now: () => NOW,
    });
    expect(live?.status).toBe(200);
    await Promise.all(keep);

    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const served = await handler.handleTabletRead(read("/api/runs/stop/s1"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      fetchImpl: down as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(served?.headers.get("X-Offline-Snapshot")).toBe("true");
    expect(await served?.text()).toBe(body);
  });

  it("a path the app did NOT name is never stored, and its failure is re-thrown", async () => {
    const keep: Promise<unknown>[] = [];
    const ok = vi.fn(async () => new Response(body, { status: 200 }));
    await handler.handleTabletRead(read("/api/other/thing"), {
      db,
      readToken: async () => liveSession(),
      isTabletFlowRequest: ALWAYS_TABLET,
      fetchImpl: ok as unknown as typeof fetch,
      keepAlive: (p) => keep.push(p),
      now: () => NOW,
    });
    await Promise.all(keep);
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      handler.handleTabletRead(read("/api/other/thing"), {
        db,
        readToken: async () => liveSession(),
        isTabletFlowRequest: ALWAYS_TABLET,
        fetchImpl: down as unknown as typeof fetch,
        now: () => NOW,
      }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("with no token the read passes through untouched (null) — it 401s and the page re-authenticates", async () => {
    const response = await handler.handleTabletRead(read("/api/runs/home"), {
      db,
      readToken: async () => null,
      isTabletFlowRequest: ALWAYS_TABLET,
    });
    expect(response).toBeNull();
  });
});

describe("the tablet-shell predicate and the same-origin gate", () => {
  it("isTabletClientUrl follows the app's predicate and the worker's own origin", () => {
    expect(handler.isTabletClientUrl(`${ORIGIN}/station/job/1`, ORIGIN)).toBe(true);
    expect(handler.isTabletClientUrl(`${ORIGIN}/admin`, ORIGIN)).toBe(false);
    expect(handler.isTabletClientUrl("https://evil.example/station/job/1", ORIGIN)).toBe(false);
    expect(handler.isTabletClientUrl(null, ORIGIN)).toBe(false);
  });

  it("🔴 isSameOriginApiUrl is the token-leak guard: only same-origin /api/* qualifies", () => {
    expect(isSameOriginApiUrl(`${ORIGIN}/api/x`, ORIGIN)).toBe(true);
    expect(isSameOriginApiUrl("https://storage.example/api/x", ORIGIN)).toBe(false);
    expect(isSameOriginApiUrl(`${ORIGIN}/not-api`, ORIGIN)).toBe(false);
    expect(isSameOriginApiUrl("::not a url::", ORIGIN)).toBe(false);
  });
});

describe("a full device — the settings supply the words and the code", () => {
  it("queueFullResponse is a 507 carrying the app's code and message, never a 202", async () => {
    const response = handler.queueFullResponse("key-1");
    expect(response.status).toBe(507);
    expect(response.headers.get("X-Queue-Full")).toBe("true");
    expect(await response.json()).toEqual({
      error: { code: "NEUTRAL_FULL", message: "Neutral: not saved, this device is full." },
    });
  });
});
