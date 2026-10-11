// CR-DC-071 — the service worker's half of the sliding session window (logic plan D-1 option (a)).
//
// Anchors: SEC-AUTH-004 (auto-logoff means INACTIVITY), SEC-AUTH-013 (the raw token never leaves the
//          worker), PRD-NFR-005 (10-minute outage survival), API-EP-100 (POST /api/auth/pin/session).
//
// 🔴 WHY THIS IS A MODULE AND NOT FOUR LINES IN `src/sw/index.ts`. Nothing under `tests/**` imports
// the SW entry — it is serwist-compiled to public/sw.js — so anything written there is unprovable,
// which is exactly the shape of claim this estate has been burned by. CR-DC-069 set the precedent by
// moving its DECISION out of the entry; CR-DC-070 followed it with the retention sweep. The entry
// keeps one `if` around one call; the decision and the fetch are both here, both tested.
//
// 🔴 THE TOKEN NEVER CROSSES A BOUNDARY. The worker reads the session from its own protected store,
// fetches with it, and writes the new token straight back to that store. No page `Response` object
// is ever created from the renewal, so there is no header for page code to read (SEC-AUTH-013). The
// page's whole contribution is the payload-free SESSION_ACTIVITY message that got us here.

import type { OfflineQueueDB } from "../schema";
import {
  isSessionIdle,
  isSessionTokenExpired,
  readStationSession,
  renewStoredSession,
  type StationSession,
} from "../token-storage";

// CR-DC-227 — THIS FILE MOVED FROM THE DC (`src/sw/session-renewal.ts`). The decision and the fetch are
// unchanged. The two DC-owned inputs are settings, bound once by `createSessionRenewal`:
//
//   · `renewalPath` — the renewal endpoint. Same-origin; the worker is the only caller.
//   · `renewalThresholdMinutes` — `max(grace, half the token's life)`, the app's session-lifetime rule.
//     🔴 THE DC PASSES ITS OWN LEAF (`src/lib/auth/session-lifetime.ts`), never the `@/lib/auth` barrel:
//     that barrel drags server-only modules (`jose`, `pg`, `process.env`) and reaching it from worker
//     code fails `next build` while typecheck, lint and every test pass. This package imports neither.

export interface SessionRenewalSettings {
  readonly renewalPath: string;
  /** Minutes of remaining token life at or below which an active session asks for a fresh token. */
  readonly renewalThresholdMinutes: (autoLogoffMinutes: number) => number;
}

/**
 * What a renewal attempt did. Every value is reported rather than swallowed, so a unit test can pin
 * WHICH branch ran instead of asserting "it did not throw".
 */
export type SessionRenewalOutcome =
  /** No session stored, or it has lapsed / gone idle — nothing to extend. Re-entry is by PIN. */
  | "no-session"
  /** A session that is fine and still has plenty of life. The common case, and it costs one read. */
  | "not-due"
  /** A fresh token was minted and stored. */
  | "renewed"
  /** The server refused (capped, scoped, deactivated station). The session runs out normally. */
  | "refused"
  /** The fetch threw or the server faulted — almost always "the tablet is offline". Harmless. */
  | "unreachable";

export interface SessionRenewalDeps {
  db: OfflineQueueDB;
  /** Override for tests; defaults to native fetch from the SW context. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * CR-DC-071 — THE renewal decision, pure and total. Should this session ask for a fresh token now?
 *
 * Four gates, in the order that makes each one cheap and each refusal honest:
 *
 *   1. THERE IS A SESSION. Nothing to renew otherwise.
 *   2. IT HAS NOT LAPSED. An expired token cannot renew itself — the server refuses it, and asking
 *      would only spend a request to be told so. Re-entry is by PIN, as it always was.
 *   3. IT IS NOT IDLE. 🔴 This is the security gate, not an optimisation. The token deliberately
 *      outlives the inactivity window by `OFFLINE_GRACE_MINUTES` so a 10-minute outage is survivable
 *      on every station (PRD-NFR-005). Renewing during that grace would convert the grace into an
 *      indefinite session for an unattended tablet — the grace is for an OUTAGE, not for a tablet
 *      nobody is standing at.
 *   4. IT IS PAST THE THRESHOLD. `renewalThresholdMinutes` = `max(grace, half the token's life)`,
 *      so an active session's token never drops below 15 minutes of remaining life (the PRD-NFR-005
 *      margin, on every station by construction) while a 180- or 720-minute station still only
 *      renews at half-life instead of every quarter hour all shift.
 *
 * ⚠ A SESSION WITH NO `autoLogoffMinutes` IS NEVER RENEWED. That is a record written by a build from
 * before this change; its token was minted under the old rule (`login + window`, no grace) and the
 * server would refuse it anyway for want of a signed session-start claim. Failing closed here saves
 * a pointless request and keeps the two layers agreeing.
 */
function shouldRenewImpl(
  settings: SessionRenewalSettings,
  session: StationSession | null,
  now: Date,
): boolean {
  if (session === null) return false;
  if (isSessionTokenExpired(session.expiresAt, now)) return false;
  if (isSessionIdle(session, now)) return false;
  const window = session.autoLogoffMinutes;
  if (window === undefined || window <= 0) return false;

  const remainingMs = new Date(session.expiresAt).getTime() - now.getTime();
  return remainingMs <= settings.renewalThresholdMinutes(window) * 60 * 1000;
}

/**
 * Renew the stored station session if one is due. Safe to call on every SESSION_ACTIVITY message:
 * the common path is a single IndexedDB read that returns `not-due`.
 *
 * 🔴 A FAILURE IS NEVER DESTRUCTIVE. Nothing here clears the session, on any branch. A refusal or an
 * unreachable server leaves the token exactly as it was, so it lives out its remaining life and the
 * operator is signed out by the page timer with the audited `auto_logoff` row intact (SEC-AUTH-007).
 * Clearing it here would strip the identity a queued write is matched against and strand work
 * CR-DC-068 exists to protect.
 */
async function renewSessionIfDueImpl(
  settings: SessionRenewalSettings,
  deps: SessionRenewalDeps,
): Promise<SessionRenewalOutcome> {
  const now = (deps.now ?? defaultNow)();
  const session = await readStationSession(deps.db);
  if (session === null) return "no-session";
  if (!shouldRenewImpl(settings, session, now)) {
    // Tell "there is nothing usable here" from "it is fine and not due yet" — the first is a session
    // that will not come back without a PIN, the second is the ordinary case.
    if (isSessionTokenExpired(session.expiresAt, now) || isSessionIdle(session, now)) {
      return "no-session";
    }
    return "not-due";
  }

  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(settings.renewalPath, {
      method: "POST",
      headers: {
        // The one place this token is used outside the replay/read seams. It is read from the
        // worker's protected store and dies with this request.
        Authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      // 🔴 NO BODY, EVER. The server re-issues from the claims it VERIFIES on the presented token; a
      // body would be a second, client-controlled input to a minting path, which is precisely the
      // thing that makes a non-PIN mint defensible or not (logic plan §3, property 1).
      body: "{}",
      credentials: "include",
    });
  } catch {
    // Offline, or the request was cut off. Expected and harmless — this is what the offline grace on
    // the token's expiry is for.
    return "unreachable";
  }

  if (response.status >= 500) return "unreachable";
  if (!response.ok) return "refused";

  let payload: { access_token?: unknown; expires_at?: unknown };
  try {
    payload = (await response.json()) as { access_token?: unknown; expires_at?: unknown };
  } catch {
    return "unreachable";
  }
  const token = typeof payload.access_token === "string" ? payload.access_token : null;
  const expiresAtSeconds =
    typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at)
      ? payload.expires_at
      : null;
  if (token === null || token.length === 0 || expiresAtSeconds === null) return "unreachable";

  // `renewStoredSession` PRESERVES `storedAt` (the absolute-cap anchor) and `lastActivityAt` (the
  // idle clock). Renewing must move the expiry and nothing else — see its header.
  const stored = await renewStoredSession(deps.db, {
    token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  });
  return stored ? "renewed" : "no-session";
}

export interface SessionRenewal {
  shouldRenew(session: StationSession | null, now: Date): boolean;
  renewSessionIfDue(deps: SessionRenewalDeps): Promise<SessionRenewalOutcome>;
}

export function createSessionRenewal(settings: SessionRenewalSettings): SessionRenewal {
  return {
    shouldRenew: (session, now) => shouldRenewImpl(settings, session, now),
    renewSessionIfDue: (deps) => renewSessionIfDueImpl(settings, deps),
  };
}

function defaultNow(): Date {
  return new Date();
}
