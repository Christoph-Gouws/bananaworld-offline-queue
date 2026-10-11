// The pre-update clear, as the INSTALLED worker runs it (CR-DC-240, carried into the package by CR-DC-227).
//
// Anchors: KI-227-01. The owner ruled that a tablet clears work saved by a pre-fix worker ONCE, on the first
// activation of the fixed worker and BEFORE any replay can run, and that a tablet which already did so on
// the DC does NOT do it again after the move into the package. These legs fire the real listeners.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRE_UPDATE_CLEAR_ID, openQueueDb, type OfflineQueueDB } from "../../../src/schema";
import { enqueueWrite, getPendingWrites } from "../../../src/queue";
import { readPreUpdateClear } from "../../../src/pre-update-clear";
import { installQueueWorker } from "../../../src/sw/install";
import { storeSessionToken } from "../../../src/token-storage";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { fakeScope, lifecycleEvent, ORIGIN } from "../../support/fakes";

let testCount = 0;
let settings = NEUTRAL_SETTINGS;
let db: OfflineQueueDB;
let sent: Array<{ url: string; body: string | null }>;

beforeEach(async () => {
  testCount += 1;
  settings = { ...NEUTRAL_SETTINGS, dbName: `neutral-pre-update-${testCount}` };
  db = await openQueueDb(settings.dbName);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sent.push({ url: new URL(request.url).pathname, body: await request.text() });
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

/** A row exactly as a PRE-FIX worker wrote it: no `replayGeneration`. */
async function seedPreFixRow(key: string): Promise<void> {
  await db.add("pending_writes", {
    idempotencyKey: key,
    method: "POST",
    url: `${ORIGIN}/api/jobs/save`,
    headers: {},
    body: JSON.stringify({ secret: "do-not-send" }),
    queuedAt: "2026-06-03T07:12:00.000Z",
    lastAttemptAt: null,
    attemptCount: 0,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    warehouseId: "wh-a",
    operatorId: "operator-a",
    stationId: "station-a",
  });
}

async function signedIn(): Promise<void> {
  await storeSessionToken(db, {
    token: "worker-held-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    warehouseId: "wh-a",
    stationId: "station-a",
    operatorId: "operator-a",
  });
}

function install() {
  const fake = fakeScope({ online: true });
  vi.stubGlobal("caches", fake.caches.storage);
  installQueueWorker(fake.scope, settings);
  return fake;
}

describe("activate", () => {
  it("clears the pre-fix rows and writes the marker BEFORE it claims clients", async () => {
    await seedPreFixRow("old-1");
    const fake = install();
    const markerWhenClaimed: boolean[] = [];
    (fake.scope.clients.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      markerWhenClaimed.push(
        (await db.get("queue_maintenance", PRE_UPDATE_CLEAR_ID)) !== undefined,
      );
    });

    const { event, settled } = lifecycleEvent({});
    fake.fire("activate", event);
    await settled();

    expect(markerWhenClaimed).toEqual([true]);
    expect(await getPendingWrites(db)).toEqual([]);
    expect((await readPreUpdateClear(db))?.rows.map((r) => r.idempotencyKey)).toEqual(["old-1"]);
  });

  it("a tablet that ALREADY ran the clear is not cleared again (the marker carries over)", async () => {
    // The marker exactly as CR-DC-240's DC build wrote it, in the same database.
    await db.put("queue_maintenance", {
      id: PRE_UPDATE_CLEAR_ID,
      clearedAt: "2026-10-11T18:00:00.000Z",
      rows: [],
    });
    await seedPreFixRow("late-old-row");
    const fake = install();

    const { event, settled } = lifecycleEvent({});
    fake.fire("activate", event);
    await settled();

    expect((await readPreUpdateClear(db))?.clearedAt).toBe("2026-10-11T18:00:00.000Z");
    expect((await getPendingWrites(db)).map((r) => r.idempotencyKey)).toEqual(["late-old-row"]);
  });
});

describe("every replay trigger", () => {
  it("runs the clear first and never sends a pre-fix row, but sends a fixed-worker row", async () => {
    await signedIn();
    await seedPreFixRow("old-1");
    await enqueueWrite(db, {
      idempotencyKey: "new-1",
      method: "POST",
      url: `${ORIGIN}/api/jobs/save`,
      headers: {},
      body: "{}",
      queuedAt: new Date().toISOString(),
      warehouseId: "wh-a",
      operatorId: "operator-a",
      stationId: "station-a",
    });
    const fake = install();

    const { event, settled } = lifecycleEvent({ data: { type: "DRAIN_QUEUE" }, ports: [] });
    fake.fire("message", event);
    await settled();

    const sends = sent.filter((s) => s.url === "/api/jobs/save");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).not.toContain("do-not-send");
    expect(await getPendingWrites(db)).toEqual([]);
    expect((await readPreUpdateClear(db))?.rows.map((r) => r.idempotencyKey)).toEqual(["old-1"]);
  });

  it("reports what it cleared to the SETTINGS' audit path, with the worker-held token and no body", async () => {
    await signedIn();
    await seedPreFixRow("old-1");
    const fake = install();

    const { event, settled } = lifecycleEvent({ data: { type: "DRAIN_QUEUE" }, ports: [] });
    fake.fire("message", event);
    await settled();

    const reports = sent.filter((s) => s.url === settings.queueActionPath);
    expect(reports).toHaveLength(1);
    const body = JSON.parse(reports[0]?.body ?? "{}") as Record<string, string>;
    expect(body).toMatchObject({
      queue_action: "discard",
      client_mutation_id: "old-1",
      reason_code: "PRE_UPDATE_CLEARED",
    });
    expect(reports[0]?.body).not.toContain("do-not-send");
    expect((await readPreUpdateClear(db))?.rows[0]?.report.state).toBe("sent");
  });
});
