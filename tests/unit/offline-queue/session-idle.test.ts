// Unit test — CR-DC-071: `isSessionIdle`, the one definition of "nothing has happened here".
//
// Anchors: CR-DC-071, SEC-AUTH-004 (auto-logoff means INACTIVITY), SEC-AUTH-013 (the page gets a
//          boolean and nothing else), CR-DC-068 (wrong-attribution, the harm this closes again).
//
// 🔴 THE FAILURE MODE THIS FILE GUARDS, AND WHY IT IS NOT HYPOTHETICAL. The logic plan considered
// making the CLIENT timer the whole auto-logoff (option (c)) and recommended against it on a
// concrete case: `useAutoLogoff` arms on mount, so a tablet locked or backgrounded mid-shift and
// picked up three hours later by ANYBODY re-mounts a fresh inactivity timer over a service-worker
// token that is still valid — and that person is then signed in as the previous operator, with their
// name on every audit row. That is precisely the wrong-attribution harm CR-DC-068 spent a change
// closing (D-038, HACCP/GlobalGAP, retention >= 5 years).
//
// `isStoredTokenValid` is what `TabletSessionBar` asks to decide "am I signed in?", so applying the
// idle rule there is what makes the pick-up case answer NO.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSessionIdle,
  isStoredTokenValid,
  openOfflineQueueDB,
  readStationSession,
  readStoredToken,
  recordSessionActivity,
  renewStoredSession,
  storeSessionToken,
  type OfflineQueueDB,
} from "@/lib/offline-queue";
import { withFakeIndexedDB } from "../../helpers/fake-indexeddb";

let db: OfflineQueueDB;

const SIGN_IN = new Date("2026-08-19T06:00:00.000Z");
const at = (minutes: number): Date => new Date(SIGN_IN.getTime() + minutes * 60 * 1000);

withFakeIndexedDB();

beforeEach(async () => {
  db = await openOfflineQueueDB();
});

// ⚠ An open connection blocks the next test's `deleteDatabase`; without this the file times out.
afterEach(() => {
  db.close();
});

async function signIn(autoLogoffMinutes: number | undefined = 5): Promise<void> {
  await storeSessionToken(
    db,
    {
      token: "token-at-sign-in",
      // Window + the 15-minute offline grace.
      expiresAt: at((autoLogoffMinutes ?? 5) + 15).toISOString(),
      warehouseId: "wh-a",
      stationId: "station-a",
      operatorId: "operator-a",
      autoLogoffMinutes,
    },
    SIGN_IN.toISOString(),
  );
}

describe("CR-DC-071 — isSessionIdle", () => {
  it("is false inside the window and true past it, to the minute", () => {
    const session = { lastActivityAt: SIGN_IN.toISOString(), autoLogoffMinutes: 5 };
    expect(isSessionIdle(session, at(4))).toBe(false);
    expect(isSessionIdle(session, at(5))).toBe(false); // exactly at the window is not yet past it
    expect(isSessionIdle(session, at(6))).toBe(true);
  });

  it("⚠ fails OPEN on a session written by an older build, and that is argued", () => {
    // Neither field is present, because the record predates this change. Such a token was minted
    // under the OLD rule (`login + auto_logoff_minutes`, no grace), so it carries its own short
    // absolute lifetime and dies on its own. Treating it as idle would sign out every operator on a
    // tablet mid-upgrade, for a session that was never at risk.
    expect(isSessionIdle({}, at(600))).toBe(false);
    expect(isSessionIdle({ autoLogoffMinutes: 5 }, at(600))).toBe(false);
    expect(isSessionIdle({ lastActivityAt: SIGN_IN.toISOString() }, at(600))).toBe(false);
  });

  it("⚠ fails CLOSED on an unparseable timestamp — the same rule as an unparseable expiry", () => {
    expect(isSessionIdle({ lastActivityAt: "not-a-date", autoLogoffMinutes: 5 }, at(1))).toBe(true);
  });
});

describe("CR-DC-071 — signing in seeds the idle clock", () => {
  it("lastActivityAt starts at sign-in, so reading the screen is not being idle", async () => {
    await signIn(5);
    const record = await readStoredToken(db);
    expect(record?.lastActivityAt).toBe(SIGN_IN.toISOString());
    expect(record?.autoLogoffMinutes).toBe(5);
    // Six minutes of reading the screen on a five-minute station IS idle, and correctly so — but
    // minute four is not, which would be false if the clock had started at the first keepalive
    // instead (the first keepalive can be up to a minute late).
    expect(await isStoredTokenValid(db, at(4))).toBe(true);
  });
});

describe("🔴 CR-DC-071 — 'am I signed in?' says NO for an idle session", () => {
  it("false once idle, even though the token itself is still alive", async () => {
    await signIn(5);
    // Minute 12: the token has 8 minutes of life left (5 + 15 grace = 20), so the EXPIRY alone would
    // still say yes. This is the whole pick-up case.
    const session = await readStationSession(db);
    expect(session).not.toBeNull();
    expect(new Date(session?.expiresAt ?? 0).getTime()).toBeGreaterThan(at(12).getTime());
    expect(await isStoredTokenValid(db, at(12))).toBe(false);

    // Non-vacuity: the SAME token, with a recent action, is still valid — so the `false` above is
    // the idle rule firing and not the expiry, a missing record or a read failure.
    await recordSessionActivity(db, at(11).toISOString());
    expect(await isStoredTokenValid(db, at(12))).toBe(true);
  });

  it("still false when the token has genuinely expired, idle or not", async () => {
    await signIn(5);
    await recordSessionActivity(db, at(19).toISOString());
    expect(await isStoredTokenValid(db, at(21))).toBe(false);
  });
});

describe("CR-DC-071 — renewStoredSession", () => {
  it("moves the expiry and the token, and NOTHING else", async () => {
    await signIn(5);
    await recordSessionActivity(db, at(4).toISOString());
    const before = await readStoredToken(db);

    const ok = await renewStoredSession(db, {
      token: "token-after-renewal",
      expiresAt: at(25).toISOString(),
    });
    expect(ok).toBe(true);

    const after = await readStoredToken(db);
    expect(after?.token).toBe("token-after-renewal");
    expect(after?.expiresAt).toBe(at(25).toISOString());
    // 🔴 `storedAt` is the 16-hour cap anchor and `lastActivityAt` is the idle clock. A renewal that
    // moved either would make the cap decorative or the idle gate unreachable.
    expect(after?.storedAt).toBe(before?.storedAt);
    expect(after?.lastActivityAt).toBe(at(4).toISOString());
    // Everything else byte-identical.
    expect({ ...after, token: null, expiresAt: null }).toEqual({
      ...before,
      token: null,
      expiresAt: null,
    });
  });

  it("refuses to resurrect a session that was cleared mid-flight", async () => {
    expect(await renewStoredSession(db, { token: "t", expiresAt: at(25).toISOString() })).toBe(
      false,
    );
    expect(await readStoredToken(db)).toBeNull();
    expect(await recordSessionActivity(db, at(1).toISOString())).toBe(false);
  });
});
