// Page-side queue API for the offline write queue (TECH-COMP-006).
//
// Anchors: EPIC-001-M007-SCOPE-002, PRD-FUNC-127, PRD-FUNC-128, PRD-FUNC-130,
//          TECH-FE-002, TECH-FE-010, API-PRINCIPLE-008, API-FAIL-007.
//
// This module is callable from BOTH the SW context (where the fetch handler
// invokes `enqueueWrite` directly) AND the page context (where UX-SCREEN-230
// reads queue state via `getPendingWrites` + `getSyncHistory`).
//
// All functions take the DB as an injected dependency — the caller is
// responsible for opening it (via `openOfflineQueueDB`) once per context. This
// pattern keeps the module testable with the in-memory `fake-indexeddb` and
// avoids hidden singletons that complicate Stage 04 test isolation.

import { isPreUpdateRow } from "./pre-update-clear";
import { REPLAY_GENERATION } from "./schema";
import type {
  ConflictReason,
  DiscardReasonCode,
  OfflineQueueDB,
  PendingWriteRecord,
  PendingWriteStatus,
  SyncHistoryRecord,
} from "./schema";

// ---------------------------------------------------------------------------
// enqueue — called from the SW fetch handler for every intercepted write
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  idempotencyKey: string;
  method: PendingWriteRecord["method"];
  url: string;
  headers: Record<string, string>;
  body: string | null;
  queuedAt?: string; // defaults to now; injectable for deterministic tests
  warehouseId: string | null;
  // CR-DC-068 — the operator + station this write belongs to, read from the SW-held session at
  // enqueue. Both null when no session was active, which makes the row un-replayable until a human
  // resolves it (see writeBelongsToSession). Optional so a caller that genuinely has no session does
  // not have to spell out two nulls.
  operatorId?: string | null;
  stationId?: string | null;
}

// CR-DC-068 — the identity a queued write is compared against before it may be replayed. The three
// fields together are the triple: WHO did the work, at WHICH station, for WHICH depot.
//
// 🔴 A Global Station's picked room is NOT here and must never be added — it dies at logoff, so
// including it would hold every global-station write forever. See the logic plan §1.5.1.
export interface WriteIdentity {
  readonly operatorId: string | null | undefined;
  readonly stationId: string | null | undefined;
  readonly warehouseId: string | null | undefined;
}

/**
 * CR-DC-068 — may this queued write be replayed under the given session? THE control, and the one
 * definition of it: the replay loop gates on it and the sync snapshot renders from it.
 *
 * FAIL-CLOSED, deliberately and in both directions. A write whose identity is unknown (a row queued
 * under schema version 1, or with no session active) can never match; and a session that carries no
 * operator (one stored by an older app build) can never claim a row. Two unknowns do NOT cancel out
 * into a match — that would be the misattribution defect wearing a different hat.
 *
 * The correctness of this change does not depend on the version-2 backfill having run: the backfill
 * is tidiness, this comparison is the control.
 */
export function writeBelongsToSession(
  write: Pick<PendingWriteRecord, "operatorId" | "stationId" | "warehouseId">,
  session: WriteIdentity | null,
): boolean {
  if (session === null) return false;
  if (
    write.operatorId === null ||
    write.operatorId === undefined ||
    write.stationId === null ||
    write.stationId === undefined ||
    write.warehouseId === null ||
    write.warehouseId === undefined
  ) {
    return false;
  }
  if (
    session.operatorId === null ||
    session.operatorId === undefined ||
    session.stationId === null ||
    session.stationId === undefined ||
    session.warehouseId === null ||
    session.warehouseId === undefined
  ) {
    return false;
  }
  return (
    write.operatorId === session.operatorId &&
    write.stationId === session.stationId &&
    write.warehouseId === session.warehouseId
  );
}

/**
 * CR-DC-070 — the device is out of room. Thrown by `enqueueWrite` and by NOTHING else, so a caller
 * that catches it knows exactly one thing: this write was NOT stored and has therefore not happened.
 *
 * 🔴 It is its own class rather than a flag on the DOMException because the fetch handler branches on
 * it to break the optimistic-UI contract (UX-PRINCIPLE-015) deliberately and visibly — a 507, never
 * a 202. Every OTHER rejection from `db.add` is rethrown unchanged; see `isQuotaError`.
 */
export class QueueStorageFullError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string, options?: { cause?: unknown }) {
    super("The tablet is out of storage — this write could not be queued.", options);
    this.name = "QueueStorageFullError";
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * CR-DC-070 — is this rejection the origin running out of quota, or something else?
 *
 * 🔴 THE NEGATIVE CASE IS THE POINT. A `ConstraintError` (a duplicate `idempotencyKey` against the
 * unique index — i.e. a queue bug) must NEVER be classified as a full device: it would print "this
 * tablet is full" at the operator over a fault that has nothing to do with storage, and would hide a
 * real defect behind a housekeeping message. Only the three spellings below count, and every other
 * rejection propagates exactly as it did before this change.
 *
 *   · `QuotaExceededError`         — the standard name (Chromium, WebKit).
 *   · `NS_ERROR_DOM_QUOTA_REACHED` — Firefox's name for the same condition.
 *   · legacy `DOMException.code === 22` — older engines that carry the numeric code only.
 *
 * Duck-typed rather than `instanceof DOMException` so it behaves identically under happy-dom, in the
 * service worker, and on a real tablet.
 */
export function isQuotaError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  if (candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  return candidate.code === 22;
}

/**
 * Persist a new pending write to the queue. Returns the stored row including
 * the auto-generated `id`. The SW fetch handler calls this BEFORE returning
 * its optimistic 202 response to the caller (per M007-DEC-006 UX-PRINCIPLE-015
 * optimistic-UI contract).
 *
 * The `idempotencyKey` is unique across `pending_writes`; an existing key
 * indicates a queue-level bug (a write retried without going through the
 * replay path). The unique index in the schema enforces this at the DB level.
 *
 * CR-DC-070 — a full device is caught HERE, at the source, and re-thrown as `QueueStorageFullError`.
 * Before this the rejection escaped `handleTabletWrite` inside `event.respondWith` and the operator
 * got whatever generic failure their flow prints, on a write the whole design had promised was safe
 * to make offline. `idb`'s `db.add` awaits `Promise.all([request, tx.done])`, so the rejection
 * arrives here whether the engine raises it on the request or on the transaction — one catch covers
 * both (logic plan §8 open question 3, answered).
 */
export async function enqueueWrite(
  db: OfflineQueueDB,
  input: EnqueueInput,
): Promise<PendingWriteRecord> {
  const queuedAt = input.queuedAt ?? new Date().toISOString();
  const record: PendingWriteRecord = {
    idempotencyKey: input.idempotencyKey,
    method: input.method,
    url: input.url,
    headers: input.headers,
    body: input.body,
    queuedAt,
    lastAttemptAt: null,
    attemptCount: 0,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    warehouseId: input.warehouseId,
    // CR-DC-068 — stamped once, at capture, and never rewritten afterwards.
    operatorId: input.operatorId ?? null,
    stationId: input.stationId ?? null,
    // CR-DC-240 — marks this row as written by a worker whose replay really sends.
    replayGeneration: REPLAY_GENERATION,
  };
  let id: IDBValidKey;
  try {
    id = await db.add("pending_writes", record);
  } catch (err) {
    // 🔴 Only a genuine quota refusal becomes the operator-visible "tablet is full". Everything else
    // — a ConstraintError from the unique idempotency index above all — is re-thrown untouched, so
    // this change alters the behaviour of exactly one failure mode and no others.
    if (isQuotaError(err)) {
      throw new QueueStorageFullError(input.idempotencyKey, { cause: err });
    }
    throw err;
  }
  return { ...record, id: id as number };
}

// ---------------------------------------------------------------------------
// dequeue — mark synced + move to sync_history
// ---------------------------------------------------------------------------

/**
 * Mark a queued write as synced and move it to the history store.
 * Called from the replay loop after a 2xx response. Atomic within one
 * transaction so a crash between the delete + insert leaves the queue in
 * the original `pending_writes` state (replay can retry).
 */
export async function dequeueWriteOnSuccess(
  db: OfflineQueueDB,
  idempotencyKey: string,
  finalisedAt: string = new Date().toISOString(),
): Promise<void> {
  const tx = db.transaction(["pending_writes", "sync_history"], "readwrite");
  const pendingStore = tx.objectStore("pending_writes");
  const historyStore = tx.objectStore("sync_history");

  const pendingIndex = pendingStore.index("by_idempotency_key");
  const row = await pendingIndex.get(idempotencyKey);
  if (!row || row.id === undefined) {
    await tx.done;
    return; // already removed (idempotent on retries)
  }
  const historyRecord: SyncHistoryRecord = {
    idempotencyKey: row.idempotencyKey,
    outcome: "synced",
    finalisedAt,
    method: row.method,
    url: row.url,
    discardReasonCode: null,
    discardReasonText: null,
  };
  await historyStore.add(historyRecord);
  await pendingStore.delete(row.id);
  await tx.done;
}

// ---------------------------------------------------------------------------
// markWriteFailed — server rejected with a 4xx that won't auto-retry
// ---------------------------------------------------------------------------

/**
 * Mark a write as failed (the operator must retry or discard via UX-SCREEN-230).
 * Called from the replay loop on 409 OFFLINE_QUEUE_SYNC_CONFLICT or
 * IDEMPOTENCY_CONFLICT. 5xx and network errors don't reach this path — they
 * stay `queued` and retry with exponential backoff inside the replay loop.
 */
export async function markWriteFailed(
  db: OfflineQueueDB,
  idempotencyKey: string,
  reason: ConflictReason,
  message: string,
  lastAttemptAt: string = new Date().toISOString(),
  // CR-DC-109 — the route's own error code, when the body carried one. Trailing and defaulted, so
  // every existing caller (and the retry-budget dead-letter, which has no server body at all)
  // writes exactly the row it wrote before.
  failureCode: string | null = null,
): Promise<void> {
  const tx = db.transaction("pending_writes", "readwrite");
  const store = tx.objectStore("pending_writes");
  const row = await store.index("by_idempotency_key").get(idempotencyKey);
  if (!row || row.id === undefined) {
    await tx.done;
    return;
  }
  await store.put({
    ...row,
    status: "failed",
    failureReason: reason,
    failureMessage: message,
    failureCode,
    lastAttemptAt,
    attemptCount: row.attemptCount + 1,
  });
  await tx.done;
}

// ---------------------------------------------------------------------------
// markWriteAttempt — bump attempt count on retryable error (5xx / network)
// ---------------------------------------------------------------------------

export async function markWriteAttempt(
  db: OfflineQueueDB,
  idempotencyKey: string,
  newStatus: Extract<PendingWriteStatus, "queued" | "syncing">,
  lastAttemptAt: string = new Date().toISOString(),
): Promise<void> {
  const tx = db.transaction("pending_writes", "readwrite");
  const store = tx.objectStore("pending_writes");
  const row = await store.index("by_idempotency_key").get(idempotencyKey);
  if (!row || row.id === undefined) {
    await tx.done;
    return;
  }
  await store.put({
    ...row,
    status: newStatus,
    lastAttemptAt,
    attemptCount: newStatus === "syncing" ? row.attemptCount + 1 : row.attemptCount,
  });
  await tx.done;
}

// ---------------------------------------------------------------------------
// retryFailedWrite — operator action from UX-SCREEN-230
// ---------------------------------------------------------------------------

/**
 * Re-queue a previously-failed write. Resets status to `queued` so the next
 * replay loop pass picks it up. Preserves the original `idempotencyKey` and
 * `queuedAt` (the timestamp PRD-FUNC-130's "later-timestamp wins" rule reads).
 *
 * Returns `false` if no failed write with that key exists (e.g., it was
 * already synced or discarded by another tab — concurrent safety).
 *
 * CR-DC-069 — the reset now includes `attemptCount` and `lastAttemptAt`, and that is the whole
 * difference between a retry that works and one that cannot:
 *
 *   · `attemptCount: 0` — the replay loop's first live check is
 *     `attemptCount >= MAX_ATTEMPTS_BEFORE_FAIL → failExhaustedWrite` (src/sw/replay-loop.ts).
 *     Without this reset, a row that hit the ceiling came straight back as `failed` / "Exceeded
 *     retry budget" on the very next pass, with ZERO server calls, and the operator's only remaining
 *     control was Discard — permanent deletion of work the tablet had already said was saved
 *     (against PRD-NFR-005 zero data loss). 🔴 The ceiling ITSELF is untouched: the ceiling is not
 *     the bug, the inability to reset it is.
 *   · `lastAttemptAt: null` — changes no behaviour (`checkBackoffSkip` returns early on
 *     `attemptCount <= 0`), but a row claiming "0 attempts, last attempted at 14:02" is a lie
 *     waiting to be read by the next person.
 *
 * ⚠ Consequence, stated plainly: the failed row's "N attempts" line in UX-SCREEN-230 counts
 * attempts SINCE THE LAST OPERATOR RETRY, not for all time. That is the correct meaning of a reset
 * budget; no lifetime counter is added (TD-069-01).
 *
 * 🔴 `idempotencyKey` is preserved, so a retry is the SAME write trying again and CR-DC-067's
 * server-side guard still answers a repeat with `200 …idempotent_replay` rather than a duplicate.
 * The `status !== "failed"` gate stays: a retry is an action on a failed row only.
 */
export async function retryFailedWrite(
  db: OfflineQueueDB,
  idempotencyKey: string,
): Promise<boolean> {
  const tx = db.transaction("pending_writes", "readwrite");
  const store = tx.objectStore("pending_writes");
  const row = await store.index("by_idempotency_key").get(idempotencyKey);
  if (!row || row.id === undefined || row.status !== "failed") {
    await tx.done;
    return false;
  }
  await store.put({
    ...row,
    status: "queued",
    failureReason: null,
    failureMessage: null,
    // CR-DC-069 — a genuine fresh budget, not a status flip that instantly re-fails.
    attemptCount: 0,
    lastAttemptAt: null,
  });
  await tx.done;
  return true;
}

// ---------------------------------------------------------------------------
// discardFailedWrite — operator action from UX-SCREEN-230
// ---------------------------------------------------------------------------

/**
 * Delete a failed write from the queue and record the operator's discard
 * reason in sync_history. The server-side audit-log entry for this operator
 * action is DEFERRED to EPIC-002-M001 per M007-DEC-007 (no auth surface
 * exists yet to attribute the action to a real user identity).
 */
export async function discardFailedWrite(
  db: OfflineQueueDB,
  idempotencyKey: string,
  discardReasonCode: DiscardReasonCode,
  discardReasonText: string | null,
  finalisedAt: string = new Date().toISOString(),
): Promise<boolean> {
  const tx = db.transaction(["pending_writes", "sync_history"], "readwrite");
  const pendingStore = tx.objectStore("pending_writes");
  const historyStore = tx.objectStore("sync_history");
  const row = await pendingStore.index("by_idempotency_key").get(idempotencyKey);
  if (!row || row.id === undefined || row.status !== "failed") {
    await tx.done;
    return false;
  }
  const historyRecord: SyncHistoryRecord = {
    idempotencyKey: row.idempotencyKey,
    outcome: "discarded",
    finalisedAt,
    method: row.method,
    url: row.url,
    discardReasonCode,
    discardReasonText,
  };
  await historyStore.add(historyRecord);
  await pendingStore.delete(row.id);
  await tx.done;
  return true;
}

// ---------------------------------------------------------------------------
// discardUnreplayableWrite — system cleanup of a write that can never sync
// ---------------------------------------------------------------------------

/**
 * Delete a pending write of ANY status (queued / syncing / failed) and record it in sync_history as
 * `discarded`. Unlike discardFailedWrite (an operator action gated to `failed` rows), this is a SYSTEM
 * cleanup for a write that is categorically un-replayable — specifically a queued cross-origin request
 * that should never have entered the queue (e.g. a QC photo PUT to a Supabase signed URL captured before
 * the EPIC-003-M002 REV-9 service-worker same-origin guard landed). Retrying it forever leaves the tablet
 * stuck "syncing", so the replay loop discards it instead. Self-heals tablets carrying such entries.
 */
export async function discardUnreplayableWrite(
  db: OfflineQueueDB,
  idempotencyKey: string,
  finalisedAt: string = new Date().toISOString(),
): Promise<boolean> {
  const tx = db.transaction(["pending_writes", "sync_history"], "readwrite");
  const pendingStore = tx.objectStore("pending_writes");
  const historyStore = tx.objectStore("sync_history");
  const row = await pendingStore.index("by_idempotency_key").get(idempotencyKey);
  if (!row || row.id === undefined) {
    await tx.done;
    return false;
  }
  const historyRecord: SyncHistoryRecord = {
    idempotencyKey: row.idempotencyKey,
    outcome: "discarded",
    finalisedAt,
    method: row.method,
    url: row.url,
    discardReasonCode: "OTHER",
    discardReasonText: "Removed automatically — not a same-origin API write (could never sync).",
  };
  await historyStore.add(historyRecord);
  await pendingStore.delete(row.id);
  await tx.done;
  return true;
}

// ---------------------------------------------------------------------------
// read-side queries — used by replay loop + UX-SCREEN-230 + useSyncStatus
// ---------------------------------------------------------------------------

/**
 * Every pending write in save order — the replay-loop iteration target and the UX-SCREEN-230 list
 * source. `queued` and `syncing` rows come first, `failed` rows last; within a group, by `queuedAt`,
 * and by the auto-increment `id` when two rows share a millisecond.
 *
 * 🔴 CR-DC-267 — `queued` AND `syncing` SHARE ONE RANK. They used to rank 0 and 1, so a row left
 * `syncing` by a killed worker (it was mid-send, so it is the EARLIEST thing in flight) was retried
 * AFTER every later `queued` row: the same order inversion as the backoff skip, by another route.
 */
export async function getPendingWrites(db: OfflineQueueDB): Promise<PendingWriteRecord[]> {
  const tx = db.transaction("pending_writes", "readonly");
  const all = await tx.objectStore("pending_writes").index("by_queued_at").getAll();
  await tx.done;

  const statusOrder: Record<PendingWriteStatus, number> = {
    queued: 0,
    syncing: 0,
    failed: 1,
    synced: 2, // synced rows don't typically appear here (they move to history) but defend.
  };
  return all.sort(
    (a, b) =>
      statusOrder[a.status] - statusOrder[b.status] ||
      a.queuedAt.localeCompare(b.queuedAt) ||
      (a.id ?? 0) - (b.id ?? 0),
  );
}

/**
 * CR-DC-267 — is any work saved earlier than "now" still waiting on this device? `queued` and `syncing`
 * rows count; `failed` rows (refused — they wait for a person, not for time) and pre-update rows (never
 * sent by design) do not, for the same reason they never hold back a replay pass.
 */
export async function hasEarlierWaitingWork(db: OfflineQueueDB): Promise<boolean> {
  const all = await getPendingWrites(db);
  return all.some(
    (row) => (row.status === "queued" || row.status === "syncing") && !isPreUpdateRow(row),
  );
}

/**
 * Subset filtered to the operator-actionable `failed` rows for UX-SCREEN-230.
 */
export async function getFailedWrites(db: OfflineQueueDB): Promise<PendingWriteRecord[]> {
  const tx = db.transaction("pending_writes", "readonly");
  const all = await tx.objectStore("pending_writes").index("by_status").getAll("failed");
  await tx.done;
  return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/**
 * CR-DC-068 — the writes that are waiting but CANNOT be sent under the session now held: either
 * nobody is signed in, or the person signed in is not the one who captured them.
 *
 * These are the "Held" rows of UX-SCREEN-230. They are ordinary `queued` rows — nothing about them
 * is failed, and nothing about them is lost. They send themselves the moment the right operator taps
 * back in at the right station, and they are never sent under anyone else.
 *
 * `failed` rows are excluded: those already have their own section and their own two actions.
 */
export async function getHeldWrites(
  db: OfflineQueueDB,
  session: WriteIdentity | null,
): Promise<PendingWriteRecord[]> {
  const all = await getPendingWrites(db);
  return all.filter(
    (row) =>
      row.status !== "failed" && row.status !== "synced" && !writeBelongsToSession(row, session),
  );
}

/**
 * CR-DC-068 — clear a HELD write: the only way one ever leaves the queue other than being sent by
 * the person who captured it.
 *
 * Refuses unless the row is genuinely held — a row that belongs to the CURRENT session is waiting
 * work, not stranded work, and this door must never delete it. Refuses a `failed` row too; those go
 * through discardFailedWrite.
 *
 * The reason is mandatory at the UI and is recorded in `sync_history` along with WHO captured the
 * work that was cleared, so the history says who lost what. There is deliberately no counterpart
 * that SENDS a held write under the current session — that button does not exist and none is added.
 */
export async function clearHeldWrite(
  db: OfflineQueueDB,
  idempotencyKey: string,
  discardReasonCode: DiscardReasonCode,
  discardReasonText: string | null,
  session: WriteIdentity | null,
  finalisedAt: string = new Date().toISOString(),
): Promise<boolean> {
  const tx = db.transaction(["pending_writes", "sync_history"], "readwrite");
  const pendingStore = tx.objectStore("pending_writes");
  const historyStore = tx.objectStore("sync_history");
  const row = await pendingStore.index("by_idempotency_key").get(idempotencyKey);
  if (
    !row ||
    row.id === undefined ||
    row.status === "failed" ||
    row.status === "synced" ||
    writeBelongsToSession(row, session)
  ) {
    await tx.done;
    return false;
  }
  const capturedBy = row.operatorId === null ? "identity unknown" : `operator ${row.operatorId}`;
  const typed = discardReasonText === null ? "" : discardReasonText.trim();
  const historyRecord: SyncHistoryRecord = {
    idempotencyKey: row.idempotencyKey,
    outcome: "discarded",
    finalisedAt,
    method: row.method,
    url: row.url,
    discardReasonCode,
    discardReasonText:
      typed.length === 0
        ? `Held write cleared — captured by ${capturedBy}.`
        : `${typed} — captured by ${capturedBy}.`,
  };
  await historyStore.add(historyRecord);
  await pendingStore.delete(row.id);
  await tx.done;
  return true;
}

/**
 * The most recent `limit` history entries for the UX-SCREEN-230 history pane.
 * Sorted by finalisedAt descending.
 *
 * CR-DC-070 — SAME signature, SAME ordering semantics, BOUNDED read. It used to `getAll()` the
 * entire `sync_history` store, sort the lot in JS and slice twenty, on every `SYNC_STATUS_REQUEST`
 * and after every replay batch — and the chip that fires those requests is mounted on every tablet
 * screen. So the cost of showing "Online" grew with every write the station had ever made. The
 * `by_finalised_at` index existed all along and was used only to read everything in key order; now a
 * reverse cursor takes the rows that are actually returned and stops.
 *
 * Ordering is unchanged in every case that matters: `finalisedAt` is always `new Date().toISOString()`
 * (UTC `Z`), so the index's key order IS the order the old `localeCompare` sort produced. ⚠ ONE
 * deliberate difference, stated so that a tie is never mistaken for a regression: for rows sharing an
 * IDENTICAL `finalisedAt` the tie order flips (index-descending rather than insertion order).
 */
export async function getRecentHistory(
  db: OfflineQueueDB,
  limit = 20,
): Promise<SyncHistoryRecord[]> {
  const rows: SyncHistoryRecord[] = [];
  if (limit <= 0) return rows;
  const tx = db.transaction("sync_history", "readonly");
  let cursor = await tx
    .objectStore("sync_history")
    .index("by_finalised_at")
    .openCursor(null, "prev");
  while (cursor !== null) {
    rows.push(cursor.value);
    if (rows.length >= limit) break;
    cursor = await cursor.continue();
  }
  await tx.done;
  return rows;
}

// ---------------------------------------------------------------------------
// CR-DC-070 — sync_history retention
// ---------------------------------------------------------------------------

/**
 * How many `synced` history rows a tablet keeps. Ten times the twenty the snapshot publishes;
 * roughly a busy station's shift and a half; ~40 KB at ~200 bytes a row.
 *
 * ⚠ A HOUSEKEEPING BOUND, NOT A BUSINESS THRESHOLD. Nothing downstream reads it, no report is
 * derived from it, and no compliance obligation attaches to it — the ≥ 5-year audit retention
 * (CLAUDE.md, D-038, HACCP / GlobalGAP) attaches to `public.audit_log` on the server, which is where
 * the record of a synced write actually lives.
 */
export const SYNCED_HISTORY_RETENTION = 200;

/**
 * CR-DC-070 — delete `synced` history beyond the retention bound. Returns the number of rows deleted.
 *
 * The `sync_history` store was documented as "bounded growth — pruned by retention policy at
 * EPIC-002+ (deferred — M007 is unbounded)" and that deferral was never discharged: every synced and
 * every discarded write appended a row, forever, on a station tablet that is never reinstalled.
 * This is that policy.
 *
 * 🔴 D-1 — THE TWO OUTCOMES ARE NOT PRUNED ON THE SAME RULE, AND THAT IS THE WHOLE DECISION:
 *
 *   · `outcome === "synced"` → PRUNABLE. The write reached the server, whose route handler wrote the
 *     attributed `audit_log` row. This local row holds strictly LESS than the server already holds
 *     (a method, a URL and a time — never the body), so deleting it destroys no record. It must be
 *     prunable: a tablet can be dropped in a cold room and replaced on any given morning, so a
 *     device's IndexedDB was never where a five-year obligation could live.
 *
 *   · `outcome === "discarded"` → NEVER DELETED BY PRUNING. At any age, at any count. A discard is an
 *     operator's decision to abandon work that NEVER REACHED THE SERVER, so the server has never
 *     heard of it and holds nothing to fall back on. `POST /api/audit/queue-action` exists but NO
 *     CLIENT CALLS IT (verified at build: the route file is its only occurrence in `src/**`,
 *     `app/**` and `tests/**`) — the M007-DEC-007 deferral was marked closed on the strength of the
 *     endpoint existing, and the door nobody walks through is not a record. So this row is the SOLE
 *     evidence the work existed and was abandoned, together with the operator's typed reason. It is
 *     also a promise printed on the screen: the clear-held-write confirmation in SyncStatusDetail
 *     tells the operator "This is kept. Your reason, the station, the time … are all recorded on this
 *     tablet's history." Pruning these on the synced rule would make that sentence false.
 *     ▶ Closing that gap properly is TD-070-03; it is deliberately NOT this change.
 *
 * A discarded row is neither counted toward the bound nor eligible for deletion — the `continue`
 * below sits BEFORE the counter, and a test fences it (`history-retention.test.ts`).
 *
 * 🔴 WHAT THIS FUNCTION STRUCTURALLY CANNOT DO: touch un-sent work. `pending_writes` is not in the
 * transaction's scope at all, so no edit to this body can ever delete a queued, syncing or failed
 * row. Un-sent work is never housekeeping.
 *
 * 🔴 NO SCHEMA CHANGE. Deletion is row-by-row inside the existing store: no `createObjectStore`, no
 * `deleteObjectStore`, no new index, and `DB_VERSION` stays 2 (schema.ts's own additive-only rule).
 *
 * ⚠ A count, not a number of days — deliberately. A count is deterministic and testable, and needs no
 * date arithmetic on a device whose clock may be wrong or in the wrong zone (this estate has paid
 * three times for deriving a day in the wrong zone). `finalisedAt` is read ONLY as an ordering key,
 * which is exactly what the `by_finalised_at` index gives us, so this rule cannot acquire that bug.
 */
export async function pruneSyncHistory(
  db: OfflineQueueDB,
  keep: number = SYNCED_HISTORY_RETENTION,
): Promise<number> {
  const tx = db.transaction("sync_history", "readwrite");
  let cursor = await tx
    .objectStore("sync_history")
    .index("by_finalised_at")
    .openCursor(null, "prev");
  let kept = 0;
  let deleted = 0;
  while (cursor !== null) {
    // 🔴 D-1. BEFORE the counter, on purpose: a discarded row is neither counted toward the bound nor
    // eligible for deletion. Moving this line below `kept += 1` would start deleting the OLDEST
    // synced rows to make room for rows that are never deleted anyway (proved by mutation — the
    // "does not count discarded rows toward the retention bound" spec reddens); deleting it outright
    // would destroy the only evidence those discarded writes ever existed (three specs redden).
    if (cursor.value.outcome === "discarded") {
      cursor = await cursor.continue();
      continue;
    }
    kept += 1;
    if (kept > keep) {
      await cursor.delete();
      deleted += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

/**
 * Pending-writes count for the live `useSyncStatus()` hook on the tablet shell.
 * `queued` + `syncing` + `failed` all count as "not yet reconciled".
 */
export async function countPendingWrites(db: OfflineQueueDB): Promise<number> {
  const tx = db.transaction("pending_writes", "readonly");
  const count = await tx.objectStore("pending_writes").count();
  await tx.done;
  return count;
}
