// Service-worker message-protocol handlers (page ↔ SW).
//
// Anchors: EPIC-001-M007-SCOPE-007 (SEC-AUTH-013 token storage contract),
//          M007-SCOPE-002 (page ↔ SW protocol), SEC-RISK-007 (malicious-app
//          mitigation via SW-boundary isolation).
//
// Routes the typed SyncRequest messages from the page to the appropriate
// queue / token-storage primitive. CRITICAL: no handler EVER returns the raw
// session token to the page. The `HAS_VALID_TOKEN_REQUEST` handler returns
// `{ hasValidToken: boolean }` only.

import {
  clearHeldWrite,
  discardFailedWrite,
  getFailedWrites,
  getHeldWrites,
  getPendingWrites,
  getRecentHistory,
  retryFailedWrite,
  writeBelongsToSession,
} from "../queue";
import { clearDriverReads } from "../read-cache";
import type { OfflineQueueDB } from "../schema";
import type { SyncReply, SyncRequest, SyncStatusSnapshot } from "../sync-protocol";
import {
  clearSessionToken,
  isSessionIdle,
  isSessionTokenExpired,
  isStoredTokenValid,
  readStationSession,
  recordSessionActivity,
  storeSessionToken,
  type StationSession,
} from "../token-storage";

// CR-DC-227 — THIS FILE MOVED FROM THE DC (`src/sw/message-handlers.ts`). CR-DC-086's worker version
// marker, put on every snapshot below, is the one DC-owned input: it is the setting `buildId`, bound
// once by `createMessageHandlers`. Page code never imports it; the DC keeps it in `src/sw/build-id.ts`
// and the panel reads the value off the wire, which is the entire point of that constant.
export interface MessageHandlerSettings {
  readonly buildId: string;
}

export interface MessageHandlerDeps {
  db: OfflineQueueDB;
  /** Page ↔ SW message handlers run online detection against this. */
  isOnline: () => boolean;
  now?: () => Date;
}

/**
 * Compute the SYNC_STATUS_REPLY snapshot from current queue state. Surfaced to
 * the page over either a one-shot reply (in response to SYNC_STATUS_REQUEST)
 * or a SYNC_STATE_CHANGED broadcast (after a replay batch completes).
 */
async function buildSyncSnapshotImpl(
  settings: MessageHandlerSettings,
  deps: MessageHandlerDeps,
): Promise<SyncStatusSnapshot> {
  const pending = await getPendingWrites(deps.db);
  const failed = await getFailedWrites(deps.db);
  const history = await getRecentHistory(deps.db);
  // CR-DC-068 — held rows are computed against the session stored RIGHT NOW, which is why the
  // snapshot is rebuilt on every request and every replay broadcast rather than cached. Signing in
  // is what moves a row out of Held; signing out is what moves rows into it.
  const held = await getHeldWrites(deps.db, await usableSession(deps));
  // Last successful sync = most-recent sync_history entry with outcome=synced.
  const lastSynced = history.find((row) => row.outcome === "synced");
  return {
    online: deps.isOnline(),
    pendingWrites: pending,
    failedWrites: failed,
    heldWrites: held,
    recentHistory: history,
    lastSyncAt: lastSynced?.finalisedAt ?? null,
    // CR-DC-086 — sent by THIS worker, so what the panel shows is what the tablet is actually
    // running. An older worker has no such field and the panel says so.
    swBuildId: settings.buildId,
  };
}

/**
 * CR-DC-068 — the stored session, but only if it could actually carry a write right now. A lapsed
 * token claims nothing: its rows are held exactly as they would be with nobody signed in at all.
 *
 * 🔴 SW-INTERNAL. The StationSession this returns carries the raw token, so it must never be put
 * into a reply. Only `writeBelongsToSession` / `getHeldWrites` consume it, and both read identity.
 */
async function usableSession(deps: MessageHandlerDeps): Promise<StationSession | null> {
  const session = await readStationSession(deps.db);
  if (session === null) return null;
  const now = (deps.now ?? defaultNow)();
  if (isSessionTokenExpired(session.expiresAt, now)) return null;
  // CR-DC-071 — an IDLE session claims nothing either, for the same reason a lapsed one does not: the
  // replay gate will refuse to send under it (`checkSessionSkip`), so the snapshot must show those
  // rows as Held rather than as "waiting to sync". 🔴 The two must agree — a panel that says a row is
  // about to send while the loop refuses to send it is the operator-facing lie AC-10 exists to prevent.
  return isSessionIdle(session, now) ? null : session;
}

/**
 * Route a SyncRequest to its handler + produce a typed SyncReply. The SW entry
 * (src/sw/index.ts) wraps this in the SW message-event lifecycle. Errors are
 * caught and returned as { type: "ERROR" } replies so the page never sees a
 * rejected Promise (which would hang the askServiceWorker timeout).
 */
async function handleMessageImpl(
  settings: MessageHandlerSettings,
  request: SyncRequest,
  deps: MessageHandlerDeps,
): Promise<SyncReply> {
  try {
    switch (request.type) {
      case "SYNC_STATUS_REQUEST": {
        const snapshot = await buildSyncSnapshotImpl(settings, deps);
        return { type: "SYNC_STATUS_REPLY", snapshot };
      }

      case "RETRY_ALL": {
        const failed = await getFailedWrites(deps.db);
        for (const row of failed) {
          await retryFailedWrite(deps.db, row.idempotencyKey);
        }
        // Caller follows up with SYNC_STATUS_REQUEST for the fresh snapshot.
        return {
          type: "RETRY_REPLY",
          idempotencyKey: "ALL",
          outcome: failed.length > 0 ? "queued" : "not_found",
        };
      }

      case "RETRY_WRITE": {
        const ok = await retryFailedWrite(deps.db, request.idempotencyKey);
        return {
          type: "RETRY_REPLY",
          idempotencyKey: request.idempotencyKey,
          outcome: ok ? "queued" : "not_found",
        };
      }

      case "DISCARD_WRITE": {
        const finalisedAt = (deps.now ?? defaultNow)().toISOString();
        const ok = await discardFailedWrite(
          deps.db,
          request.idempotencyKey,
          request.discardReasonCode,
          request.discardReasonText,
          finalisedAt,
        );
        return {
          type: "DISCARD_REPLY",
          idempotencyKey: request.idempotencyKey,
          outcome: ok ? "discarded" : "not_found",
        };
      }

      // CR-DC-068 — clear a held write. Two guards, both inside the SW where page code cannot
      // reach past them: the row must genuinely be held (`clearHeldWrite` refuses one belonging to
      // the session asking, and refuses a `failed` row), and the session compared against is the
      // usable one, so a lapsed token cannot be used to claim a row is "mine" and delete it.
      case "CLEAR_HELD_WRITE":
        return await handleClearHeldWrite(request, deps);

      case "STORE_SESSION_TOKEN": {
        // SEC-AUTH-013 — token storage. Called by EPIC-002-M002 PIN-login flow.
        const storedAt = (deps.now ?? defaultNow)().toISOString();
        await storeSessionToken(
          deps.db,
          {
            token: request.token,
            expiresAt: request.expiresAt,
            warehouseId: request.warehouseId,
            stationId: request.stationId,
            // CR-DC-068 — the operator whose queued work this session may send.
            operatorId: request.operatorId,
            // CR-DC-071 — the station's inactivity window, so the worker can enforce idle and time
            // its own renewals. Stored alongside `lastActivityAt`, which storeSessionToken seeds
            // from `storedAt`: signing in is itself an action.
            autoLogoffMinutes: request.autoLogoffMinutes,
          },
          storedAt,
        );
        return { type: "STORE_SESSION_TOKEN_REPLY", ok: true };
      }

      case "CLEAR_SESSION_TOKEN": {
        await clearSessionToken(deps.db);
        // 🔴 CR-DC-088 — AND THE DRIVER'S CACHED READS GO WITH THE SESSION. Sign-out and auto-logoff
        //    both come through this one door (`session-client.ts`), so this is the sweep that stops
        //    operator A's run lingering on a tablet operator B is about to sign in at, and the one
        //    that stops yesterday's run surviving into today (a PIN session is capped at 16 h).
        //
        //    ⚠ IT IS THE TIDY-UP, NOT THE CONTROL. The store's primary key contains the identity
        //      triple, so B's lookup misses A's rows whether or not this line ever ran — which is why
        //      `clearDriverReads` swallows its own failure rather than failing a sign-out.
        await clearDriverReads(deps.db);
        return { type: "CLEAR_SESSION_TOKEN_REPLY", ok: true };
      }

      case "HAS_VALID_TOKEN_REQUEST": {
        // SEC-AUTH-013 inaccessibility guarantee — boolean only.
        const valid = await isStoredTokenValid(deps.db, (deps.now ?? defaultNow)());
        return { type: "HAS_VALID_TOKEN_REPLY", hasValidToken: valid };
      }

      // CR-DC-069 — "replay now". 🔴 This case is INTENTIONALLY EMPTY of queue work: it re-queues
      // nothing, resets no attempt counter, and never touches a `failed` row. All it does is give the
      // page a door to ask for a pass, which keeps this module what it has always been — pure queue
      // state with no fetch dependency (D-1). The send is performed by the SW entry, which calls its
      // own replayAndBroadcast() after this reply is posted, gated on shouldReplayAfterMessage below.
      case "DRAIN_QUEUE":
        return { type: "DRAIN_REPLY", accepted: true };

      // CR-DC-071 — "the operator just did something". Like DRAIN_QUEUE above, this case is
      // deliberately thin: it records the activity and nothing else. The renewal FETCH is the SW
      // entry's, gated on `shouldRenewAfterMessage` below, so this module keeps the property that
      // makes its unit tests cheap and trusted — pure state, no network dependency (CR-DC-069 D-1).
      //
      // 🔴 THE REPLY IS A BARE BOOLEAN. `ok: false` means "there was no session to record against"
      // (signed out between the tap and the message), never "your session ends at …". The page may
      // not learn its own expiry here — SEC-AUTH-013.
      case "SESSION_ACTIVITY": {
        const at = (deps.now ?? defaultNow)().toISOString();
        const recorded = await recordSessionActivity(deps.db, at);
        return { type: "SESSION_ACTIVITY_REPLY", ok: recorded };
      }
    }
  } catch (err) {
    return {
      type: "ERROR",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * CR-DC-068 — clear a held write. Two guards, both INSIDE the SW where page code cannot reach past
 * them: `clearHeldWrite` refuses a row that belongs to the session asking (your own waiting work is
 * not clearable through this door) and refuses a `failed` row (those have their own path); and the
 * session compared against is the USABLE one, so a lapsed token cannot be used to claim a row is
 * "mine" and delete it.
 */
async function handleClearHeldWrite(
  request: Extract<SyncRequest, { type: "CLEAR_HELD_WRITE" }>,
  deps: MessageHandlerDeps,
): Promise<SyncReply> {
  const finalisedAt = (deps.now ?? defaultNow)().toISOString();
  const session = await usableSession(deps);
  const cleared = await clearHeldWrite(
    deps.db,
    request.idempotencyKey,
    request.discardReasonCode,
    request.discardReasonText,
    session,
    finalisedAt,
  );
  if (cleared) {
    return { type: "CLEAR_HELD_REPLY", idempotencyKey: request.idempotencyKey, outcome: "cleared" };
  }
  // Separate the two failures so the panel can tell "already gone" from "not yours to clear".
  const pending = await getPendingWrites(deps.db);
  const row = pending.find((w) => w.idempotencyKey === request.idempotencyKey);
  const refused = row !== undefined && writeBelongsToSession(row, session);
  return {
    type: "CLEAR_HELD_REPLY",
    idempotencyKey: request.idempotencyKey,
    outcome: refused ? "refused" : "not_found",
  };
}

// ---------------------------------------------------------------------------
// CR-DC-069 — which messages should be followed by a replay pass
// ---------------------------------------------------------------------------

/**
 * CR-DC-069 — the four message types that must cause the service worker to actually SEND after the
 * queue state has been updated. `src/sw/index.ts` calls its own `replayAndBroadcast()` when this
 * returns true (D-1 route (a)); this module keeps no network dependency of its own.
 *
 * The predicate is exported and pure so the DECISION is unit-testable even though the SW entry has
 * no unit tests (nothing under tests/** imports it — it is serwist-compiled to public/sw.js). The
 * entry keeps a single `if` around a call it already owned.
 *
 *   · RETRY_ALL / RETRY_WRITE — the operator asked. Before this, both only flipped rows from
 *     `failed` to `queued` in IndexedDB and NOTHING sent: the chip changed from Conflict to Syncing
 *     and the work did not move until the operator happened to save something else.
 *   · DRAIN_QUEUE — the page-side reconnect / app-start / pick-up trigger (QueueDrainTriggers).
 *   · STORE_SESSION_TOKEN — PIN sign-in. UX-SCREEN-230 promises on screen that held work "will send
 *     by themselves the moment that person signs in at this station" (CR-DC-068). This is what makes
 *     that sentence true.
 *
 * 🔴 Deliberately NOT CLEAR_SESSION_TOKEN: after a sign-out there is no usable session, so every row
 * would skip `unauthenticated` — a guaranteed no-op pass and a pointless service-worker wake-up on a
 * battery-powered tablet.
 */
const REPLAY_AFTER_MESSAGE_TYPES: ReadonlySet<string> = new Set<SyncRequest["type"]>([
  "RETRY_ALL",
  "RETRY_WRITE",
  "DRAIN_QUEUE",
  "STORE_SESSION_TOKEN",
]);

export function shouldReplayAfterMessage(type: SyncRequest["type"]): boolean {
  return REPLAY_AFTER_MESSAGE_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// CR-DC-071 — which messages should be followed by a session-renewal check
// ---------------------------------------------------------------------------

/**
 * CR-DC-071 — the message types after which the service worker should ask "is a renewal due?".
 *
 * Exactly ONE member, and the narrowness is the point. `SESSION_ACTIVITY` is the only message that
 * means "a human touched this tablet", which is the only thing that should extend a session on a
 * shared, unattended device. A drain trigger, a retry tap from a background tab or a status poll
 * must NOT keep a session alive — that would quietly turn the inactivity window into a liveness
 * check on the software rather than on the operator.
 *
 * Exported and pure for the same reason `shouldReplayAfterMessage` is: nothing under `tests/**`
 * imports `src/sw/index.ts` (it is serwist-compiled to public/sw.js), so the DECISION is testable
 * even though the entry that acts on it is not. The entry keeps a single `if` around a call.
 *
 * ⚠ The decision to actually mint — past the renewal threshold, not idle, not expired, not scoped,
 * not capped — lives in `src/sw/session-renewal.ts` and on the server. This predicate only says
 * "this message is the kind that may cause one".
 */
const RENEW_AFTER_MESSAGE_TYPES: ReadonlySet<string> = new Set<SyncRequest["type"]>([
  "SESSION_ACTIVITY",
]);

export function shouldRenewAfterMessage(type: SyncRequest["type"]): boolean {
  return RENEW_AFTER_MESSAGE_TYPES.has(type);
}

export interface MessageHandlers {
  buildSyncSnapshot(deps: MessageHandlerDeps): Promise<SyncStatusSnapshot>;
  handleMessage(request: SyncRequest, deps: MessageHandlerDeps): Promise<SyncReply>;
}

export function createMessageHandlers(settings: MessageHandlerSettings): MessageHandlers {
  return {
    buildSyncSnapshot: (deps) => buildSyncSnapshotImpl(settings, deps),
    handleMessage: (request, deps) => handleMessageImpl(settings, request, deps),
  };
}

function defaultNow(): Date {
  return new Date();
}
