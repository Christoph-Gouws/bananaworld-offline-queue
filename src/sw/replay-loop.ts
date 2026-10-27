// Service-worker replay loop for the offline write queue (TECH-COMP-006).
//
// Anchors: EPIC-001-M007-SCOPE-004, PRD-FUNC-130 (deterministic conflict resolution),
//          TECH-BE-010, API-FAIL-007 (OFFLINE_QUEUE_SYNC_CONFLICT), API-SYNC-001,
//          PRD-NFR-005 (10-min outage), PRD-NFR-006 (multi-station concurrent).
//
// Iterates pending_writes in queuedAt order — and NEVER sends a row while an earlier one is still
// waiting (held, backed off, mid-send); a refused (`failed`) row does not hold anything back (CR-DC-267).
// Replays each via fetch from the
// SW context (which lets the SW inject `Authorization: Bearer <token>` from
// its protected storage per SEC-AUTH-013); maps the response code to a queue
// transition:
//
//   - no / lapsed session          → skipped "unauthenticated"   (CR-DC-068 — nothing is sent)
//   - session belongs to someone else → skipped "held-for-operator" (CR-DC-068 — nothing is sent)
//   - 2xx                          → dequeueWriteOnSuccess (mark synced + move to history)
//   - 401 / 403                    → markWriteAttempt (stays queued; CR-DC-068)
//   - 409 OFFLINE_QUEUE_SYNC_CONFLICT → markWriteFailed with reason from response body
//   - 409 IDEMPOTENCY_CONFLICT     → markWriteFailed loudly (queue bug)
//   - other 4xx                    → markWriteFailed with UNKNOWN reason + verbatim message
//   - 5xx or network error         → markWriteAttempt (stays queued; exponential backoff)
//
// CR-DC-068 — the first two rows are checked BEFORE the attempt counter is touched, so a write that
// cannot be sent yet keeps every one of its retries. See `checkSessionSkip`.
//
// Backoff schedule: 1s, 2s, 4s, 8s, 16s, capped at 30s; max 100 attempts before
// the write is moved to `failed` with a synthetic reason. This bounds the
// queue against pathological connectivity (a server permanently returning
// 503) while still surviving the 10-minute outage SLA per PRD-NFR-005.
//
// CR-DC-069 — the ceiling is UNCHANGED, but it is no longer a one-way door: `retryFailedWrite`
// resets `attemptCount` to 0, so an operator's Retry hands an exhausted write a genuine fresh budget
// instead of it re-failing on the next pass with zero server calls. Discard is no longer the only
// exit from a stranded write. Nothing about the schedule, the cap or the 4xx/5xx mapping moved.

import { IDEMPOTENCY_HEADER } from "../idempotency";
import {
  dequeueWriteOnSuccess,
  discardUnreplayableWrite,
  getPendingWrites,
  markWriteAttempt,
  markWriteFailed,
  pruneSyncHistory,
  writeBelongsToSession,
} from "../queue";
import { isPreUpdateRow } from "../pre-update-clear";
import type { ConflictReason, OfflineQueueDB, PendingWriteRecord } from "../schema";
import { isSessionIdle, isSessionTokenExpired, type StationSession } from "../token-storage";
import { isSameOriginApiUrl } from "./fetch-handler";
import { globalFetch } from "./global-fetch";

// 🔴 CR-DC-240 (KI-227-01) — THE DEFECT THIS CLOSES. The native `fetch` is a WebIDL operation on the
// worker's global scope. The loop used to keep it on a context object and call it as a METHOD of that
// object (`ctx.fetchImpl(url, …)`), and Chromium throws "Illegal invocation" for that. The throw was
// caught as a network failure, so no queued write reached a server from 2026-05-28 until this fix.
// Every unit suite injected a stub `fetch` that ignores `this`, which is why nothing caught it.
//
// The default is the `this`-ignoring wrapper in ./global-fetch, and `tryFetch` ALSO calls it unbound —
// two independent defences — and each app's compiled-worker e2e is the real proof.

const MAX_ATTEMPTS_BEFORE_FAIL = 100;
const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 32];
const BACKOFF_CAP_SECONDS = 30;
/** CR-DC-267 — how long one replay send may wait for an answer. A mechanism bound, not a business value. */
export const REPLAY_FETCH_TIMEOUT_MS = 30_000;

export interface ReplayDeps {
  db: OfflineQueueDB;
  /**
   * Session reader — supplies the token injected as `Authorization: Bearer <token>` per
   * SEC-AUTH-013, AND the identity triple every row is checked against before it is sent
   * (CR-DC-068). The two travel together on purpose: a caller cannot obtain a token to attach
   * without also obtaining the identity that decides whether it may be attached.
   */
  readToken: () => Promise<StationSession | null>;
  /** Override for tests; defaults to native fetch from the SW context. */
  fetch?: typeof fetch;
  now?: () => Date;
  /**
   * The service worker's own origin (`self.location.origin`). When supplied, the loop DISCARDS any
   * queued write whose target is not a same-origin `/api/*` call — such a write can never replay
   * successfully and would otherwise loop forever (REV-9 follow-up; self-heals tablets that queued a
   * cross-origin QC photo PUT before the fetch-handler guard landed). Omitted in unit tests that don't
   * exercise this guard, so the discard is opt-in.
   */
  swOrigin?: string;
  /** Override for tests; defaults to `REPLAY_FETCH_TIMEOUT_MS`. */
  fetchTimeoutMs?: number;
}

export type ReplayOutcome =
  | { idempotencyKey: string; outcome: "synced" }
  | { idempotencyKey: string; outcome: "failed"; reason: ConflictReason; message: string }
  | { idempotencyKey: string; outcome: "retry-later"; nextAttemptAfterSeconds: number }
  | { idempotencyKey: string; outcome: "discarded"; message: string }
  // CR-DC-068 — "unauthenticated" was declared here from the very first version of this file and
  // nothing ever produced it: the guard was designed and never built, and every write that met the
  // condition was dead-lettered instead. `checkSessionSkip` below is that missing guard.
  // "held-for-operator" is its sibling: the session is usable, but it is not this write's.
  | {
      idempotencyKey: string;
      outcome: "skipped";
      // CR-DC-267 — "behind-earlier": an earlier row of the queue is still waiting, so this one is not sent.
      reason: "backoff" | "unauthenticated" | "held-for-operator" | "behind-earlier";
    };

/**
 * Run one pass of the replay loop. Returns the outcome of each pending write the loop attempted (or
 * skipped).
 *
 * CR-DC-069 — THE SIX REAL CALLERS, all of them through `replayAndBroadcast()` in `src/sw/index.ts`:
 *
 *   1. a new tablet write has just been queued (`flushQueueAfterWrite`, the ONLY trigger that
 *      existed in practice before CR-DC-069);
 *   2. the Background Sync event, tag `bananaworld-replay`;
 *   3. RETRY_ALL — the operator tapped "Retry all";
 *   4. RETRY_WRITE — the operator tapped Retry on one row;
 *   5. STORE_SESSION_TOKEN — someone signed in at the station, which is what makes UX-SCREEN-230's
 *      promise about held work true;
 *   6. DRAIN_QUEUE — the page asking, on reconnect, on app start, or when the tablet is picked up.
 *
 * 🔴 THERE IS NO 30-SECOND HEARTBEAT. An earlier version of this comment listed one as a caller and
 * there was never a `setInterval` anywhere in the sync path. CR-DC-069 D-2 decided not to build one:
 * a timer inside a service worker dies when the browser terminates the idle worker, and a page-side
 * clock burns a wake-up every tick on a battery-powered tablet with nothing to send. Triggers 3–6
 * cover the cases a clock was imagined to cover.
 *
 * 🔴 CONCURRENCY — read this before assuming the loop defends itself. It does NOT. An earlier
 * comment here claimed that "if called concurrently, the `markWriteAttempt` status flips to
 * `syncing` to prevent the same write being attempted by two passes at once". That was false:
 * `getPendingWrites` LISTS `syncing` rows beside `queued` ones, it does not exclude them, and `replayOneWrite`
 * skips only `failed` — so two overlapping passes both read a row before either marks it, and both
 * send it. What actually prevents that is the `singleFlight` wrapper around `replayAndBroadcast` in
 * `src/sw/index.ts` (CR-DC-069 §2.6), which coalesces overlapping triggers into one pass. The
 * `Idempotency-Key` reused on every attempt of a row (see `buildReplayRequestInit`) is the BACKSTOP
 * behind that — CR-DC-067 answers a repeat with `200 …idempotent_replay` — not the mechanism.
 * 🔴 A caller that invokes `runReplay` directly, outside `replayAndBroadcast`, gets no such
 * protection.
 */
export async function runReplay(deps: ReplayDeps): Promise<ReplayOutcome[]> {
  const now = (deps.now ?? defaultNow)();
  const fetchImpl = deps.fetch ?? globalFetch;
  const token = await deps.readToken();
  const pending = await getPendingWrites(deps.db);
  const outcomes: ReplayOutcome[] = [];

  // 🔴 CR-DC-267 — HEAD-OF-LINE ORDER. Once a row is WAITING (held, backed off, or its send did not
  // get an answer), nothing saved after it is sent in this pass. The loop used to step over such a row
  // and send the next, so a later save overtook an earlier one and two pallets swapped numbers
  // (bananaworld-ph PR #55). What does NOT hold anything back: a refused row (`failed` — it waits for
  // a person, and the owner ruled it never blocks), an exhausted row (it lands on `failed`), a
  // pre-update row and a discarded cross-origin row (neither is ever sent).
  let blocked = false;
  for (const write of pending) {
    // CR-DC-240 — work saved by a pre-fix worker is NEVER sent (owner ruling 2026-10-11): the sweep
    // clears it once, and this is the backstop if that sweep has not managed to commit yet. No
    // outcome, no attempt, no send; the row is left exactly as it was. FIRST, ahead of every other
    // decision about the row.
    if (isPreUpdateRow(write)) continue;
    const outcome = await replayOneWrite(write, { deps, fetchImpl, token, now, blocked });
    if (outcome) {
      outcomes.push(outcome);
      if (outcome.outcome === "skipped" || outcome.outcome === "retry-later") blocked = true;
    }
  }

  // CR-DC-070 — housekeeping, at the END, after every outcome above is computed.
  //
  // 🔴 IT CHANGES NO REPLAY DECISION, and three separate properties keep that true: it runs after the
  // loop, it opens a transaction on `sync_history` ONLY (so it cannot touch a pending write), and its
  // failure is swallowed here rather than propagating. A retention sweep must never be able to alter
  // what happened to an operator's work.
  //
  // WHY HERE AND NOT IN `src/sw/index.ts`. Nothing under `tests/**` imports the SW entry — it is
  // serwist-compiled to public/sw.js — so a call placed there would be unprovable, exactly the shape
  // of claim this estate has been burned by. `runReplay` is covered by replay-loop.test.ts and
  // replay-triggers.test.ts, so "the prune actually runs on the real trigger" is an assertion rather
  // than a comment. (CR-DC-069 set the precedent by moving the *decision* into a tested module.)
  //
  // WHY NOT IN `buildSyncSnapshot`: that is a READ path, called on every status request. Making it
  // write would be a worse problem than the one being fixed.
  try {
    await pruneSyncHistory(deps.db);
  } catch (err) {
    console.warn("[sw] sync-history prune skipped", err);
  }

  return outcomes;
}

interface ReplayOneContext {
  deps: ReplayDeps;
  fetchImpl: typeof fetch;
  token: StationSession | null;
  now: Date;
  /** CR-DC-267 — an earlier row of this pass is still waiting, so this one must not be sent. */
  blocked: boolean;
}

async function replayOneWrite(
  write: PendingWriteRecord,
  ctx: ReplayOneContext,
): Promise<ReplayOutcome | null> {
  // REV-9 follow-up — discard a write that can never replay: a non-same-origin /api/* target should
  // never have entered the queue (the offline queue mediates same-origin API writes only). The
  // canonical case is a QC photo PUT to a cross-origin Supabase signed URL captured BEFORE the
  // fetch-handler guard landed; retrying it forever leaves the tablet stuck "syncing". Checked before
  // the failed-skip so it also clears poison that already dead-lettered to `failed`.
  if (ctx.deps.swOrigin !== undefined && !isSameOriginApiUrl(write.url, ctx.deps.swOrigin)) {
    await discardUnreplayableWrite(ctx.deps.db, write.idempotencyKey, ctx.now.toISOString());
    return {
      idempotencyKey: write.idempotencyKey,
      outcome: "discarded",
      message: "Removed an offline entry that can never sync (not a same-origin API write).",
    };
  }

  // Skip already-failed writes — operator must explicitly retry.
  if (write.status === "failed") return null;

  // CR-DC-068 — a write is NEVER sent without a usable session of its own. Placed here on purpose:
  // AFTER the failed-skip, and BEFORE both `checkBackoffSkip` and `markWriteAttempt(…, "syncing")`.
  //
  //   · Before markWriteAttempt, because that call is the ONLY place attemptCount is incremented on
  //     the send path (queue.ts). Returning first is what makes "must not burn an attempt" true
  //     rather than merely intended — the row keeps its status, its attemptCount and its
  //     lastAttemptAt, and stays replayable forever.
  //   · Before the backoff skip, because a row that cannot be sent AT ALL must report that, not
  //     "waiting to retry". Otherwise the operator-facing state is a lie for the whole backoff
  //     window. AC-10 pins the ordering.
  const skipForSession = checkSessionSkip(write, ctx);
  if (skipForSession) return skipForSession;

  // CR-DC-267 — after the session check (a held row keeps its own real reason, AC-10), before backoff
  // and `markWriteAttempt`: a row waiting its turn is left exactly as it was.
  const skipForOrder = checkOrderSkip(write, ctx);
  if (skipForOrder) return skipForOrder;

  const skipForBackoff = checkBackoffSkip(write, ctx.now);
  if (skipForBackoff) return skipForBackoff;

  if (write.attemptCount >= MAX_ATTEMPTS_BEFORE_FAIL) {
    return await failExhaustedWrite(write, ctx);
  }

  await markWriteAttempt(ctx.deps.db, write.idempotencyKey, "syncing", ctx.now.toISOString());
  const response = await tryFetch(write, ctx);
  if (response === null) {
    return await handleRetryable(write, ctx);
  }
  return await handleResponse(response, write, ctx);
}

/**
 * CR-DC-068 — the guard `ReplayOutcome` has declared since M007 and nobody ever built.
 *
 * Two refusals, both of which leave the row exactly as it was — still `queued`, same attemptCount,
 * same lastAttemptAt, still replayable the moment the right person taps back in:
 *
 *   1. `unauthenticated` — no session stored, or the stored one has lapsed. Without this the write
 *      went out with NO Authorization header at all (buildReplayRequestInit only attaches one when
 *      a token is present), the server answered 401, and `handleResponse` filed that 4xx as a
 *      dead-lettered `failed` row. Three of three queued writes were destroyed by a routine
 *      auto-logoff — the exact opposite of PRD-NFR-005's zero data loss.
 *   2. `held-for-operator` — the session is usable but it is somebody else's. Operator A captures
 *      offline, auto-logoff fires, operator B taps in: without this, A's work reaches the server
 *      under B's token and is audit-logged as B's. An audit log that names the wrong operator is
 *      worse than one that names nobody, because it is confidently wrong (D-038, retention >= 5y).
 *
 * 🔴 A held row's `warehouseId` is never rewritten to make it match. A tablet re-paired to another
 * depot is a case for a human, not a field to overwrite.
 */
function checkSessionSkip(write: PendingWriteRecord, ctx: ReplayOneContext): ReplayOutcome | null {
  const session = ctx.token;
  // 🔴 CR-DC-071 — AN IDLE SESSION IS AS UNUSABLE AS A LAPSED ONE, and it lands on the same arm on
  // purpose. The token now outlives the inactivity window by OFFLINE_GRACE_MINUTES so a 10-minute
  // outage is survivable on every station (PRD-NFR-005); without this line that grace would also be
  // a window in which an unattended tablet could still send. The row is left exactly as it was —
  // still `queued`, same attemptCount, same lastAttemptAt — and drains by itself when the operator
  // taps back in, through CR-DC-069's STORE_SESSION_TOKEN replay trigger.
  //
  // ⚠ Nothing else in this file moved for CR-DC-071: not the 401 arm below (CR-DC-068's, and it
  // stays theirs), not the backoff schedule, not MAX_ATTEMPTS_BEFORE_FAIL, not the conflict mapping.
  if (
    session === null ||
    isSessionTokenExpired(session.expiresAt, ctx.now) ||
    isSessionIdle(session, ctx.now)
  ) {
    return {
      idempotencyKey: write.idempotencyKey,
      outcome: "skipped",
      reason: "unauthenticated",
    };
  }
  if (!writeBelongsToSession(write, session)) {
    return {
      idempotencyKey: write.idempotencyKey,
      outcome: "skipped",
      reason: "held-for-operator",
    };
  }
  return null;
}

function checkOrderSkip(write: PendingWriteRecord, ctx: ReplayOneContext): ReplayOutcome | null {
  if (!ctx.blocked) return null;
  return { idempotencyKey: write.idempotencyKey, outcome: "skipped", reason: "behind-earlier" };
}

function checkBackoffSkip(write: PendingWriteRecord, now: Date): ReplayOutcome | null {
  if (write.attemptCount <= 0 || write.lastAttemptAt === null) return null;
  const backoff = backoffSecondsFor(write.attemptCount);
  const ageMs = now.getTime() - new Date(write.lastAttemptAt).getTime();
  if (ageMs < backoff * 1000) {
    return {
      idempotencyKey: write.idempotencyKey,
      outcome: "skipped",
      reason: "backoff",
    };
  }
  return null;
}

async function failExhaustedWrite(
  write: PendingWriteRecord,
  ctx: ReplayOneContext,
): Promise<ReplayOutcome> {
  await markWriteFailed(
    ctx.deps.db,
    write.idempotencyKey,
    "UNKNOWN",
    `Exceeded ${MAX_ATTEMPTS_BEFORE_FAIL} retry attempts — server unreachable. ` +
      "Open sync details to retry or discard.",
    ctx.now.toISOString(),
  );
  return {
    idempotencyKey: write.idempotencyKey,
    outcome: "failed",
    reason: "UNKNOWN",
    message: "Exceeded retry budget",
  };
}

async function tryFetch(
  write: PendingWriteRecord,
  ctx: ReplayOneContext,
): Promise<Response | null> {
  // Unbound from its holder on purpose (KI-227-01) — never `ctx.fetchImpl(…)`.
  const send = ctx.fetchImpl;
  // 🔴 CR-DC-267 — A SEND THAT NEVER ANSWERS MUST NOT FREEZE THE TABLET. The pass is single-flighted, so
  // one hung request used to swallow every later trigger until the browser killed the worker. The abort
  // signal stops a real fetch; the race ends the wait even for a fetch that ignores the signal. A
  // timeout is a network failure: the row takes the retryable path, keeps its Idempotency-Key, and the
  // server answers a repeat with `idempotent_replay` if it did finish.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, ctx.deps.fetchTimeoutMs ?? REPLAY_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      send(write.url, buildReplayRequestInit(write, ctx.token, controller.signal)),
      timedOut,
    ]);
  } catch {
    return null; // network error — caller handles retryable transition
  } finally {
    clearTimeout(timer);
  }
}

async function handleRetryable(
  write: PendingWriteRecord,
  ctx: ReplayOneContext,
): Promise<ReplayOutcome> {
  await markWriteAttempt(ctx.deps.db, write.idempotencyKey, "queued", ctx.now.toISOString());
  return {
    idempotencyKey: write.idempotencyKey,
    outcome: "retry-later",
    nextAttemptAfterSeconds: backoffSecondsFor(write.attemptCount + 1),
  };
}

async function handleResponse(
  response: Response,
  write: PendingWriteRecord,
  ctx: ReplayOneContext,
): Promise<ReplayOutcome> {
  if (response.status >= 200 && response.status < 300) {
    await dequeueWriteOnSuccess(ctx.deps.db, write.idempotencyKey, ctx.now.toISOString());
    return { idempotencyKey: write.idempotencyKey, outcome: "synced" };
  }
  if (response.status >= 500) {
    return await handleRetryable(write, ctx);
  }
  // CR-DC-068 — a 401/403 means "cannot send RIGHT NOW", not "the server rejected this". A station
  // token can lapse between the gate above and this response (its floor life is five minutes), and
  // a token that has fallen out of its grant is the same class of "come back with a live session".
  // Dead-lettering either one loses work that was never refused on its merits, so both belong with
  // the retryable transitions — the same `markWriteAttempt(…, "queued")` that 5xx and network
  // errors already take. Placed BEFORE parseFailureResponse so no 4xx conflict mapping sees them.
  //
  // ⚠ This path DOES carry the attempt increment the "syncing" transition already applied, and
  // correctly so — a real send happened. "Do not burn an attempt" is a property of the gate above,
  // not of this arm. 🔴 The backoff schedule, MAX_ATTEMPTS_BEFORE_FAIL and the conflict-reason
  // mapping are NOT touched here; they belong to the sibling drain change.
  if (response.status === 401 || response.status === 403) {
    return await handleRetryable(write, ctx);
  }
  // CR-DC-109 — `code` is carried onto the row beside the reason and the message. It is what lets a
  // page tell WHICH refusal this was without matching on the sentence; see schema.ts § failureCode.
  const { reason, message, code } = await parseFailureResponse(response);
  await markWriteFailed(
    ctx.deps.db,
    write.idempotencyKey,
    reason,
    message,
    ctx.now.toISOString(),
    code,
  );
  return {
    idempotencyKey: write.idempotencyKey,
    outcome: "failed",
    reason,
    message,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultNow(): Date {
  return new Date();
}

/**
 * Compute the backoff window for the given attempt count. attemptCount = 1 →
 * 1 second; 2 → 2; 3 → 4; 4 → 8; 5 → 16; 6+ → 30 (capped).
 */
export function backoffSecondsFor(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  const idx = Math.min(attemptCount - 1, BACKOFF_SECONDS.length - 1);
  const next = BACKOFF_SECONDS.at(idx);
  if (next === undefined) return BACKOFF_CAP_SECONDS;
  return Math.min(next, BACKOFF_CAP_SECONDS);
}

function buildReplayRequestInit(
  write: PendingWriteRecord,
  token: StationSession | null,
  signal: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {
    ...write.headers,
    [IDEMPOTENCY_HEADER]: write.idempotencyKey,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token.token}`;
  }
  return {
    method: write.method,
    headers,
    body: write.body,
    // Reasonable defaults for a SW-issued replay.
    credentials: "include",
    redirect: "follow",
    signal,
  };
}

// 🔴 CR-DC-086 — TWO ENVELOPES, AND THE FIRST ONE IS THE REAL ONE. Every Route Handler in this
//    application answers `{ error: { code, message } }`. This parser originally read only
//    `error_code` / `user_message` / `details.reason`, a shape emitted by exactly ONE thing in the
//    repository: `app/api/test/queue-echo/route.ts`, the test harness the unit suite asserts
//    against — which is precisely why no suite ever caught it. The cost on a real route was that
//    every operator-facing sentence the route carefully writes was thrown away and the driver read
//    the literal string "Server returned 409 Error", and that the two conflict classifications
//    below could never fire.
//
// ⚠ THE LEGACY KEYS ARE KEPT DELIBERATELY, not out of caution: the echo endpoint is a real caller
//   and its assertions must stay green unedited (they are the regression wall for this file, which
//   every tablet surface shares). Real envelope FIRST on both fields.
interface FailureResponseShape {
  // The shipped envelope — every route (`{ error: { code, message } }`).
  error?: { code?: string; message?: string };
  // Legacy — /api/test/queue-echo only.
  error_code?: string;
  user_message?: string;
  details?: { reason?: string };
}

async function parseFailureResponse(
  response: Response,
): Promise<{ reason: ConflictReason; message: string; code: string | null }> {
  let payload: FailureResponseShape = {};
  try {
    payload = (await response.json()) as FailureResponseShape;
  } catch {
    // Body wasn't JSON; fall back to status-text.
  }
  const code = payload.error?.code ?? payload.error_code;
  const message = payload.error?.message ?? payload.user_message;

  if (code === "IDEMPOTENCY_CONFLICT") {
    return {
      reason: "IDEMPOTENCY_CONFLICT",
      code,
      message:
        message ??
        "Replay safety check failed — the queued write was retried with a different payload.",
    };
  }

  if (code === "OFFLINE_QUEUE_SYNC_CONFLICT") {
    // ⚠ `details.reason` is read from the LEGACY field only, and that is not an oversight. No route
    //   emits a `details` block, so inventing a read for the real envelope would be a fallback for
    //   data guaranteed absent (QUALITY-AI-005). The three fine-grained ConflictReason values stay
    //   reachable through the harness alone — the honest state of this system today.
    const detailReason = payload.details?.reason;
    const reason: ConflictReason =
      detailReason === "SERVER_MASTER_WINS" ||
      detailReason === "EARLIER_TIMESTAMP_LOSES" ||
      detailReason === "STATE_DOES_NOT_ALLOW"
        ? detailReason
        : "UNKNOWN";
    return {
      reason,
      code,
      message: message ?? "The server rejected this write — see details below.",
    };
  }

  // 🔴 THE REASON CHIP AND THE MESSAGE ARE TWO DIFFERENT FIELDS. A 409 ALREADY_CONFIRMED is not one
  //    of the five ConflictReason values, so its reason stays UNKNOWN and its MESSAGE is what
  //    changes — the driver now reads "This delivery has already been confirmed." verbatim, the
  //    sentence the route already writes. Inventing a sixth reason for it would be a queue-schema
  //    change and is a non-goal. The status-text fallback survives for a body with no message at all.
  return {
    reason: "UNKNOWN",
    // 🔴 CR-DC-109 — THIS IS THE ARM THAT MATTERS. `PO_REFERENCE_IN_USE` is not one of the five
    //    ConflictReason values and never will be (a sixth would be a queue-schema change, a stated
    //    non-goal), so it lands here with reason UNKNOWN — indistinguishable, until now, from every
    //    other 4xx. The code rides out beside the message so the receiving screen can act on it.
    code: code ?? null,
    message: message ?? `Server returned ${response.status} ${response.statusText || "Error"}`,
  };
}
