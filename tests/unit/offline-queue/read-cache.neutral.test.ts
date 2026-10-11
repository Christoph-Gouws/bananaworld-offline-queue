// The device-side read cache, bound to a NEUTRAL protected path (CR-DC-227). Which paths are cached is
// the app's; the mechanism — fail-closed identity, the two bounds, the oldest-first prune that holds one
// row back — is the package's.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRIVER_READ_MAX_ENTRIES,
  createReadCache,
  driverReadIdentity,
  readCachedDriverRead,
  clearDriverReads,
} from "../../../src/read-cache";
import type { OfflineQueueDB } from "../../../src/schema";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { openOfflineQueueDB } from "../../support/schema";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

const { cacheDriverRead, pruneDriverReads } = createReadCache(NEUTRAL_SETTINGS);
const identity = { warehouseId: "wh-a", stationId: "station-a", operatorId: "operator-a" };
const HOME = "/api/runs/home";

let db: OfflineQueueDB;
withFakeIndexedDB();
beforeEach(async () => {
  db = await openOfflineQueueDB();
});
afterEach(() => {
  db.close();
});

describe("identity — fail closed", () => {
  it("an incomplete identity neither stores nor serves", async () => {
    expect(driverReadIdentity({ warehouseId: "w", stationId: "s", operatorId: null })).toBeNull();
    await cacheDriverRead(db, null, "/api/runs/stop/1", "{}");
    expect(await db.count("driver_reads")).toBe(0);
    expect(await readCachedDriverRead(db, null, "/api/runs/stop/1")).toBeNull();
  });

  it("a read stored under operator A is a MISS for operator B", async () => {
    await cacheDriverRead(db, identity, "/api/runs/stop/1", '{"a":1}');
    expect((await readCachedDriverRead(db, identity, "/api/runs/stop/1"))?.body).toBe('{"a":1}');
    expect(
      await readCachedDriverRead(db, { ...identity, operatorId: "operator-b" }, "/api/runs/stop/1"),
    ).toBeNull();
  });

  it("sign-out clears the whole store", async () => {
    await cacheDriverRead(db, identity, "/api/runs/stop/1", "{}");
    await clearDriverReads(db);
    expect(await db.count("driver_reads")).toBe(0);
  });
});

describe("the bound, and the row the app's setting holds back", () => {
  it("evicts oldest-first to the entry ceiling but keeps the NEWEST row of the protected path", async () => {
    // The protected row goes in FIRST: insertion (storedAt) order is eviction order, which is exactly
    // the defect the protection exists to prevent.
    await cacheDriverRead(db, identity, HOME, "{}", new Date(2026, 0, 1, 0, 0, 0));
    for (let i = 0; i < DRIVER_READ_MAX_ENTRIES + 5; i += 1) {
      await cacheDriverRead(
        db,
        identity,
        `/api/runs/stop/${i}`,
        "{}",
        new Date(2026, 0, 1, 1, 0, i),
      );
    }
    const rows = await db.getAll("driver_reads");
    expect(rows).toHaveLength(DRIVER_READ_MAX_ENTRIES);
    expect(rows.some((r) => r.path === HOME)).toBe(true);
    // The OLDEST stop went, not the home row.
    expect(rows.some((r) => r.path === "/api/runs/stop/0")).toBe(false);
  });

  it("a DIFFERENT protected path (another app's setting) protects that row instead", async () => {
    const other = createReadCache({ isProtectedReadPath: (p) => p === "/api/jobs/list" });
    await other.cacheDriverRead(
      db,
      identity,
      "/api/jobs/list",
      "{}",
      new Date(2026, 0, 1, 0, 0, 0),
    );
    await other.cacheDriverRead(db, identity, HOME, "{}", new Date(2026, 0, 1, 0, 0, 1));
    expect(await other.pruneDriverReads(db, 1)).toBe(1);
    expect((await db.getAll("driver_reads")).map((r) => r.path)).toEqual(["/api/jobs/list"]);
  });

  it("the byte ceiling bites too", async () => {
    await cacheDriverRead(
      db,
      identity,
      "/api/runs/stop/1",
      "x".repeat(600),
      new Date(2026, 0, 1, 0, 0, 0),
    );
    await cacheDriverRead(
      db,
      identity,
      "/api/runs/stop/2",
      "x".repeat(600),
      new Date(2026, 0, 1, 0, 0, 1),
    );
    expect(await pruneDriverReads(db, 80, 1000)).toBe(1);
  });
});
