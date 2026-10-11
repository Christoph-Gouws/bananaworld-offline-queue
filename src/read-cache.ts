// CR-DC-088 — the DEVICE-SIDE COPY OF THE DRIVER'S READS, so a driver in a dead zone can open the
// run, open a stop and capture a signature instead of falling back to paper.
//
// Anchors: CR-DC-088 (§3), PRD-NFR-005 (a ten-minute outage is survivable), TECH-COMP-006,
//          SEC-AUTH-013 (the session lives in the service worker and nowhere else),
//          CR-DC-068 (the identity discipline this copies), CR-DC-070 (the quota that runs out).
//
// ============================================================================
// 🔴 THE WRITE HALF ALREADY WORKED; THE READ HALF IS WHY IT WAS UNREACHABLE
// ============================================================================
// The offline write queue has carried a tablet write since M007 — the confirm, the crates and the
// return all queue and answer 202. But the driver could never GET to the screen that makes one: every
// driver-station GET went straight to the network, so with no signal `getStop` resolved
// `status: 0` and the wizard showed "No signal". The offline write was real and unreachable.
//
// ============================================================================
// 🔴 THE KEY IS THE CONTROL; THE SIGN-OUT CLEAR IS THE TIDY-UP
// ============================================================================
// The primary key CONTAINS the session identity triple (warehouse + station + operator), so a lookup
// performed under operator B's session simply MISSES operator A's rows — there is no row for B's key
// to find. `clearDriverReads` on sign-out removes them as well, but the correctness of this module
// does not depend on that clear having run. Exactly the discipline `writeBelongsToSession` states for
// queued writes (CR-DC-068: "the backfill is tidiness, this comparison is the control").
//
// 🔴 FAIL-CLOSED ON AN INCOMPLETE IDENTITY. `StationSession.operatorId` is `string | null` — a session
//    stored by an older build carries none. With any of the three missing: DO NOT CACHE, AND DO NOT
//    SERVE. A cached authenticated read handed to the wrong PIN session is a worse defect than the one
//    being fixed, and two unknowns must never cancel into a match.
//
// ============================================================================
// 🔴 THE READ CACHE CAN NEVER STARVE THE WRITE QUEUE (addendum A)
// ============================================================================
// The read store and `pending_writes` share ONE origin storage quota, and CR-DC-070 exists precisely
// because that quota already runs out in practice: a full device answers a tablet write with 507 and
// tells the operator their entry was NOT saved. A read cache that fills a tablet in order to help a
// driver work offline — and thereby stops that same driver's proof of delivery being saved at all —
// is a strictly worse system than the one being fixed. Four independent guards:
//
//   1. SCOPE. Every transaction below names `driver_reads` AND NOTHING ELSE. No edit to the eviction
//      body can reach `pending_writes`, whatever it does. (The structural argument `pruneSyncHistory`
//      makes about un-sent work, applied here.)
//   2. THE BOUND, enforced on every write to the store — see the two constants.
//   3. 🔴 A READ THAT CANNOT BE CACHED IS DROPPED, SILENTLY. On a quota refusal `cacheDriverRead`
//      prunes the read store down to half the ceiling — which FREES space for writes — does NOT retry
//      the put, and never rethrows. A degraded offline experience beats lost work.
//   4. ORDERING. Nothing in this file is reachable from the write path. `handleTabletWrite`,
//      `enqueueWrite`, the backoff, the attempt ceiling and CR-DC-068's session gate are untouched.

import { isQuotaError } from "./queue";
import type { DriverReadRecord, OfflineQueueDB } from "./schema";

// CR-DC-227 — THIS FILE MOVED FROM THE DC (`src/lib/offline-queue/driver-reads.ts`) INTO THE PACKAGE.
// The MECHANISM — keying, the two bounds, the quota-refusal drop, the oldest-first prune — is the
// package's and is byte-for-byte what it was. Two things that name the DC's own routes are NOT here:
//
//   · WHICH PATHS ARE CACHED (`isDriverStationReadPath` — exact, never a prefix). That is an app's
//     route list, so it is the setting `QueueWorkerSettings.isCachedReadPath` and stays in the DC.
//   · WHICH ROW THE PRUNE HOLDS BACK (the newest run-list row). That is also an app's path, so it is
//     the setting `isProtectedReadPath`, bound once through `createReadCache` below.
//
// The store is still called `driver_reads` and its fields are still `warehouseId` / `stationId` /
// `operatorId`: they are the ON-DEVICE FORMAT, and renaming one would orphan what tablets hold
// (CR-DC-227 R-2, TD-227-01).

// ---------------------------------------------------------------------------
// the identity triple
// ---------------------------------------------------------------------------

/**
 * The session identity a cached read is keyed on. Deliberately its OWN type rather than
 * `StationSession`: nothing in this module may see the raw token (SEC-AUTH-013), and a narrower
 * parameter makes that a compile-time fact rather than a convention.
 */
export interface DriverReadIdentity {
  readonly warehouseId: string;
  readonly stationId: string;
  readonly operatorId: string;
}

/**
 * Narrow a station session to a COMPLETE identity, or null.
 *
 * 🔴 THE NULL IS THE CONTROL. Every caller treats null as "today's behaviour" — no cache write and no
 *    cache read — so a session missing any of the three can neither store a run nor be served one.
 */
export function driverReadIdentity(
  session: {
    readonly warehouseId?: string | null;
    readonly stationId?: string | null;
    readonly operatorId?: string | null;
  } | null,
): DriverReadIdentity | null {
  if (session === null) return null;
  const { warehouseId, stationId, operatorId } = session;
  if (typeof warehouseId !== "string" || warehouseId.length === 0) return null;
  if (typeof stationId !== "string" || stationId.length === 0) return null;
  if (typeof operatorId !== "string" || operatorId.length === 0) return null;
  return { warehouseId, stationId, operatorId };
}

/**
 * The primary key: the identity triple AND the path, in one string.
 *
 * ⚠ `|` as the separator because none of the four parts can contain one (two are uuids, one is a
 *   uuid, and the fourth is a URL pathname whose `|` would have been percent-encoded by the browser).
 */
export function driverReadKey(identity: DriverReadIdentity, path: string): string {
  return `${identity.warehouseId}|${identity.stationId}|${identity.operatorId}|${path}`;
}

// ---------------------------------------------------------------------------
// 🔴 the bound — addendum (A)
// ---------------------------------------------------------------------------

/**
 * ⚠ A HOUSEKEEPING BOUND, NOT A BUSINESS THRESHOLD — the same wording and the same reason as
 *   `SYNCED_HISTORY_RETENTION`. Nothing downstream reads either constant, no report derives from
 *   them, no compliance obligation attaches, and moving either changes only how much of a run
 *   survives a dead zone.
 *
 * 80 entries = 1 home + 2 per stop, i.e. a run of ~39 stops or two runs of ~19 — comfortably more
 * than a real day (a measured run is 7 stops = 15 entries). ⚠ CR-DC-201 — now 1 home + 1 per stop
 * (the crate plan's read is retired), so the same 80 hold ~79 stops; the bound is NOT raised.
 *
 * 1 MiB is the number that matters, and the JUSTIFICATION IS THE COMPARISON, not the round number:
 * a confirm plan is single-digit KB of JSON and a whole day's reads land in the low hundreds of KB,
 * while ONE queued POD (a base-64 signature plus an optional photo) is 0.1–0.3 MB
 * (`fileToJpegDataUrl`, DeliveryConfirmation.tsx). So the entire read store is bounded at roughly the
 * size of four queued proofs of delivery.
 *
 * Both are enforced on every write; whichever bites first wins.
 *
 * ⚠ REVISION 2 — OPEN QUESTION 1, ANSWERED AS FAR AS THIS ENVIRONMENT HONESTLY CAN, AND NO FURTHER.
 *   The three payloads were MODELLED from the shipped types (`StopConfirmationPlan`, the run list,
 *   `StopCratePlan`) with realistic labels and counts, NOT captured from a real run — no live depot
 *   data is reachable from a build session, and rounding a model up into "measured" is exactly the
 *   sort of claim this estate has been burned by. Method and figures:
 *   `runs/change-89/output/implementation-summary.md`.
 *
 *     · a 25-stop day, 8 lines a stop  ≈ 101 KB   (≈ 10% of the ceiling)
 *     · a pessimistic 40-stop day, 25 lines a stop ≈ 366 KB
 *
 *   So `DRIVER_READ_MAX_ENTRIES` bites first in every modelled case and the byte ceiling is the
 *   backstop it was meant to be. THE CEILING STAYS.
 *
 *   ⚠ CR-DC-201 (OQ-4) — RE-MODELLED, AGAIN NOT MEASURED. The stop read now carries the crate block:
 *   ≈ 3.9 KB more per stop at 8 lines / 3 crate types, ≈ 10 KB at 25 lines / 5 types — while the crate
 *   plan's own read (one entry per stop) is retired. The pessimistic 40-stop day is then ≈ 0.77 MB of
 *   the 1 MiB ceiling in 41 of the 80 entries: inside both bounds, so nothing is trimmed. The real bodies are captured at device
 *   verification step 2 (`user-verification-steps.md`), which is where a number worth calling
 *   measured comes from.
 */
export const DRIVER_READ_MAX_ENTRIES = 80;
export const DRIVER_READ_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// store — read
// ---------------------------------------------------------------------------

/**
 * The cached body for this session + path, or null.
 *
 * Returns null rather than throwing on ANY failure: the one caller is the service worker's
 * catch branch, which re-throws the original network rejection on a miss (so CR-DC-086's honest
 * "No signal" is what the driver sees). A store that cannot be read is a miss.
 */
export async function readCachedDriverRead(
  db: OfflineQueueDB,
  identity: DriverReadIdentity | null,
  path: string,
): Promise<DriverReadRecord | null> {
  if (identity === null) return null; // fail-closed — see the header
  try {
    const hit = await db.get("driver_reads", driverReadKey(identity, path));
    return hit ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// store — write
// ---------------------------------------------------------------------------

/**
 * Store a successful driver-station read for this session.
 *
 * 🔴 NEVER THROWS, ON ANY BRANCH. The caller hands this to `event.waitUntil` and returns the live
 *    response to the page without awaiting it; a rejection escaping here would surface as an
 *    unhandled rejection in the worker on the one screen the driver most needs to work.
 *
 * 🔴 ON A QUOTA REFUSAL THE READ IS DROPPED AND THE STORE IS PRUNED — addendum (A) guard 3. The put
 *    is NOT retried: a read that cannot be cached costs the driver a degraded offline experience,
 *    whereas a write that cannot be queued is lost work, and the prune frees space for the latter.
 *    `isQuotaError` is imported, never re-derived — one definition of "the device is full"
 *    (CR-DC-070), so a ConstraintError can never be mistaken for one here either.
 */
async function cacheDriverReadImpl(
  isProtectedReadPath: (path: string) => boolean,
  db: OfflineQueueDB,
  identity: DriverReadIdentity | null,
  path: string,
  body: string,
  now: Date,
): Promise<void> {
  if (identity === null) return; // fail-closed — see the header
  const record: DriverReadRecord = {
    key: driverReadKey(identity, path),
    warehouseId: identity.warehouseId,
    stationId: identity.stationId,
    operatorId: identity.operatorId,
    path,
    body,
    storedAt: now.toISOString(),
    bytes: body.length,
  };
  try {
    // ⚠ NAMES `driver_reads` AND NOTHING ELSE — addendum (A) guard 1.
    const tx = db.transaction("driver_reads", "readwrite");
    await tx.store.put(record);
    await tx.done;
  } catch (err) {
    if (isQuotaError(err)) {
      // Free space for the WRITE queue, then give up on this read. No retry, no rethrow.
      await pruneDriverReadsImpl(
        isProtectedReadPath,
        db,
        Math.floor(DRIVER_READ_MAX_ENTRIES / 2),
        Math.floor(DRIVER_READ_MAX_BYTES / 2),
      );
    }
    return;
  }
  await pruneDriverReadsImpl(
    isProtectedReadPath,
    db,
    DRIVER_READ_MAX_ENTRIES,
    DRIVER_READ_MAX_BYTES,
  );
}

/**
 * Evict OLDEST ENTRY FIRST, by `storedAt`, until the store is inside both bounds — EXCEPT the newest
 * run-list row, which is the last thing to go rather than the first.
 *
 * ⚠ OLDEST-ENTRY-FIRST *IS* OLDEST-RUN-FIRST, and it is stated this way rather than by inventing a
 *   run key because a cached payload does not reliably carry one (the crate plan did not; it is
 *   retired at CR-DC-201, and the rule is kept rather than re-argued). A
 *   run is prefetched in one burst, so its entries share a timestamp window and leave together.
 *
 * 🔴 CR-DC-101 (F2) — THE SAME DEFECT AS THE NAVIGATION CACHE'S, IN THE OTHER STORE, AND FIXED THE
 *    SAME WAY. `/api/driver-station/home` is written FIRST in every prefetch pass (`prefetchRun`
 *    walks the stops only after `myRun()` resolves), and this loop evicted oldest-`storedAt` first —
 *    so at ≥ 40 stops the 80-entry ceiling bit and the run list was the FIRST row deleted. The tablet
 *    then held every stop's data and could not open the run to reach any of it: the home page renders
 *    `StationTakeover` — "Could not load your run." — with the stops sitting right there in IndexedDB.
 *
 * 🔴 THE NEWEST HOME ROW, NOT EVERY HOME ROW. Rows are keyed on the identity triple
 *    (warehouse + station + operator), so a tablet that has not been signed out can hold an EARLIER
 *    operator's home row as well. Protecting every home row would pin rows nobody can ever be served
 *    — their key cannot match the live session — which is a leak, not a fix. Exactly one row is
 *    protected, and `by_stored_at` is ascending so the LAST home row in this list is the newest one.
 *
 * ⚠ BOTH CEILINGS STILL BITE. The entry ceiling and the 1 MiB byte ceiling are unchanged and the loop
 *   still runs to both; a home body is single-digit KB, so protecting one row cannot defeat the byte
 *   ceiling. And a protected row is SKIPPED, not counted as deleted.
 *
 * ⚠ GUARD 1 IS UNTOUCHED: the transaction still names `driver_reads` and nothing else.
 *
 * Never throws — a prune that cannot run leaves the store as it was, which is bounded by the NEXT
 * successful write rather than unbounded.
 */
async function pruneDriverReadsImpl(
  isProtectedReadPath: (path: string) => boolean,
  db: OfflineQueueDB,
  maxEntries: number,
  maxBytes: number,
): Promise<number> {
  try {
    // ⚠ NAMES `driver_reads` AND NOTHING ELSE — addendum (A) guard 1.
    const tx = db.transaction("driver_reads", "readwrite");
    // `by_stored_at` yields ascending, so the oldest rows are at the front of this list.
    const rows = await tx.store.index("by_stored_at").getAll();
    // Ascending order ⇒ the LAST home row seen is the newest one. Null when the store holds none.
    let protectedKey: string | null = null;
    for (const row of rows) {
      if (isProtectedReadPath(row.path)) protectedKey = row.key;
    }
    let entries = rows.length;
    let bytes = rows.reduce((sum, r) => sum + r.bytes, 0);
    let deleted = 0;
    for (const row of rows) {
      if (entries <= maxEntries && bytes <= maxBytes) break;
      if (row.key === protectedKey) continue;
      await tx.store.delete(row.key);
      entries -= 1;
      bytes -= row.bytes;
      deleted += 1;
    }
    await tx.done;
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Drop every cached driver read. Called from the service worker's `CLEAR_SESSION_TOKEN` handler, so
 * it runs on sign-out AND on auto-logoff — the one door both go through
 * (`session-client.ts` → `askServiceWorker({ type: "CLEAR_SESSION_TOKEN" })`).
 *
 * This is ALSO what stops yesterday's run surviving into today: a PIN session is capped at 16 hours
 * (CR-DC-071) and every end of one comes through here.
 *
 * ⚠ CLEARS THE WHOLE STORE, not just the departing session's rows. A tablet re-paired to another
 *   depot would otherwise carry the previous depot's run until the bound evicted it, and there is
 *   nothing in a read worth keeping across a sign-out.
 */
export async function clearDriverReads(db: OfflineQueueDB): Promise<void> {
  try {
    // ⚠ NAMES `driver_reads` AND NOTHING ELSE — addendum (A) guard 1.
    const tx = db.transaction("driver_reads", "readwrite");
    await tx.store.clear();
    await tx.done;
  } catch {
    // A clear that could not run is not worth failing a sign-out over: the key still fails to match
    // the next operator's session (the control), and the next successful clear removes the rows.
  }
}

// ---------------------------------------------------------------------------
// the two functions that need the app's setting
// ---------------------------------------------------------------------------

export interface ReadCacheSettings {
  /**
   * The ONE path whose newest row the prune holds back — the run list, the read a driver cannot get
   * into the run without (CR-DC-101 F2). Required, with no default: a forgotten setting is a type
   * error rather than a silent loss of that protection.
   */
  readonly isProtectedReadPath: (path: string) => boolean;
}

export interface ReadCache {
  /** Store a successful read for this session. Never throws — see `cacheDriverReadImpl`. */
  cacheDriverRead(
    db: OfflineQueueDB,
    identity: DriverReadIdentity | null,
    path: string,
    body: string,
    now?: Date,
  ): Promise<void>;
  /** Evict oldest-first until inside both bounds, holding back the newest protected row. */
  pruneDriverReads(db: OfflineQueueDB, maxEntries?: number, maxBytes?: number): Promise<number>;
}

export function createReadCache(settings: ReadCacheSettings): ReadCache {
  const { isProtectedReadPath } = settings;
  return {
    cacheDriverRead: (db, identity, path, body, now = new Date()) =>
      cacheDriverReadImpl(isProtectedReadPath, db, identity, path, body, now),
    pruneDriverReads: (
      db,
      maxEntries = DRIVER_READ_MAX_ENTRIES,
      maxBytes = DRIVER_READ_MAX_BYTES,
    ) => pruneDriverReadsImpl(isProtectedReadPath, db, maxEntries, maxBytes),
  };
}
