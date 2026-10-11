// Page ↔ service-worker message protocol for the offline write queue.
//
// Anchors: EPIC-001-M007-SCOPE-002, SEC-AUTH-013, TECH-FE-010, UX-DS-013.
//
// The page (browser main thread) and the SW (background thread) communicate
// via `postMessage`. This file defines the typed envelope contract:
//
//   - Page → SW requests:  SyncRequest (sent via navigator.serviceWorker.controller.postMessage)
//   - SW → page broadcasts: SyncBroadcast (sent via clients.matchAll().postMessage on state change)
//   - SW → page replies:   SyncReply (sent via the original event.ports[0])
//
// The CRITICAL security invariant per SEC-AUTH-013: NO message type ever
// carries the raw session token. The page can only ask "do I have a valid
// token?" and receive a boolean — the token itself is SW-internal.

import type { PendingWriteRecord, SyncHistoryRecord } from "./schema";

// ---------------------------------------------------------------------------
// Page → SW requests
// ---------------------------------------------------------------------------

export type SyncRequest =
  | { type: "SYNC_STATUS_REQUEST" }
  | { type: "RETRY_ALL" }
  | { type: "RETRY_WRITE"; idempotencyKey: string }
  | {
      type: "DISCARD_WRITE";
      idempotencyKey: string;
      discardReasonCode: import("./schema").DiscardReasonCode;
      discardReasonText: string | null;
    }
  // CR-DC-068 — clear a HELD write (one waiting for an operator who has not come back). Separate
  // from DISCARD_WRITE because the two are gated on opposite states: DISCARD_WRITE acts on a
  // `failed` row the server rejected, this acts on a `queued` row nobody has rejected. The SW
  // refuses it for a row that belongs to the CURRENT session — your own waiting work is not
  // clearable through this door. There is deliberately NO counterpart that SENDS a held write.
  | {
      type: "CLEAR_HELD_WRITE";
      idempotencyKey: string;
      discardReasonCode: import("./schema").DiscardReasonCode;
      discardReasonText: string | null;
    }
  | {
      type: "STORE_SESSION_TOKEN";
      token: string;
      expiresAt: string;
      warehouseId: string;
      stationId: string;
      // CR-DC-068 — who is signing in. NOT a credential (it is already in localStorage via
      // storeSessionDisplay) and it grants nothing; it is what lets the SW tell this operator's
      // queued work from the last one's. 🔴 The raw token still travels one way only, page → SW.
      operatorId: string | null;
      // CR-DC-071 — the station's inactivity window, so the worker can tell an idle session from a
      // live one and decide when a renewal is due. NOT a credential and NOT new to page code: the
      // same number is written to localStorage by `storeSessionDisplay` a moment later. Optional so
      // an older caller still type-checks; a session stored without it is not idle-enforced.
      autoLogoffMinutes?: number;
    }
  | { type: "CLEAR_SESSION_TOKEN" }
  | { type: "HAS_VALID_TOKEN_REQUEST" }
  // CR-DC-071 — "the operator just did something". THE payload-free message, in the same shape as
  // CR-DC-069's DRAIN_QUEUE and for the same reason: the page's only job is to say that a human
  // touched the tablet.
  //
  // 🔴 IT CARRIES NOTHING AND ITS REPLY CARRIES NOTHING. The renewal it may trigger happens INSIDE
  // the service worker, which fetches with its own token and stores the new one itself. The renewed
  // token therefore never becomes a page `Response` object at all. The obvious alternative —
  // piggybacking a fresh token on a response header of an ordinary request — fails SEC-AUTH-013,
  // because `handleTabletRead` and the online arm of `handleTabletWrite` both hand the server
  // `Response` back to the page, where `res.headers.get(...)` would read it. See logic plan §5.1.
  | { type: "SESSION_ACTIVITY" }
  // CR-DC-069 — "replay now". The page's ONLY way to ask the service worker to drain the queue, and
  // it carries no payload at all. The handler changes NO queue state: it re-queues nothing, resets
  // nothing, and does not touch a single `failed` row. The send itself is the SW entry's, which calls
  // its own replayAndBroadcast() after this message is answered.
  //
  // 🔴 Why this is NOT just RETRY_ALL fired on reconnect. Once RETRY_ALL genuinely sends, firing it
  // automatically on every reconnect would silently un-fail every conflict-`failed` write, hand each
  // one a fresh 100-attempt budget and re-send it with nobody having decided to. A write that failed
  // SERVER_MASTER_WINS must stay in front of the operator until they choose. And RETRY_ALL reads
  // `getFailedWrites` — `failed` rows ONLY — so it never touched the `queued` rows that ARE the
  // ordinary offline case. DRAIN_QUEUE is the trigger for those.
  | { type: "DRAIN_QUEUE" };

// ---------------------------------------------------------------------------
// SW → page replies (one-shot response to a SyncRequest)
// ---------------------------------------------------------------------------

export interface SyncStatusSnapshot {
  online: boolean;
  // Every unreconciled row, held ones included — unchanged in meaning from M007, so nothing that
  // already reads it changes behaviour.
  pendingWrites: PendingWriteRecord[];
  failedWrites: PendingWriteRecord[];
  // CR-DC-068 — the subset of `pendingWrites` that will NOT send under the session now held:
  // nobody is signed in, or the person signed in is not the one who captured them. A SUBSET, not a
  // separate list — a consumer that wants "waiting to sync" subtracts these and the failed ones.
  //
  // These rows carry `operatorId` (a UUID, never a name) and `stationId` to page code. That is the
  // same class of non-secret data as the `TabletSessionDisplay.operatorId` already in localStorage.
  // 🔴 The raw session token is NOT here and never will be (SEC-AUTH-013).
  heldWrites: PendingWriteRecord[];
  recentHistory: SyncHistoryRecord[];
  lastSyncAt: string | null;
  // 🔴 CR-DC-086 — WHICH SERVICE WORKER SENT THIS SNAPSHOT (src/sw/build-id.ts). Not a credential and
  //    not queue state: it is the one thing that lets a manager tell a tablet that has picked up a
  //    new worker from one that has not, which is what the post-deploy sweep depends on.
  //
  // ⚠ OPTIONAL ON PURPOSE, and that is the whole design. An OLD worker sends no field at all, so the
  //   panel renders "unknown (older version)" — which is itself precisely the answer the sweeping
  //   manager needs. A required field would have meant a queue-schema change (a non-goal) and would
  //   have broken every existing reader.
  swBuildId?: string;
  // CR-DC-240 — how many unsent items the one-off pre-update clear removed from this tablet, and when.
  // Absent when the clear has not run or removed nothing; absent from an older worker, so the panel
  // shows nothing there. A count and a time only — never a row, never a body.
  preUpdateCleared?: { count: number; clearedAt: string };
}

export type SyncReply =
  | { type: "SYNC_STATUS_REPLY"; snapshot: SyncStatusSnapshot }
  | { type: "RETRY_REPLY"; idempotencyKey: string; outcome: "queued" | "not_found" }
  | { type: "DISCARD_REPLY"; idempotencyKey: string; outcome: "discarded" | "not_found" }
  // CR-DC-068 — `refused` is its own outcome, distinct from `not_found`: the row exists but is not
  // held (it belongs to the session asking), so clearing it is not permitted.
  | {
      type: "CLEAR_HELD_REPLY";
      idempotencyKey: string;
      outcome: "cleared" | "not_found" | "refused";
    }
  | { type: "STORE_SESSION_TOKEN_REPLY"; ok: true }
  | { type: "CLEAR_SESSION_TOKEN_REPLY"; ok: true }
  // CRITICAL: HAS_VALID_TOKEN_REPLY MUST NOT include the raw token. The page
  // only receives a boolean (SEC-AUTH-013 inaccessibility guarantee).
  | { type: "HAS_VALID_TOKEN_REPLY"; hasValidToken: boolean }
  // CR-DC-069 — `accepted` says only "the service worker heard you and a pass will run". It is
  // deliberately NOT a result: the drain runs AFTER this reply goes out (askServiceWorker times out
  // at 1500 ms, so awaiting a network drain first would return null to the page on any slow
  // connection). What actually happened arrives on the SYNC_STATE_CHANGED + REPLAY_BATCH_COMPLETE
  // broadcasts the SW already sends to every open tab.
  | { type: "DRAIN_REPLY"; accepted: boolean }
  // CR-DC-071 — the activity acknowledgement. 🔴 EXACTLY ONE FIELD, AND IT IS A BOOLEAN. No token,
  // no expiry, no "renewed until". The page must not learn when its session ends from this reply:
  // the one question page code may ask about the session is still "am I valid?"
  // (`hasValidSessionToken`), and the one answer it may get is still a bare boolean (SEC-AUTH-013).
  // A unit test asserts the reply's KEY SET rather than its truthiness, so a field added here in
  // future goes red instead of leaking quietly.
  | { type: "SESSION_ACTIVITY_REPLY"; ok: boolean }
  | { type: "ERROR"; reason: string };

// ---------------------------------------------------------------------------
// SW → page broadcasts (no-reply state-change notifications to all clients)
// ---------------------------------------------------------------------------

export type SyncBroadcast =
  | { type: "SYNC_STATE_CHANGED"; snapshot: SyncStatusSnapshot }
  | { type: "REPLAY_BATCH_COMPLETE"; processed: number; failed: number }
  | { type: "QUEUE_FULL_BACKOFF"; idempotencyKey: string };

// ---------------------------------------------------------------------------
// Page-side helper: ask the SW + await its reply
// ---------------------------------------------------------------------------

/**
 * Send a request to the active service worker and await its reply via a
 * one-shot MessageChannel. Times out after `timeoutMs` to avoid hung Promises
 * when the SW is unresponsive (e.g., during install/activate transitions).
 *
 * Returns `null` if no service-worker controller is active (e.g., on first
 * page load before the SW has taken control, or in dev mode where the SW is
 * not registered). Callers should fall back to local state in that case.
 */
export async function askServiceWorker<TReply extends SyncReply = SyncReply>(
  request: SyncRequest,
  timeoutMs = 1500,
): Promise<TReply | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return null;

  return new Promise<TReply | null>((resolve) => {
    const channel = new MessageChannel();
    const timeoutId = window.setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);

    channel.port1.onmessage = (event: MessageEvent) => {
      window.clearTimeout(timeoutId);
      channel.port1.close();
      resolve(event.data as TReply);
    };
    controller.postMessage(request, [channel.port2]);
  });
}
