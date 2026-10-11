// Unit test — SW protected session-token storage (SEC-AUTH-013).
//
// Anchors: EPIC-001-M007-SCOPE-007, SEC-AUTH-013, SEC-RISK-007, TECH-FE-011,
//          M007 substantive Security Gate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionToken,
  isStoredTokenValid,
  openOfflineQueueDB,
  readStoredToken,
  storeSessionToken,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const fakeInput = {
  token: "fake-bearer-token-for-tests",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  warehouseId: "wh-a",
  stationId: "st-1",
  operatorId: "op-1",
};

describe("token-storage (SEC-AUTH-013 contract — substantive Security Gate)", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("storeSessionToken persists the singleton 'current' row", async () => {
    await storeSessionToken(db, fakeInput, "2026-05-28T10:00:00.000Z");
    const stored = await readStoredToken(db);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe("current");
    expect(stored?.warehouseId).toBe("wh-a");
    expect(stored?.stationId).toBe("st-1");
    expect(stored?.storedAt).toBe("2026-05-28T10:00:00.000Z");
  });

  it("storeSessionToken overwrites a previous token (singleton store)", async () => {
    await storeSessionToken(db, fakeInput);
    await storeSessionToken(db, { ...fakeInput, warehouseId: "wh-b", token: "token-2" });
    const stored = await readStoredToken(db);
    expect(stored?.token).toBe("token-2");
    expect(stored?.warehouseId).toBe("wh-b");
  });

  it("clearSessionToken removes the singleton row", async () => {
    await storeSessionToken(db, fakeInput);
    await clearSessionToken(db);
    expect(await readStoredToken(db)).toBeNull();
  });

  it("isStoredTokenValid returns true when token exists + not expired", async () => {
    await storeSessionToken(db, fakeInput);
    expect(await isStoredTokenValid(db)).toBe(true);
  });

  it("isStoredTokenValid returns false when no token stored", async () => {
    expect(await isStoredTokenValid(db)).toBe(false);
  });

  it("isStoredTokenValid returns false when token is expired", async () => {
    const expired = {
      ...fakeInput,
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    await storeSessionToken(db, expired);
    expect(await isStoredTokenValid(db)).toBe(false);
  });

  it("readStoredToken returns the same shape that the SW injects into outbound replays", async () => {
    await storeSessionToken(db, fakeInput);
    const stored = await readStoredToken(db);
    // The SW injector reads .token + .warehouseId; these must be present on the
    // record shape. If either is missing the contract is broken — the inject
    // path in fetch-handler.ts + replay-loop.ts depends on these fields.
    expect(stored?.token).toBeTypeOf("string");
    expect(stored?.warehouseId).toBeTypeOf("string");
  });
});
