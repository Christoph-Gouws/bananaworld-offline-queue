// Service-worker protected session-token storage per SEC-AUTH-013.
//
// Anchors: EPIC-001-M007-SCOPE-007, SEC-AUTH-013, SEC-RISK-007, TECH-FE-011,
//          QUALITY-PROHIB-011 (no service-role JWT in client code).
//
// CRITICAL SECURITY INVARIANT — the raw session token NEVER leaves the SW
// boundary. The page can ask "do I have a valid token?" and receive a boolean
// only. The SW injects the token into outbound replay requests via the fetch
// handler; the page's main thread cannot read the token via any API.
//
// At M007 there is no real auth surface — the token-storage CONTRACT is
// established here + the SW message handlers wire it up. EPIC-002-M002 (PIN
// auth) will call STORE_SESSION_TOKEN on login + CLEAR_SESSION_TOKEN on logout
// or auto-logoff. The substantive Security Gate at M007 reviews this contract
// shape + the inaccessibility guarantee.

import type { OfflineQueueDB, SessionTokenRecord } from "./schema";

// ---------------------------------------------------------------------------
// SW-internal storage primitives (NEVER call these from page-side code)
// ---------------------------------------------------------------------------

export interface StoreTokenInput {
  token: string;
  expiresAt: string;
  warehouseId: string;
  stationId: string;
  // CR-DC-068 — the operator this session belongs to, so the replay loop can refuse to send
  // somebody else's queued work under it. NOT a credential: the same id already lives in
  // localStorage via `storeSessionDisplay`, and it grants nothing on its own. The raw `token` above
  // is still the only secret here and still never crosses the SW boundary (SEC-AUTH-013).
  operatorId: string | null;
  // CR-DC-071 — the station's inactivity window, carried so the worker can enforce idle without a
  // network call. Optional so an older caller (and every existing unit fixture) still compiles; a
  // session without it is simply not idle-enforced, and such a session also carries the OLD short
  // absolute expiry, so it self-limits.
  autoLogoffMinutes?: number;
}

/**
 * CR-DC-068 — the SW-internal view of the active station session: the identity triple the replay
 * gate compares against, plus the token it will attach and the expiry that decides whether it may.
 *
 * 🔴 This type must NEVER be handed to page code. It carries the raw token, and SEC-AUTH-013 says
 * the page gets a boolean and nothing else. Its only consumers are the SW's own readToken seams
 * (fetch-handler, replay-loop, message-handlers).
 */
export interface StationSession {
  readonly token: string;
  readonly expiresAt: string;
  readonly warehouseId: string;
  readonly stationId: string;
  readonly operatorId: string | null;
  // CR-DC-071 — the three fields the idle gate and the renewal decision read. `storedAt` is PIN
  // sign-in time (the cap anchor); `lastActivityAt` is the last operator action; `autoLogoffMinutes`
  // is the window both are measured against. All optional for the same reason as on the record: a
  // session written by an older build has none, and every gate below treats that as today's
  // behaviour rather than as a refusal.
  readonly storedAt?: string;
  readonly lastActivityAt?: string;
  readonly autoLogoffMinutes?: number;
}

/**
 * SW-only: persist the session token. Called by the SW message handler when
 * EPIC-002-M002 posts STORE_SESSION_TOKEN on PIN login.
 *
 * The function deliberately accepts only the necessary fields (token, expiry,
 * warehouse + station identity) so a misuse (e.g., storing extra PII alongside)
 * is a compile error rather than a silent leak.
 */
export async function storeSessionToken(
  db: OfflineQueueDB,
  input: StoreTokenInput,
  storedAt: string = new Date().toISOString(),
): Promise<void> {
  const record: SessionTokenRecord = {
    id: "current",
    token: input.token,
    expiresAt: input.expiresAt,
    warehouseId: input.warehouseId,
    stationId: input.stationId,
    operatorId: input.operatorId,
    storedAt,
    // CR-DC-071 — signing in IS an action, so the idle clock starts here rather than at the first
    // keepalive. Without this an operator who taps in and then reads the screen for six minutes on a
    // five-minute station would be idle before they had done anything.
    lastActivityAt: storedAt,
    autoLogoffMinutes: input.autoLogoffMinutes,
  };
  await db.put("session_token", record);
}

/**
 * CR-DC-071 — replace the stored token with a freshly minted one, in place.
 *
 * 🔴 `storedAt` IS PRESERVED, AND THAT ONE LINE IS THE ABSOLUTE CAP. It is PIN sign-in time, which is
 * what the D-2 cap is measured from; rewriting it on renewal would let a session slide forever, which
 * is the exact failure a maximum session lifetime exists to prevent.
 *
 * 🔴 `lastActivityAt` IS ALSO PRESERVED. A renewal is not itself an operator action — it is a
 * consequence of one. Stamping it here would make the worker's own housekeeping look like a person
 * touching the tablet, and the idle gate would then never fire.
 *
 * Returns false when there is nothing to renew (the session was cleared or lapsed between the
 * decision and the fetch — a real race on a tablet that signs out mid-request), so the caller can
 * report honestly instead of resurrecting a session with `put`.
 */
export async function renewStoredSession(
  db: OfflineQueueDB,
  input: { token: string; expiresAt: string },
): Promise<boolean> {
  const existing = await readStoredToken(db);
  if (existing === null) return false;
  await db.put("session_token", {
    ...existing,
    token: input.token,
    expiresAt: input.expiresAt,
  });
  return true;
}

/**
 * CR-DC-071 — record that the operator did something. Called by the SESSION_ACTIVITY handler, which
 * the page's <SessionKeepalive /> posts on the shared `ACTIVITY_EVENTS` list.
 *
 * Returns false when no session is stored, so a keepalive arriving after sign-out cannot recreate one.
 */
export async function recordSessionActivity(
  db: OfflineQueueDB,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  const existing = await readStoredToken(db);
  if (existing === null) return false;
  await db.put("session_token", { ...existing, lastActivityAt: at });
  return true;
}

/**
 * SW-only: read the active station session — the identity triple plus the token and its expiry.
 * This is what the SW's `readToken` seams hand to the fetch handler and the replay loop.
 *
 * Returns null when nothing is stored. Does NOT filter on expiry: the replay gate needs to tell
 * "no session at all" from "a session that has lapsed" only in so far as both are unusable, and the
 * fetch handler still wants the warehouse of a just-expired session for the row it is enqueuing.
 * Callers decide usability with `isSessionTokenExpired`.
 */
export async function readStationSession(db: OfflineQueueDB): Promise<StationSession | null> {
  const record = await readStoredToken(db);
  if (!record) return null;
  return {
    token: record.token,
    expiresAt: record.expiresAt,
    warehouseId: record.warehouseId,
    stationId: record.stationId,
    operatorId: record.operatorId ?? null,
    // CR-DC-071 — carried so the idle gate and the renewal decision read one session object rather
    // than making a second database read of their own.
    storedAt: record.storedAt,
    lastActivityAt: record.lastActivityAt,
    autoLogoffMinutes: record.autoLogoffMinutes,
  };
}

/**
 * SW-only: read the stored token for outbound-request injection. Used by the
 * replay loop's fetch wrapper to add `Authorization: Bearer ${token}`. NEVER
 * exposed to page code — the message handler `HAS_VALID_TOKEN_REQUEST` returns
 * only a boolean, not the token.
 */
export async function readStoredToken(db: OfflineQueueDB): Promise<SessionTokenRecord | null> {
  const record = await db.get("session_token", "current");
  return record ?? null;
}

/**
 * SW-only: clear the stored token on logout / auto-logoff / token expiry.
 */
export async function clearSessionToken(db: OfflineQueueDB): Promise<void> {
  await db.delete("session_token", "current");
}

/**
 * SW-only: validity check for the page-side `HAS_VALID_TOKEN_REQUEST` message.
 * Returns true iff a token is stored and its `expiresAt` is in the future.
 * Returns ONLY a boolean to the page (per the SEC-AUTH-013 inaccessibility
 * guarantee — the token value never leaves the SW boundary).
 */
export async function isStoredTokenValid(
  db: OfflineQueueDB,
  now: Date = new Date(),
): Promise<boolean> {
  const record = await readStoredToken(db);
  if (!record) return false;
  if (isSessionTokenExpired(record.expiresAt, now)) return false;
  // 🔴 CR-DC-071 — AND NOT IDLE. This is the line that stops the offline grace on the token's expiry
  // becoming a way to inherit somebody else's session. `TabletSessionBar` decides "am I signed in?"
  // from this boolean, so a tablet locked mid-shift and picked up hours later by anybody now reports
  // NOT signed in even though the raw token has grace left — instead of re-arming a fresh inactivity
  // timer over a live session and putting the previous operator's name on every audit row. That
  // wrong-attribution harm is what CR-DC-068 spent a whole change closing, and it is the concrete
  // reason the logic plan recommended AGAINST making the client timer the only enforcement (D-1 (c)).
  return !isSessionIdle(record, now);
}

/**
 * THE definition of "this session token has lapsed" — one place, imported, never re-derived.
 *
 * CR-DC-068 lifted it out of `isStoredTokenValid` so the replay gate can apply the SAME rule to the
 * session it already holds, without a second database read. An unparseable expiry counts as expired
 * (fail-closed), exactly as it always did.
 *
 * 🔴 This matters more than it looks. A station token's life is `login + auto_logoff_minutes`, and
 * the floor default is FIVE MINUTES (`mintStationToken`, `db/migrations/20260601000001_…sql`). A
 * write captured at minute 1 and replayed at minute 20 carries a token that expired long ago — so a
 * presence-only check would leave most of the hole open. On the auto-logoff path the token is
 * ALWAYS already expired: the timer fires at `lastActivity + minutes`, the token dies at
 * `login + minutes`, and `lastActivity >= login`.
 */
export function isSessionTokenExpired(expiresAt: string, now: Date): boolean {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() <= now.getTime();
}

/**
 * CR-DC-071 — THE definition of "nothing has happened at this station for longer than its window".
 * One place, imported, never re-derived — the sibling of `isSessionTokenExpired` above and applied
 * at exactly the same seams.
 *
 * 🔴 WHY THIS EXISTS AT ALL. The token now lives `auto_logoff_minutes + OFFLINE_GRACE_MINUTES`,
 * because a renewal is impossible while the tablet is offline and PRD-NFR-005 promises a 10-minute
 * outage is survivable on every station — including the six configured at five minutes. That grace
 * is only defensible because the service worker REFUSES TO USE IT: the raw token never leaves the
 * worker (SEC-AUTH-013), so the worker is the only possible requester, and a refuse-to-attach gate
 * there is a real control rather than a cosmetic one. The grace buys an outage its margin; it does
 * not buy an unattended tablet a longer usable session.
 *
 * ⚠ FAIL-OPEN ON A SESSION THAT CARRIES NEITHER FIELD, AND THAT IS ARGUED, NOT OVERLOOKED. Such a
 * record was written by a build from before this change, which means its token was minted under the
 * OLD rule — `login + auto_logoff_minutes`, no grace — so it already carries a short absolute
 * lifetime and dies on its own. Treating it as idle instead would sign out every operator on a
 * tablet mid-upgrade, for a session that was never at risk.
 *
 * ⚠ AN UNPARSEABLE `lastActivityAt` COUNTS AS IDLE (fail-closed), exactly as an unparseable expiry
 * counts as expired above.
 */
export function isSessionIdle(
  session: Pick<SessionTokenRecord, "lastActivityAt" | "autoLogoffMinutes">,
  now: Date,
): boolean {
  const { lastActivityAt, autoLogoffMinutes } = session;
  if (lastActivityAt === undefined || autoLogoffMinutes === undefined) return false;
  if (autoLogoffMinutes <= 0) return false;
  const last = new Date(lastActivityAt);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() > autoLogoffMinutes * 60 * 1000;
}

// ---------------------------------------------------------------------------
// page-side facade — returns only booleans, never the token
// ---------------------------------------------------------------------------

/**
 * Page-side helper that asks the SW "do I have a valid session token?". Returns
 * `false` if the SW is unavailable (dev mode, no controller yet) so callers
 * fail safe — they treat "no SW = no token" rather than assuming authenticated.
 *
 * The page cannot derive the raw token from this helper or any sibling helper
 * in this file. Per SEC-AUTH-013 there is no `getTokenForPage()` function and
 * there will not be one — that's the whole point.
 */
export async function hasValidSessionToken(): Promise<boolean> {
  // Late-import to avoid a circular dependency on sync-protocol.ts.
  const { askServiceWorker } = await import("./sync-protocol");
  const reply = await askServiceWorker({ type: "HAS_VALID_TOKEN_REQUEST" });
  if (!reply || reply.type !== "HAS_VALID_TOKEN_REPLY") return false;
  return reply.hasValidToken;
}
