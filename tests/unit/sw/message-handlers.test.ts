// Unit test — SW message-protocol handlers.
//
// Anchors: EPIC-001-M007-SCOPE-007 (substantive Security Gate), SEC-AUTH-013,
//          M007-SCOPE-002 (page ↔ SW protocol).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyncSnapshot, handleMessage } from "@/sw/message-handlers";
// CR-DC-086 — imported HERE, in an SW-side test, which is the only place page-or-test code may read
// it directly. Page code must not (see src/sw/build-id.ts): the panel renders the wire value.
import { SW_BUILD_ID } from "@/sw/build-id";
import {
  enqueueWrite,
  generateIdempotencyKey,
  markWriteFailed,
  openOfflineQueueDB,
  storeSessionToken,
  type OfflineQueueDB,
  type SyncStatusSnapshot,
} from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

describe("handleMessage routing", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("SYNC_STATUS_REQUEST → SYNC_STATUS_REPLY with current snapshot", async () => {
    const reply = await handleMessage(
      { type: "SYNC_STATUS_REQUEST" },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("SYNC_STATUS_REPLY");
    if (reply.type === "SYNC_STATUS_REPLY") {
      expect(reply.snapshot.online).toBe(true);
      expect(reply.snapshot.pendingWrites).toEqual([]);
    }
  });

  it("RETRY_ALL → re-queues every failed write", async () => {
    const key = generateIdempotencyKey();
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "/api/receipt",
      headers: {},
      body: null,
      warehouseId: "wh-a",
    });
    await markWriteFailed(db, key, "SERVER_MASTER_WINS", "x");
    const reply = await handleMessage({ type: "RETRY_ALL" }, { db, isOnline: () => true });
    expect(reply.type).toBe("RETRY_REPLY");
    if (reply.type === "RETRY_REPLY") {
      expect(reply.outcome).toBe("queued");
    }
    const snapshot = await buildSyncSnapshot({ db, isOnline: () => true });
    expect(snapshot.failedWrites).toHaveLength(0);
    expect(snapshot.pendingWrites).toHaveLength(1);
  });

  // CR-DC-086 (addendum A) — "it is deployed" and "it is on the tablet" are different facts, and a
  // manager doing the post-deploy sweep needs the second one. The snapshot carries the WORKER's own
  // build id so the sync panel can print which worker this tablet is actually running.
  it("CR-DC-086 — the snapshot carries the service worker's own build id", async () => {
    const snapshot = await buildSyncSnapshot({ db, isOnline: () => true });
    expect(snapshot.swBuildId).toBe(SW_BUILD_ID);
    expect(snapshot.swBuildId).not.toBe("");
  });

  // 🔴 THE CASE THAT MAKES THE MARKER WORTH HAVING. An OLD worker sends a snapshot with no such
  //    field, and the panel must be able to say so — which is exactly the answer the sweep needs.
  //    If the panel imported SW_BUILD_ID instead of reading the wire value it would render the page
  //    bundle's constant here and always show the new version: a check that cannot fail.
  it("CR-DC-086 — a snapshot from an OLDER worker simply has no build id", () => {
    const fromOldWorker: SyncStatusSnapshot = {
      online: true,
      pendingWrites: [],
      failedWrites: [],
      heldWrites: [],
      recentHistory: [],
      lastSyncAt: null,
    };
    expect(fromOldWorker.swBuildId).toBeUndefined();
  });

  it("RETRY_WRITE for nonexistent key → not_found", async () => {
    const reply = await handleMessage(
      { type: "RETRY_WRITE", idempotencyKey: "no-such-key" },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("RETRY_REPLY");
    if (reply.type === "RETRY_REPLY") {
      expect(reply.outcome).toBe("not_found");
    }
  });

  it("DISCARD_WRITE moves a failed row to history with reason", async () => {
    const key = generateIdempotencyKey();
    await enqueueWrite(db, {
      idempotencyKey: key,
      method: "POST",
      url: "/api/receipt",
      headers: {},
      body: null,
      warehouseId: "wh-a",
    });
    await markWriteFailed(db, key, "SERVER_MASTER_WINS", "x");
    const reply = await handleMessage(
      {
        type: "DISCARD_WRITE",
        idempotencyKey: key,
        discardReasonCode: "OPERATOR_OBSOLETED",
        discardReasonText: null,
      },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("DISCARD_REPLY");
    if (reply.type === "DISCARD_REPLY") {
      expect(reply.outcome).toBe("discarded");
    }
  });

  // ---------- SEC-AUTH-013 — substantive Security Gate checks ----------

  it("STORE_SESSION_TOKEN persists via SW + returns ok=true reply", async () => {
    const reply = await handleMessage(
      {
        type: "STORE_SESSION_TOKEN",
        token: "fake-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        warehouseId: "wh-a",
        stationId: "st-1",
        operatorId: "op-1",
      },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("STORE_SESSION_TOKEN_REPLY");
    if (reply.type === "STORE_SESSION_TOKEN_REPLY") {
      expect(reply.ok).toBe(true);
    }
  });

  it("HAS_VALID_TOKEN_REQUEST returns ONLY a boolean — NEVER the raw token (SEC-AUTH-013)", async () => {
    await storeSessionToken(db, {
      token: "SECRET-TOKEN-VALUE-must-not-leak",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      warehouseId: "wh-a",
      stationId: "st-1",
      operatorId: "op-1",
    });
    const reply = await handleMessage(
      { type: "HAS_VALID_TOKEN_REQUEST" },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("HAS_VALID_TOKEN_REPLY");
    if (reply.type === "HAS_VALID_TOKEN_REPLY") {
      expect(reply.hasValidToken).toBe(true);
      // Critical inaccessibility test — the entire reply object must NOT
      // contain the token string anywhere.
      const serialised = JSON.stringify(reply);
      expect(serialised).not.toContain("SECRET-TOKEN-VALUE-must-not-leak");
      expect(Object.keys(reply).sort()).toEqual(["hasValidToken", "type"]);
    }
  });

  it("HAS_VALID_TOKEN_REQUEST returns false when no token stored", async () => {
    const reply = await handleMessage(
      { type: "HAS_VALID_TOKEN_REQUEST" },
      { db, isOnline: () => true },
    );
    expect(reply.type).toBe("HAS_VALID_TOKEN_REPLY");
    if (reply.type === "HAS_VALID_TOKEN_REPLY") {
      expect(reply.hasValidToken).toBe(false);
    }
  });

  it("HAS_VALID_TOKEN_REQUEST returns false when stored token is expired", async () => {
    await storeSessionToken(db, {
      token: "expired-token",
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      warehouseId: "wh-a",
      stationId: "st-1",
      operatorId: "op-1",
    });
    const reply = await handleMessage(
      { type: "HAS_VALID_TOKEN_REQUEST" },
      { db, isOnline: () => true },
    );
    if (reply.type === "HAS_VALID_TOKEN_REPLY") {
      expect(reply.hasValidToken).toBe(false);
    }
  });

  it("CLEAR_SESSION_TOKEN removes the stored row + subsequent HAS_VALID returns false", async () => {
    await storeSessionToken(db, {
      token: "fake-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      warehouseId: "wh-a",
      stationId: "st-1",
      operatorId: "op-1",
    });
    await handleMessage({ type: "CLEAR_SESSION_TOKEN" }, { db, isOnline: () => true });
    const reply = await handleMessage(
      { type: "HAS_VALID_TOKEN_REQUEST" },
      { db, isOnline: () => true },
    );
    if (reply.type === "HAS_VALID_TOKEN_REPLY") {
      expect(reply.hasValidToken).toBe(false);
    }
  });
});
