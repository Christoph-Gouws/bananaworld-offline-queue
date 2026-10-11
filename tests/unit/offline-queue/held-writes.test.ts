// Unit test — CR-DC-068: which rows are HELD, and the only way one ever leaves the queue.
//
// Anchors: CR-DC-068 (D-2), UX-SCREEN-230, SEC-AUTH-013, D-038 (the record of who lost what).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearHeldWrite,
  enqueueWrite,
  generateIdempotencyKey,
  getHeldWrites,
  getRecentHistory,
  markWriteFailed,
  openOfflineQueueDB,
  storeSessionToken,
  writeBelongsToSession,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { buildSyncSnapshot, handleMessage } from "@/sw/message-handlers";
import {
  withFakeIndexedDB,
  stationSession,
  TEST_SESSION_OPERATOR,
  TEST_SESSION_STATION,
  TEST_SESSION_WAREHOUSE,
} from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const NOW = new Date("2026-08-19T12:00:00.000Z");
const FUTURE = "2099-01-01T00:00:00.000Z";

async function seed(operatorId: string | null, stationId: string | null = TEST_SESSION_STATION) {
  const key = generateIdempotencyKey();
  await enqueueWrite(db, {
    idempotencyKey: key,
    method: "POST",
    url: "https://app.bananaworld-dc.test/api/item-receipt",
    headers: {},
    body: null,
    queuedAt: "2026-08-19T11:00:00.000Z",
    warehouseId: TEST_SESSION_WAREHOUSE,
    operatorId,
    stationId,
  });
  return key;
}

async function signIn(operatorId: string | null, expiresAt = FUTURE) {
  await storeSessionToken(db, {
    token: "station-jwt",
    expiresAt,
    warehouseId: TEST_SESSION_WAREHOUSE,
    stationId: TEST_SESSION_STATION,
    operatorId,
  });
}

describe("writeBelongsToSession — the one definition of 'this write is mine to send'", () => {
  it("matches only on the FULL triple", () => {
    const row = {
      operatorId: TEST_SESSION_OPERATOR,
      stationId: TEST_SESSION_STATION,
      warehouseId: TEST_SESSION_WAREHOUSE,
    };
    expect(writeBelongsToSession(row, stationSession())).toBe(true);
    expect(writeBelongsToSession(row, stationSession({ operatorId: "someone-else" }))).toBe(false);
    expect(writeBelongsToSession(row, stationSession({ stationId: "station-b" }))).toBe(false);
    expect(writeBelongsToSession(row, stationSession({ warehouseId: "wh-zulu" }))).toBe(false);
    expect(writeBelongsToSession(row, null)).toBe(false);
  });

  // 🔴 The trap this closes: null === null is TRUE in JavaScript. If both an identity-less row and
  // an operator-less session compared as null, every legacy row would match every legacy session —
  // the misattribution defect, wearing a different hat.
  it("two unknowns do NOT cancel out into a match", () => {
    const unknownRow = { operatorId: null, stationId: null, warehouseId: TEST_SESSION_WAREHOUSE };
    expect(writeBelongsToSession(unknownRow, stationSession())).toBe(false);
    expect(writeBelongsToSession(unknownRow, stationSession({ operatorId: null }))).toBe(false);
    const knownRow = {
      operatorId: TEST_SESSION_OPERATOR,
      stationId: TEST_SESSION_STATION,
      warehouseId: TEST_SESSION_WAREHOUSE,
    };
    expect(writeBelongsToSession(knownRow, stationSession({ operatorId: null }))).toBe(false);
  });

  // 🔴 THE CASE NAIVE EQUALITY GETS WRONG, and it is REACHABLE — found by mutating the predicate to
  // a plain three-way `===` and watching every other spec in this file stay green.
  //
  // A tablet running the NEW app build against a session stored by the OLD one has a session whose
  // operator is unknown. A write enqueued under it is stamped operatorId: null but takes the REAL
  // station and warehouse off the token. So all three fields line up — null/null, station/station,
  // warehouse/warehouse — and a plain `===` says "yes, send it". The write would then go out under
  // a token belonging to a person nobody recorded, and be audit-logged as their work. That is the
  // misattribution defect surviving the fix that was supposed to remove it.
  //
  // Only the fail-closed guards stop it: an UNKNOWN operator can never match, not even another
  // unknown one.
  it("an operator-less session cannot claim a row whose station and warehouse DO match", () => {
    const rowFromAnOperatorlessSession = {
      operatorId: null, // stamped null because the stored session carried no operator
      stationId: TEST_SESSION_STATION, // but the station and warehouse came off the token
      warehouseId: TEST_SESSION_WAREHOUSE,
    };
    expect(
      writeBelongsToSession(rowFromAnOperatorlessSession, stationSession({ operatorId: null })),
    ).toBe(false);
    // Same shape with `undefined` rather than `null`, which is how an older stored record reads back.
    expect(
      writeBelongsToSession(
        rowFromAnOperatorlessSession,
        stationSession({ operatorId: undefined }),
      ),
    ).toBe(false);
  });
});

describe("CR-DC-068 — getHeldWrites + the sync snapshot", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  // AC-12, the queue half. What performLogoff does to the SW side is exactly one thing: clear the
  // token. It has never touched the queue, and it still does not. What DESTROYED those rows was the
  // replay that followed — sending them with no Authorization header and dead-lettering the 401.
  it("AC-12: clearing the session token leaves every queued row exactly where it was", async () => {
    const key = await seed(TEST_SESSION_OPERATOR);
    await signIn(TEST_SESSION_OPERATOR);

    const { clearSessionToken, getPendingWrites } = await import("@/lib/offline-queue");
    await clearSessionToken(db);

    const rows = await getPendingWrites(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotencyKey).toBe(key);
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.attemptCount).toBe(0);
    expect(rows[0]?.operatorId).toBe(TEST_SESSION_OPERATOR);
    // And they are now HELD — visible, safe, and waiting for that operator to come back.
    expect(await getHeldWrites(db, null)).toHaveLength(1);
  });

  it("with NOBODY signed in, every waiting write is held — this is the auto-logoff screen", async () => {
    await seed(TEST_SESSION_OPERATOR);
    await seed("operator-b");
    expect(await getHeldWrites(db, null)).toHaveLength(2);
  });

  it("signing back in releases YOUR rows and leaves the other operator's held", async () => {
    const mine = await seed(TEST_SESSION_OPERATOR);
    const theirs = await seed("operator-b");

    const held = await getHeldWrites(db, stationSession());
    expect(held.map((w) => w.idempotencyKey)).toEqual([theirs]);
    expect(held.map((w) => w.idempotencyKey)).not.toContain(mine);
  });

  it("a FAILED row is not held — it has its own section and its own two actions", async () => {
    const key = await seed("operator-b");
    await markWriteFailed(db, key, "SERVER_MASTER_WINS", "x");
    expect(await getHeldWrites(db, stationSession())).toHaveLength(0);
  });

  it("the snapshot's heldWrites is a SUBSET of pendingWrites, computed against the stored session", async () => {
    await seed(TEST_SESSION_OPERATOR);
    const theirs = await seed("operator-b");
    await signIn(TEST_SESSION_OPERATOR);

    const snap = await buildSyncSnapshot({ db, isOnline: () => true, now: () => NOW });
    expect(snap.pendingWrites).toHaveLength(2);
    expect(snap.heldWrites.map((w) => w.idempotencyKey)).toEqual([theirs]);
    for (const h of snap.heldWrites) {
      expect(snap.pendingWrites.some((p) => p.idempotencyKey === h.idempotencyKey)).toBe(true);
    }
  });

  // A lapsed token claims nothing. On the auto-logoff path the token is ALWAYS already expired.
  it("an EXPIRED session holds everything, exactly as no session would", async () => {
    await seed(TEST_SESSION_OPERATOR);
    await signIn(TEST_SESSION_OPERATOR, "2026-08-19T11:59:59.000Z");

    const snap = await buildSyncSnapshot({ db, isOnline: () => true, now: () => NOW });
    expect(snap.heldWrites).toHaveLength(1);
  });

  // SEC-AUTH-013 — the snapshot reaches page code, so it must carry no token.
  it("the snapshot carries the operator id but NEVER the session token", async () => {
    await seed("operator-b");
    await signIn(TEST_SESSION_OPERATOR);

    const reply = await handleMessage(
      { type: "SYNC_STATUS_REQUEST" },
      { db, isOnline: () => true, now: () => NOW },
    );
    expect(reply.type).toBe("SYNC_STATUS_REPLY");
    const serialised = JSON.stringify(reply);
    expect(serialised).not.toContain("station-jwt");
    expect(serialised).toContain("operator-b"); // a UUID, not a name — the row's captured-by id
  });
});

describe("CR-DC-068 — clearing a held write is the ONLY way one leaves other than being sent", () => {
  withFakeIndexedDB();
  beforeEach(async () => {
    db = await openOfflineQueueDB();
  });
  afterEach(() => db.close());

  it("clears a held row and records the reason AND who captured it", async () => {
    const key = await seed("operator-b");

    const ok = await clearHeldWrite(
      db,
      key,
      "HELD_OPERATOR_GONE",
      null,
      stationSession(),
      "2026-08-19T12:00:00.000Z",
    );
    expect(ok).toBe(true);
    expect(await getHeldWrites(db, stationSession())).toHaveLength(0);

    const history = await getRecentHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe("discarded");
    expect(history[0]?.discardReasonCode).toBe("HELD_OPERATOR_GONE");
    // 🔴 The history must say who lost what, or clearing someone else's work leaves no trace of
    // whose work it was (D-038 — the record is the point).
    expect(history[0]?.discardReasonText).toContain("operator-b");
  });

  it("keeps the typed reason verbatim alongside the captured-by id", async () => {
    const key = await seed("operator-b");
    await clearHeldWrite(db, key, "OTHER", "  Re-captured on the paper sheet  ", stationSession());
    const history = await getRecentHistory(db);
    expect(history[0]?.discardReasonText).toContain("Re-captured on the paper sheet");
    expect(history[0]?.discardReasonText).toContain("operator-b");
  });

  it("says 'identity unknown' for a version-1 row rather than inventing an operator", async () => {
    const key = await seed(null, null);
    await clearHeldWrite(db, key, "HELD_RE_ENTERED", null, stationSession());
    const history = await getRecentHistory(db);
    expect(history[0]?.discardReasonText).toContain("identity unknown");
  });

  // 🔴 THE GUARD. Clearing must never be able to delete the current operator's OWN waiting work —
  // that would turn a safety feature into a second way to lose data.
  it("REFUSES a row that belongs to the session asking", async () => {
    const mine = await seed(TEST_SESSION_OPERATOR);
    const ok = await clearHeldWrite(db, mine, "HELD_RE_ENTERED", null, stationSession());
    expect(ok).toBe(false);
    expect(await getRecentHistory(db)).toHaveLength(0);
  });

  it("REFUSES a failed row — those go through the discard path with its own reasons", async () => {
    const key = await seed("operator-b");
    await markWriteFailed(db, key, "SERVER_MASTER_WINS", "x");
    expect(await clearHeldWrite(db, key, "HELD_RE_ENTERED", null, stationSession())).toBe(false);
  });

  it("CLEAR_HELD_WRITE reports 'refused' for your own row and 'not_found' for one that is gone", async () => {
    const mine = await seed(TEST_SESSION_OPERATOR);
    await signIn(TEST_SESSION_OPERATOR);

    const refused = await handleMessage(
      {
        type: "CLEAR_HELD_WRITE",
        idempotencyKey: mine,
        discardReasonCode: "HELD_RE_ENTERED",
        discardReasonText: null,
      },
      { db, isOnline: () => true, now: () => NOW },
    );
    expect(refused.type).toBe("CLEAR_HELD_REPLY");
    if (refused.type === "CLEAR_HELD_REPLY") expect(refused.outcome).toBe("refused");

    const missing = await handleMessage(
      {
        type: "CLEAR_HELD_WRITE",
        idempotencyKey: "no-such-key",
        discardReasonCode: "HELD_RE_ENTERED",
        discardReasonText: null,
      },
      { db, isOnline: () => true, now: () => NOW },
    );
    if (missing.type === "CLEAR_HELD_REPLY") expect(missing.outcome).toBe("not_found");
  });

  it("CLEAR_HELD_WRITE clears another operator's row through the message protocol", async () => {
    const theirs = await seed("operator-b");
    await signIn(TEST_SESSION_OPERATOR);

    const reply = await handleMessage(
      {
        type: "CLEAR_HELD_WRITE",
        idempotencyKey: theirs,
        discardReasonCode: "HELD_OPERATOR_GONE",
        discardReasonText: null,
      },
      { db, isOnline: () => true, now: () => NOW },
    );
    if (reply.type === "CLEAR_HELD_REPLY") expect(reply.outcome).toBe("cleared");
    const snap = await buildSyncSnapshot({ db, isOnline: () => true, now: () => NOW });
    expect(snap.heldWrites).toHaveLength(0);
  });

  // The protocol has no message that sends a held write under the current session. If one is ever
  // added, this assertion is where it will be noticed.
  it("there is NO message type that sends a held write under somebody else's session", () => {
    const requestTypes = [
      "SYNC_STATUS_REQUEST",
      "RETRY_ALL",
      "RETRY_WRITE",
      "DISCARD_WRITE",
      "CLEAR_HELD_WRITE",
      "STORE_SESSION_TOKEN",
      "CLEAR_SESSION_TOKEN",
      "HAS_VALID_TOKEN_REQUEST",
      // CR-DC-069 — a payload-free "replay now". It names no row and carries no identity, so it can
      // no more send a held write than the Background Sync event can; the gate in the replay loop
      // refuses it either way (tests/unit/sw/replay-session-gate.test.ts T-10/T-11).
      "DRAIN_QUEUE",
    ];
    expect(requestTypes.filter((t) => /SEND|ADOPT|CLAIM|REASSIGN/i.test(t))).toEqual([]);
    // 🔴 This regex is weak on its own — it reads a hand-maintained list, and a hand-maintained list
    // is only ever as honest as the last person to edit it. The behavioural fence is T-10; this
    // stays because it is the thing a reviewer's eye lands on when a new message type is proposed.
    expect(requestTypes).toHaveLength(9);
  });
});
