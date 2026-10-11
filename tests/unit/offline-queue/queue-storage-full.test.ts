// Unit test — CR-DC-070: the device is out of room, and the queue says so honestly.
//
// Anchors: CR-DC-070 (D-2, §3.1), PRD-NFR-005 (zero data loss), UX-PRINCIPLE-015 (the optimistic-UI
//          contract this deliberately breaks), TECH-COMP-006, API-PRINCIPLE-008.
//
// 🔴 THE NEGATIVE CASE IS AS LOAD-BEARING AS THE POSITIVE ONE. A `ConstraintError` from the unique
// `by_idempotency_key` index is a QUEUE BUG — the same write entered the queue twice. If the quota
// classifier swallowed it as "this tablet is full", a real defect would be permanently hidden behind
// a housekeeping message that told the operator to go and find signal. The last two tests use the
// REAL index to produce that error rather than a hand-made one, so they cannot drift from what
// IndexedDB actually throws.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  QueueStorageFullError,
  enqueueWrite,
  isQuotaError,
  openOfflineQueueDB,
  type EnqueueInput,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import {
  withFakeIndexedDB,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    idempotencyKey: "key-1",
    method: "POST",
    url: "https://app.bananaworld-dc.test/api/item-receipt",
    headers: {},
    body: JSON.stringify({ pallet: 1 }),
    queuedAt: "2026-08-19T11:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId: TEST_SESSION_OPERATOR,
    stationId: TEST_SESSION_STATION,
    ...overrides,
  };
}

/** A DB whose `add` refuses with `reason`. Everything else is the real thing. */
function dbThatRefusesAdd(reason: unknown): OfflineQueueDB {
  return { add: () => Promise.reject(reason) } as unknown as OfflineQueueDB;
}

function domError(name: string, code?: number): Error {
  const err = new Error(`simulated ${name}`);
  err.name = name;
  if (code !== undefined) Object.defineProperty(err, "code", { value: code });
  return err;
}

describe("CR-DC-070 — isQuotaError", () => {
  it("recognises the standard Chromium / WebKit name", () => {
    expect(isQuotaError(domError("QuotaExceededError"))).toBe(true);
  });

  it("recognises Firefox's name for the same condition", () => {
    expect(isQuotaError(domError("NS_ERROR_DOM_QUOTA_REACHED"))).toBe(true);
  });

  it("recognises the legacy numeric DOMException code 22", () => {
    expect(isQuotaError(domError("SomeOldName", 22))).toBe(true);
  });

  // 🔴 The fence. Every one of these must stay false.
  it("does NOT classify a ConstraintError, an AbortError, or anything else as a full device", () => {
    expect(isQuotaError(domError("ConstraintError"))).toBe(false);
    expect(isQuotaError(domError("AbortError"))).toBe(false);
    expect(isQuotaError(domError("InvalidStateError"))).toBe(false);
    expect(isQuotaError(domError("DataError", 0))).toBe(false);
    expect(isQuotaError(new Error("plain"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError("QuotaExceededError")).toBe(false); // a string is not a rejection
  });
});

describe("CR-DC-070 — enqueueWrite when the device is full", () => {
  withFakeIndexedDB();

  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("throws QueueStorageFullError carrying the idempotency key when IndexedDB refuses on quota", async () => {
    const full = dbThatRefusesAdd(domError("QuotaExceededError"));
    await expect(enqueueWrite(full, input({ idempotencyKey: "key-abc" }))).rejects.toBeInstanceOf(
      QueueStorageFullError,
    );
    // The key travels with it so the broadcast can name the write that was refused.
    await enqueueWrite(full, input({ idempotencyKey: "key-abc" })).catch((err: unknown) => {
      expect(err).toBeInstanceOf(QueueStorageFullError);
      expect((err as QueueStorageFullError).idempotencyKey).toBe("key-abc");
      // The original rejection is preserved, so a diagnostic never loses the engine's own words.
      expect((err as QueueStorageFullError).cause).toBeDefined();
    });
  });

  it("translates Firefox's quota name too", async () => {
    const full = dbThatRefusesAdd(domError("NS_ERROR_DOM_QUOTA_REACHED"));
    await expect(enqueueWrite(full, input())).rejects.toBeInstanceOf(QueueStorageFullError);
  });

  // 🔴 The one that must never be relaxed.
  it("re-throws a REAL duplicate-key ConstraintError unchanged — a queue bug is not a full device", async () => {
    await enqueueWrite(db, input({ idempotencyKey: "duplicate-key" }));

    let caught: unknown;
    try {
      // The same key again. The unique `by_idempotency_key` index refuses it — this is the genuine
      // IndexedDB error, not a hand-rolled stand-in for one.
      await enqueueWrite(
        db,
        input({ idempotencyKey: "duplicate-key", url: "https://x.test/api/y" }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(QueueStorageFullError);
    expect((caught as Error).name).toBe("ConstraintError");
    // And the first write is still there, untouched.
    const rows = await db.getAll("pending_writes");
    expect(rows.length).toBe(1);
  });

  it("stores the write normally when there is room — the happy path is unchanged", async () => {
    const row = await enqueueWrite(db, input({ idempotencyKey: "fine" }));
    expect(row.id).toBeGreaterThan(0);
    expect(row.status).toBe("queued");
    expect((await db.getAll("pending_writes")).length).toBe(1);
  });
});
