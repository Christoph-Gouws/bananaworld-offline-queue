// `installQueueWorker`, driven against a fake worker scope with NEUTRAL settings (CR-DC-227).
//
// Nothing under the DC's tests/** could ever import its service-worker entry — it is serwist-compiled to
// public/sw.js — so the listener wiring was proved only by a source scan. It lives in a package now, so
// it can be CALLED: these legs fire the real listeners and read what the worker did.
//
// 🔴 THE TOKEN-CONFINEMENT LEGS (SEC-AUTH-013 / REV-9) are the ones that matter most. Break the
// same-origin gate in `src/sw/install.ts` and the "cross-origin" legs below go red.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installQueueWorker } from "../../../src/sw/install";
import { enqueueWrite, getPendingWrites } from "../../../src/queue";
import { openQueueDb, type OfflineQueueDB } from "../../../src/schema";
import { storeSessionToken } from "../../../src/token-storage";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { fakeScope, lifecycleEvent, ORIGIN } from "../../support/fakes";

// 🔴 A UNIQUE DATABASE NAME PER TEST. The installed worker holds its own connection to the database for
// as long as it lives and there is no way to close it from outside, so a shared name would leave every
// later test's deleteDatabase blocked behind it. (`dbName` being a setting is what makes this possible.)
let testSettings = NEUTRAL_SETTINGS;
let testCount = 0;
let db: OfflineQueueDB;
let fetchLog: Array<{ url: string; authorization: string | null }>;
const order: string[] = [];

beforeEach(async () => {
  testCount += 1;
  testSettings = { ...NEUTRAL_SETTINGS, dbName: `neutral-install-${testCount}` };
  db = await openQueueDb(testSettings.dbName);
  fetchLog = [];
  order.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      fetchLog.push({ url: request.url, authorization: request.headers.get("Authorization") });
      order.push("send");
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

async function signedIn(extra: { autoLogoffMinutes?: number } = {}): Promise<void> {
  await storeSessionToken(db, {
    token: "worker-held-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    warehouseId: "wh-a",
    stationId: "station-a",
    operatorId: "operator-a",
    ...extra,
  });
}

function install(options: { online?: boolean } = {}) {
  const fake = fakeScope({ online: options.online ?? true });
  vi.stubGlobal("caches", fake.caches.storage);
  installQueueWorker(fake.scope, testSettings);
  return fake;
}

function fetchEvent(request: Request, clientId = "tablet") {
  const responses: Array<Promise<Response>> = [];
  const life = lifecycleEvent({
    request,
    clientId,
    respondWith: (p: Promise<Response>) => void responses.push(p),
  });
  return { ...life, responses };
}

describe("the listeners", () => {
  it("registers install, activate, fetch, message and sync — once each", () => {
    const fake = install();
    for (const type of ["install", "activate", "fetch", "message", "sync"]) {
      expect(fake.count(type), type).toBe(1);
    }
  });

  it("install precaches the settings' assets into the settings' shell cache, then skips waiting", async () => {
    const fake = install();
    const { event, settled } = lifecycleEvent({});
    fake.fire("install", event);
    await settled();
    expect(fake.caches.names()).toEqual([NEUTRAL_SETTINGS.shellCacheVersion]);
    expect(fake.caches.entries(NEUTRAL_SETTINGS.shellCacheVersion)).toEqual([
      `${ORIGIN}/manifest.webmanifest`,
    ]);
    expect(fake.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("activate sweeps retired generations of the MANAGED prefixes, keeps the current caches and anyone else's, then claims", async () => {
    const fake = install();
    const nav = NEUTRAL_SETTINGS.navigation;
    for (const name of [
      NEUTRAL_SETTINGS.shellCacheVersion,
      nav.navCache,
      nav.assetCache,
      "neutral-shell-v0", // retired shell generation — managed prefix, not current
      "neutral-nav-v0", // retired nav generation
      "neutral-assets-v0", // retired asset generation
      "somebody-elses-cache", // not ours: must survive
    ]) {
      await fake.caches.storage.open(name);
    }
    const { event, settled } = lifecycleEvent({});
    fake.fire("activate", event);
    await settled();
    expect(fake.caches.names().sort()).toEqual(
      [
        NEUTRAL_SETTINGS.shellCacheVersion,
        nav.navCache,
        nav.assetCache,
        "somebody-elses-cache",
      ].sort(),
    );
    expect(fake.scope.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 token confinement — the same-origin gate", () => {
  it("a CROSS-ORIGIN write passes straight through: no respondWith, no Bearer, nothing queued", async () => {
    await signedIn();
    const fake = install({ online: false });
    const ev = fetchEvent(
      new Request("https://storage.example/api/upload", { method: "PUT", body: "photo" }),
    );
    fake.fire("fetch", ev.event);
    expect(ev.responses).toHaveLength(0);
    expect(await getPendingWrites(db)).toHaveLength(0);
    expect(fetchLog).toHaveLength(0);
  });

  it("a CROSS-ORIGIN read never gets the worker-held token", async () => {
    await signedIn();
    const fake = install();
    const ev = fetchEvent(new Request("https://storage.example/api/runs/home"));
    fake.fire("fetch", ev.event);
    expect(ev.responses).toHaveLength(0);
    expect(fetchLog).toHaveLength(0);
  });

  it("a same-origin tablet READ gets the Bearer — and only the worker ever attached it", async () => {
    await signedIn();
    const fake = install();
    const ev = fetchEvent(new Request(`${ORIGIN}/api/anything`));
    fake.fire("fetch", ev.event);
    expect(ev.responses).toHaveLength(1);
    await ev.responses[0];
    expect(fetchLog.at(0)?.authorization).toBe("Bearer worker-held-token");
  });

  it("the SAME read from a page that is NOT the tablet surface gets NO Bearer", async () => {
    await signedIn();
    const fake = install();
    const ev = fetchEvent(new Request(`${ORIGIN}/api/anything`), "not-a-tablet-client");
    fake.fire("fetch", ev.event);
    await ev.responses[0];
    expect(fetchLog.at(0)?.authorization).toBeNull();
  });
});

describe("tablet writes through the installed worker", () => {
  it("OFFLINE: answers 202 X-Queued-Locally, queues one row, and registers Background Sync under the SETTINGS' tag", async () => {
    await signedIn();
    const fake = install({ online: false });
    const ev = fetchEvent(new Request(`${ORIGIN}/api/jobs/save`, { method: "POST", body: "{}" }));
    fake.fire("fetch", ev.event);
    const response = await ev.responses[0];
    expect(response?.status).toBe(202);
    expect(response?.headers.get("X-Queued-Locally")).toBe("true");
    expect(await getPendingWrites(db)).toHaveLength(1);
    expect(fake.registeredSyncTags).toEqual([NEUTRAL_SETTINGS.backgroundSyncTag]);
  });

  it("the app's never-queued write is not queued and is not synced", async () => {
    await signedIn();
    const fake = install({ online: false });
    const ev = fetchEvent(
      new Request(`${ORIGIN}/api/labels/print`, { method: "POST", body: "{}" }),
    );
    fake.fire("fetch", ev.event);
    await ev.responses[0];
    expect(await getPendingWrites(db)).toHaveLength(0);
    expect(fake.registeredSyncTags).toEqual([]);
  });
});

describe("message and sync — replay", () => {
  async function seedQueuedWrite(): Promise<void> {
    await signedIn();
    await enqueueWrite(db, {
      idempotencyKey: "k-1",
      method: "POST",
      url: `${ORIGIN}/api/jobs/save`,
      headers: { "content-type": "application/json" },
      body: "{}",
      queuedAt: new Date().toISOString(),
      warehouseId: "wh-a",
      operatorId: "operator-a",
      stationId: "station-a",
    });
  }

  it("🔴 DRAIN_QUEUE: the page is answered FIRST, then the queue is sent (askServiceWorker times out at 1500 ms)", async () => {
    await seedQueuedWrite();
    const fake = install();
    const port = { postMessage: vi.fn(() => void order.push("reply")) };
    const { event, settled } = lifecycleEvent({ data: { type: "DRAIN_QUEUE" }, ports: [port] });
    fake.fire("message", event);
    await settled();
    expect(order).toEqual(["reply", "send"]);
    expect(await getPendingWrites(db)).toHaveLength(0);
    // …and every open tab hears the result.
    expect(fake.posted.map((m) => (m as { type: string }).type)).toEqual([
      "SYNC_STATE_CHANGED",
      "REPLAY_BATCH_COMPLETE",
    ]);
  });

  it("a status poll replies but does NOT send anything", async () => {
    await seedQueuedWrite();
    const fake = install();
    const port = { postMessage: vi.fn(() => void order.push("reply")) };
    const { event, settled } = lifecycleEvent({
      data: { type: "SYNC_STATUS_REQUEST" },
      ports: [port],
    });
    fake.fire("message", event);
    await settled();
    expect(order).toEqual(["reply"]);
    expect(await getPendingWrites(db)).toHaveLength(1);
  });

  it("the status snapshot carries the SETTINGS' build id (CR-DC-086)", async () => {
    const fake = install();
    const port = { postMessage: vi.fn() };
    const { event, settled } = lifecycleEvent({
      data: { type: "SYNC_STATUS_REQUEST" },
      ports: [port],
    });
    fake.fire("message", event);
    await settled();
    const reply = port.postMessage.mock.calls.at(0)?.at(0) as {
      snapshot: { swBuildId: string };
    };
    expect(reply.snapshot.swBuildId).toBe("neutral-build");
  });

  it("a sync event with the SETTINGS' tag replays; any other tag is ignored", async () => {
    await seedQueuedWrite();
    const fake = install();
    const other = lifecycleEvent({ tag: "somebody-elses-tag" });
    fake.fire("sync", other.event);
    await other.settled();
    expect(await getPendingWrites(db)).toHaveLength(1);

    const mine = lifecycleEvent({ tag: NEUTRAL_SETTINGS.backgroundSyncTag });
    fake.fire("sync", mine.event);
    await mine.settled();
    expect(await getPendingWrites(db)).toHaveLength(0);
  });

  it("SESSION_ACTIVITY asks for a renewal at the SETTINGS' path, with the worker-held token", async () => {
    // A five-minute station whose token has 4 minutes left: inside the max(15, window/2) threshold.
    await storeSessionToken(db, {
      token: "worker-held-token",
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
      warehouseId: "wh-a",
      stationId: "station-a",
      operatorId: "operator-a",
      autoLogoffMinutes: 5,
    });
    const fake = install();
    const { event, settled } = lifecycleEvent({
      data: { type: "SESSION_ACTIVITY" },
      ports: [{ postMessage: vi.fn() }],
    });
    fake.fire("message", event);
    await settled();
    expect(fetchLog.map((f) => new URL(f.url).pathname)).toContain(
      NEUTRAL_SETTINGS.sessionRenewalPath,
    );
    expect(
      fetchLog.find((f) => f.url.endsWith(NEUTRAL_SETTINGS.sessionRenewalPath))?.authorization,
    ).toBe("Bearer worker-held-token");
  });
});

describe("the wiring tripwire", () => {
  // The DC could only prove this by scanning the entry's source; the package scans ITS OWN file too, so
  // a deletion of the wiring reddens here AND the behaviour legs above go red. Comments are stripped
  // first (line comments, then block comments) so a mention in prose cannot satisfy it.
  it("install.ts still gates the drain on shouldReplayAfterMessage, after the reply, single-flighted", async () => {
    const source = await readFile(resolve(process.cwd(), "src/sw/install.ts"), "utf8");
    const code = source
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const listener = code.slice(code.indexOf('self.addEventListener("message"'));
    expect(listener).toContain("shouldReplayAfterMessage(");
    expect(listener).toContain("replayAndBroadcast()");
    expect(listener.indexOf("postMessage(reply)")).toBeLessThan(
      listener.indexOf("shouldReplayAfterMessage("),
    );
    expect(code).toContain("singleFlight(runReplayAndBroadcast)");
  });
});
