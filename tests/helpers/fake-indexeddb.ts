// Test helper — wraps every offline-queue unit test in a fake IndexedDB.
//
// Anchors: EPIC-001-M007 (TECH-COMP-006), M007-SCOPE-013, QA-AUTO-031, QA-EVID-002.
//
// `fake-indexeddb` provides a Node-compatible in-memory IndexedDB. Each test
// gets a fresh in-memory IDB by registering a `beforeEach` hook that wipes
// state. Production code is unchanged — it sees the real `indexedDB` global on
// the browser side; this helper only affects vitest (happy-dom) test execution.

import "fake-indexeddb/auto";
import { afterEach, beforeEach } from "vitest";
import { openOfflineQueueDB } from "@/lib/offline-queue/schema";
import { DB_NAME } from "@/lib/offline-queue/schema";
import type { StationSession } from "@/lib/offline-queue";

/**
 * Call from a `describe()` block. Installs `beforeEach` + `afterEach` hooks that
 * wipe the in-memory IndexedDB between tests so cross-test state does not leak.
 *
 * Usage:
 *   describe("queue.enqueueWrite", () => {
 *     withFakeIndexedDB();
 *     it("queues a POST", async () => { ... });
 *   });
 */
export function withFakeIndexedDB(): void {
  beforeEach(async () => {
    // Wipe the DB before every test. Use deleteDatabase to clear all state
    // (no partial-reset path needed because we don't seed across tests).
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // another connection still open; idempotent
    });
  });

  afterEach(async () => {
    // Close any lingering connection so the next beforeEach can deleteDatabase
    // without the blocked path.
    const db = await openOfflineQueueDB();
    db.close();
  });
}

/**
 * CR-DC-068 — the default station session a test replays under. One definition, so every suite
 * agrees on what "the same operator, at the same station, for the same depot" means and a test
 * cannot accidentally prove a match against a different spelling of the identity.
 *
 * `expiresAt` is far future by default: almost every suite cares about identity, not expiry, and a
 * fixture that quietly lapses would redden suites for the wrong reason. The ones that DO test expiry
 * override it explicitly, which also makes those tests read as being about expiry.
 */
export const TEST_SESSION_OPERATOR = "operator-a";
export const TEST_SESSION_STATION = "station-a";
export const TEST_SESSION_WAREHOUSE = "wh-a";

export function stationSession(overrides: Partial<StationSession> = {}): StationSession {
  return {
    token: "test-station-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    stationId: TEST_SESSION_STATION,
    operatorId: TEST_SESSION_OPERATOR,
    ...overrides,
  };
}
