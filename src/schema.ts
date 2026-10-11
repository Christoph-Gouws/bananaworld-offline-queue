// IndexedDB schema for the Bananaworld-DC offline write queue (TECH-COMP-006).
//
// Anchors: PRD-CAP-023, PRD-FUNC-127..130, TECH-ADR-005, TECH-FE-002, TECH-FE-010,
//          TECH-BE-010, SEC-AUTH-013, PRD-NFR-005, PRD-NFR-006.
//
// Per M007-DEC-002 — uses `idb` (^8) as the typed Promise-based wrapper around
// native IndexedDB. The four object stores are:
//
//   - `pending_writes`     — every tablet-flow write whose replay has not yet
//                            completed (status ∈ queued / syncing / failed).
//   - `sync_history`       — outcomes of completed replays (status = synced or
//                            discarded). Bounded growth — pruned by retention
//                            policy at EPIC-002+ (deferred — M007 is unbounded).
//   - `session_token`      — singleton store (key = "current") for the SW-only
//                            session token per SEC-AUTH-013. Token never leaves
//                            the SW boundary; page reads return only a boolean.
//   - `driver_reads`       — CR-DC-088: the device-side copy of the driver's three
//                            station GETs, keyed on the session identity triple +
//                            the path, so a driver in a dead zone can still open
//                            the run and the stop. Bounded (see driver-reads.ts).
//
// Schema version 1 at M007; version 2 at CR-DC-068 (operator + station identity on
// `pending_writes`); version 3 at CR-DC-088 (the `driver_reads` store); version 4 at CR-DC-240
// (the `queue_maintenance` store). Future
// migrations go in the `idb.openDB` upgrade callback — keep them additive (add new
// stores / indexes, never drop or rename) per the same discipline as the Postgres
// migrations.
//
// 🔴 CR-DC-068 — NEVER `createObjectStore("pending_writes")` outside the `oldVersion < 1`
// branch, and never `deleteObjectStore`. Tablets in the field carry queued writes RIGHT NOW;
// recreating the store destroys precisely the data the identity fields exist to protect.
//
// 🔴 CR-DC-088 — `DB_VERSION` IS 3, AND A REVERT IS NOT FREE. A tablet that has opened the
// database at version 3 CANNOT open it at version 2 again: `indexedDB.open(name, 2)` against a
// version-3 store raises `VersionError`, `openOfflineQueueDB` rejects, `getDB()` in the SW entry
// rejects, and every tablet write dies. The estate already carries this rule for the 1 → 2 bump.
// THE MITIGATION IS A PROCEDURE, NOT A HOPE: if CR-DC-088 has to be backed out after a tablet has
// run it, the revert KEEPS `DB_VERSION` AT 3 AND THE `oldVersion < 3` BRANCH IN PLACE, and removes
// only the behaviour (the cache write, the serve, the prefetch, the banner).
//
// 🔴 CR-DC-240 — `DB_VERSION` IS NOW 4, AND THE SAME RULE APPLIES. A backout KEEPS `DB_VERSION` AT 4 AND
// THE `oldVersion < 4` BRANCH, and removes only the behaviour (the sweep, the report, the panel line).

import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type StoreNames,
  openDB,
} from "idb";

// CR-DC-227 — the database NAME is the app's (a setting: `QueueWorkerSettings.dbName`); the VERSION and
// everything inside the database is the format, and is the package's. Each app's origin gets its own
// store, so two apps naming theirs identically still cannot collide.
export const DB_VERSION = 4;

// CR-DC-240 — the generation stamp every row written by a FIXED worker carries. A row without it was
// written by a pre-fix worker, whose replay never reached a server (KI-227-01), and is cleared once
// rather than sent late. See `clearPreUpdateWrites` in pre-update-clear.ts.
export const REPLAY_GENERATION = 1;

// Status of a pending_writes row through its lifecycle.
//   - queued   → enqueued; awaiting first replay attempt (offline) or backoff window
//   - syncing  → an in-flight replay attempt against the network
//   - synced   → 2xx response received; moved to sync_history at next pruning
//   - failed   → server rejected with a 4xx (conflict / idempotency) — surfaced to
//                the operator via UX-SCREEN-230 for retry or discard
//
// Note: 5xx and network errors do NOT transition to `failed` — they stay `queued`
// and retry with exponential backoff per the replay loop (M007-SCOPE-004).
export type PendingWriteStatus = "queued" | "syncing" | "synced" | "failed";

// PRD-FUNC-130 deterministic conflict-resolution reason codes. Mirrors
// API-FAIL-007 `OFFLINE_QUEUE_SYNC_CONFLICT.details.reason` exactly.
export type ConflictReason =
  | "SERVER_MASTER_WINS"
  | "EARLIER_TIMESTAMP_LOSES"
  | "STATE_DOES_NOT_ALLOW"
  | "IDEMPOTENCY_CONFLICT" // 409 — same key, different payload (queue bug)
  | "UNKNOWN"; // 4xx returned without a recognised reason — surface verbatim

export interface PendingWriteRecord {
  // Auto-incrementing primary key; never displayed to operator.
  id?: number;
  // UUID v4 issued at enqueue per API-PRINCIPLE-008 / API-REQ-002. The SAME key
  // is reused across every replay attempt — that is the at-least-once safety
  // contract: the server resolves replay-with-same-key + same-payload → return
  // the original outcome (deduplication on the server side).
  idempotencyKey: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  // Headers are serialised as a plain object (the native Headers class is not
  // structured-clone-friendly across SW ↔ page postMessage boundaries).
  headers: Record<string, string>;
  // Body is preserved as a string (JSON-serialised payload) at enqueue time.
  // Binary uploads (photo attachments per PRD-CAP-026) are out of scope at M007
  // and route through Supabase Storage signed URLs directly per TECH-INT-009,
  // not through the queue.
  body: string | null;
  // ISO-8601 timestamp when the operator tapped Save. Used by PRD-FUNC-130's
  // "later-timestamp wins" rule on the server side; preserved through replay.
  queuedAt: string;
  lastAttemptAt: string | null;
  attemptCount: number;
  status: PendingWriteStatus;
  // Server-supplied rejection reason (only set when status = "failed").
  failureReason: ConflictReason | null;
  // The server's user-facing message from the 4xx body (UX-PRINCIPLE-010 plain
  // language). Rendered verbatim in UX-SCREEN-230 below the reason chip.
  failureMessage: string | null;
  // 🔴 CR-DC-109 — THE SERVER'S ERROR **CODE** FROM THE 4xx BODY, WHEN IT SENT ONE. Distinct from
  // `failureReason` above, which is the queue's own five-value `ConflictReason` enum and stays
  // "UNKNOWN" for every refusal outside PRD-FUNC-130's conflict vocabulary — a refusal that is
  // perfectly well identified by the route, just not by that enum. Without this field a page has
  // no way to tell a `PO_REFERENCE_IN_USE` from any other 4xx except by matching the message TEXT,
  // which is exactly the kind of coupling that breaks the first time the wording is improved.
  //
  // ⚠ OPTIONAL, AND THEREFORE **NO `DB_VERSION` BUMP** (it is 3 — see the header; a bump is not
  //   free and a revert of one is worse). IndexedDB stores whole objects: a new optional property
  //   needs no store, no index and no upgrade branch. A row written before this change simply
  //   reads `undefined`, which every consumer treats as "no code" — the same answer it would give
  //   for a body that carried none.
  failureCode?: string | null;
  // The warehouse_id the operator was authorised for at enqueue time. Carries
  // through replay to preserve M002's three-layer multi-DC isolation kernel.
  // Set to null if no session was active at enqueue (which would be a queue
  // misuse — flagged at Stage 04 testing).
  //
  // 🔴 CR-DC-068 — NEVER rewritten. A tablet re-paired to another depot produces rows whose
  // station and warehouse no longer match any live session; that is a HELD row for a human to
  // resolve, not a field to overwrite.
  warehouseId: string | null;
  // CR-DC-068 — the identity triple (with warehouseId above) that a replay must match before the
  // write is sent. Captured at enqueue from the SW-held session; compared at replay against the
  // session held THEN. Without it a queued write replays under whoever is signed in at the time and
  // is audit-logged as their work — against CLAUDE.md's "attributable to user + station + timestamp
  // + warehouse_id" and D-038 (HACCP / GlobalGAP, retention >= 5 years).
  //
  // `null` on both means "identity unknown": either a row queued under schema version 1 (backfilled
  // by the v2 upgrade below) or a row enqueued with no active session. The comparison is fail-closed
  // on null, so such a row can never match a live session and is held for a human.
  //
  // 🔴 The picked room of a Global Station is deliberately NOT part of this triple. It dies at logoff
  // (`clearPickedRoom`), so folding it in would hold every global-station write forever — on exactly
  // the tablet this change most needed to protect. It already rides in the request BODY, frozen at
  // Save. See the logic plan §1.5.1.
  operatorId: string | null;
  stationId: string | null;
  // 🔴 CR-DC-240 — stamped by `enqueueWrite` with REPLAY_GENERATION. ABSENT = written by a worker whose
  // replay could never send (KI-227-01), so the row is cleared once and never replayed. OPTIONAL, so no
  // index and no upgrade step is needed for it (the same precedent as `failureCode`).
  replayGeneration?: number;
}

// The shape a `pending_writes` row has BEFORE the version-2 upgrade: no identity fields at all.
// Used only by the upgrade branch, so the backfill reads honest types rather than pretending the
// new fields were always there.
export type LegacyPendingWriteRecordV1 = Omit<PendingWriteRecord, "operatorId" | "stationId"> & {
  operatorId?: string | null;
  stationId?: string | null;
};

export interface SyncHistoryRecord {
  id?: number;
  idempotencyKey: string;
  // Status this row landed in: synced (2xx) or discarded (operator chose).
  outcome: "synced" | "discarded";
  // ISO-8601 when the outcome was finalised.
  finalisedAt: string;
  // The original method + url so the history list can render meaningful entries
  // (operators don't read IDs; they read "Item Receipt: Post" — the underlying
  // entity name comes from the URL via a per-route lookup at render time).
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  // Operator-chosen discard reason if outcome = "discarded" (M007 enum below).
  // Free-form text only if `discardReasonCode === "OTHER"`.
  discardReasonCode: DiscardReasonCode | null;
  discardReasonText: string | null;
}

// Operator's discard-reason enum from UX-SCREEN-230 per UX-PRINCIPLE-010.
// Plain language; deliberately short so cold-room glove tapping is reliable.
// The first four belong to a FAILED write (the server rejected it); the two CR-DC-068 members
// belong to a HELD one (nobody has rejected it — the person who captured it has not come back).
// Additive: no existing member changes meaning, and `sync_history` rows written before CR-DC-068
// still read exactly as they did.
export type DiscardReasonCode =
  | "OPERATOR_OBSOLETED" // "I no longer need this write"
  | "DATA_WAS_WRONG" // "I made a mistake; the data was incorrect"
  | "SERVER_RESOLUTION_OK" // "The server's rejection reason is acceptable"
  | "HELD_RE_ENTERED" // CR-DC-068 — "It has already been entered again"
  | "HELD_OPERATOR_GONE" // CR-DC-068 — "The person has left and it is no longer needed"
  | "OTHER"; // captured in discardReasonText

export interface SessionTokenRecord {
  // Singleton; primary key is always the literal "current".
  id: "current";
  // The raw bearer token. NEVER returned across the SW ↔ page boundary; only
  // accessed inside the SW for outbound replay request injection.
  token: string;
  expiresAt: string; // ISO-8601
  warehouseId: string;
  stationId: string;
  // CR-DC-068 — the operator this session belongs to, so a replay can refuse to send another
  // person's queued work under it. An operator id is NOT a credential (it already lives in
  // localStorage via `storeSessionDisplay`); the raw token above still never leaves the SW.
  // Optional because a session stored by an older app build carries no operator — such a session
  // matches no row's identity, which is the fail-closed behaviour we want.
  operatorId?: string | null;
  // ISO-8601 when this token was stored (audit trail surrogate; SW token writes
  // are themselves audit-logged by the server's auth flow when EPIC-002 wires).
  //
  // 🔴 CR-DC-071 — THIS IS ALSO THE CAP ANCHOR, AND A RENEWAL MUST NOT OVERWRITE IT. It already
  // equals PIN sign-in time, which is exactly what the absolute session cap (D-2) is measured from.
  // `renewStoredSession` replaces `token` + `expiresAt` and touches nothing else, which is why this
  // change needs no new IndexedDB field for the cap and no `DB_VERSION` bump.
  storedAt: string;
  // CR-DC-071 — when the operator last DID something (the shared `ACTIVITY_EVENTS` list, reported by
  // <SessionKeepalive /> over the payload-free SESSION_ACTIVITY message). The service worker refuses
  // to attach a token whose last action is older than the window; that refusal is what stops the
  // offline grace on the token's expiry becoming a security hole.
  //
  // Optional: a session stored by an older app build has none, and `isSessionIdle` reads that as
  // "not idle" rather than "idle forever". Deliberate, and safe for a specific reason — such a token
  // was minted under the OLD rule (`login + auto_logoff_minutes`, no grace), so it carries its own
  // short absolute lifetime and self-limits without this field.
  lastActivityAt?: string;
  // CR-DC-071 — the station's inactivity window, so the worker can decide "is this session idle?"
  // and "is a renewal due?" without a network call or a second source of truth. NOT a credential: it
  // is a station configuration number that already lives in localStorage via `storeSessionDisplay`.
  autoLogoffMinutes?: number;
}

/**
 * CR-DC-088 — one cached driver-station GET response.
 *
 * 🔴 THE PRIMARY KEY CONTAINS THE SESSION IDENTITY TRIPLE. That is the control, not a convenience:
 *    a lookup performed under operator B's session simply MISSES operator A's rows, so a cached
 *    authenticated read cannot be served to the wrong PIN session even if the sign-out clear never
 *    ran. The same discipline `writeBelongsToSession` states for queued writes (CR-DC-068).
 *
 * The three identity fields are also stored individually — the key is a string, and a row a human is
 * reading in devtools should not need the separator convention decoded to be understood.
 */
export interface DriverReadRecord {
  // `${warehouseId}|${stationId}|${operatorId}|${path}` — see `driverReadKey`.
  key: string;
  warehouseId: string;
  stationId: string;
  operatorId: string;
  // Pathname only; the three cached reads carry no query string.
  path: string;
  // The response body verbatim, as text. Re-served with `X-Offline-Snapshot: true`.
  body: string;
  // ISO-8601 — the "as of" time the driver is shown, and the eviction order.
  storedAt: string;
  // `body.length`, so the byte ceiling is checked without re-measuring every row.
  bytes: number;
}

export const PRE_UPDATE_CLEAR_ID = "pre-update-clear-ki-227-01";

/**
 * CR-DC-240 — what the pre-update clear removed, per row. 🔴 NO request body and NO headers are ever
 * copied here (owner ruling): a body carries business data, a header can carry a credential-adjacent
 * value.
 */
export interface PreUpdateClearedRow {
  idempotencyKey: string;
  method: PendingWriteRecord["method"];
  // `new URL(row.url).pathname` — no origin, no query.
  path: string;
  queuedAt: string;
  status: "queued" | "syncing" | "failed";
  // Who captured it (UUIDs, never names); null when the row carried no identity.
  operatorId: string | null;
  stationId: string | null;
  // Has the office been told? pending → sent | refused (a 400 is never retried).
  report: { state: "pending" | "sent" | "refused"; at: string | null };
}

/** The one-off clear record. Its PRESENCE is the persisted marker "the sweep has run — never again". */
export interface PreUpdateClearRecord {
  id: typeof PRE_UPDATE_CLEAR_ID;
  clearedAt: string;
  rows: PreUpdateClearedRow[];
}

// idb's DBSchema for compile-time typing of the open()/transaction()/store APIs.
export interface OfflineQueueSchema extends DBSchema {
  pending_writes: {
    key: number;
    value: PendingWriteRecord;
    indexes: {
      by_status: PendingWriteStatus;
      by_idempotency_key: string;
      by_queued_at: string;
    };
  };
  sync_history: {
    key: number;
    value: SyncHistoryRecord;
    indexes: {
      by_idempotency_key: string;
      by_finalised_at: string;
    };
  };
  session_token: {
    key: "current";
    value: SessionTokenRecord;
  };
  // CR-DC-088 — the driver's cached reads. `by_stored_at` is the eviction order (oldest entry first,
  // which is oldest RUN first because a run is prefetched in one burst).
  driver_reads: {
    key: string;
    value: DriverReadRecord;
    indexes: {
      by_stored_at: string;
    };
  };
  // CR-DC-240 — device-side maintenance records. Today: the pre-update clear marker + its row list.
  queue_maintenance: {
    key: string;
    value: PreUpdateClearRecord;
  };
}

export type OfflineQueueDB = IDBPDatabase<OfflineQueueSchema>;

/**
 * Opens (and migrates, if necessary) the offline-queue IndexedDB. Called from
 * both the SW context (for fetch interception + replay) and the page context
 * (for read-only sync status via the SW message protocol — page-side reads
 * happen against the SAME database since IndexedDB is shared across contexts
 * on the same origin).
 *
 * The `customOpen` parameter is the seam used by the fake-indexeddb test helper
 * to inject an in-memory IDB without monkey-patching globals. Production callers
 * omit it and get the native `indexedDB`.
 */
export async function openQueueDb(
  dbName: string,
  customOpen?: typeof openDB,
): Promise<OfflineQueueDB> {
  const opener = customOpen ?? openDB;
  return opener<OfflineQueueSchema>(dbName, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // Version 0 → 1: initial schema. All future migrations gate on oldVersion.
      if (oldVersion < 1) {
        const pendingWrites = db.createObjectStore("pending_writes", {
          keyPath: "id",
          autoIncrement: true,
        });
        pendingWrites.createIndex("by_status", "status");
        pendingWrites.createIndex("by_idempotency_key", "idempotencyKey", { unique: true });
        pendingWrites.createIndex("by_queued_at", "queuedAt");

        const syncHistory = db.createObjectStore("sync_history", {
          keyPath: "id",
          autoIncrement: true,
        });
        syncHistory.createIndex("by_idempotency_key", "idempotencyKey", { unique: false });
        syncHistory.createIndex("by_finalised_at", "finalisedAt");

        db.createObjectStore("session_token", { keyPath: "id" });
      }
      // Version 1 → 2 (CR-DC-068): stamp the identity fields onto rows queued under version 1.
      //
      // 🔴 ADDITIVE ONLY. `pending_writes` ALREADY EXISTS here — this branch does not call
      // createObjectStore, does not call deleteObjectStore, and adds no index. It reads every
      // existing row and puts it back with `operatorId` / `stationId` set to null where absent.
      // A tablet in the field is carrying queued writes right now; recreating the store would
      // destroy exactly the data this change exists to protect.
      //
      // No new index deliberately: the queue is a shift's worth of rows and `getPendingWrites`
      // already does getAll + an in-memory sort. An index would only add an upgrade step that can
      // fail inside a versionchange transaction.
      //
      // ⚠ The backfill is TIDINESS, not the control. `writeBelongsToSession` (queue.ts) is
      // fail-closed on a missing identity, so a version-1 row is held for a human whether or not
      // this branch ever ran. That is deliberate: an error inside a versionchange transaction
      // aborts it, and the queue must still behave correctly rather than dangerously.
      if (oldVersion >= 1 && oldVersion < 2) {
        void backfillIdentityFields(transaction.objectStore("pending_writes"));
      }
      // Version 2 → 3 (CR-DC-088): the driver's device-side read cache.
      //
      // 🔴 ADDITIVE ONLY, AND IT TOUCHES NOTHING THAT ALREADY EXISTS. This branch creates ONE new
      // store and ONE index on it. `pending_writes` is not recreated, not deleted and not
      // re-indexed — tablets in the field are carrying queued PODs right now, and a driver's proof
      // of delivery is the single most expensive thing in this database to lose.
      //
      // No backfill and nothing to migrate: a cached read is a copy of something the server still
      // holds, so an upgrading tablet simply starts with an empty read store and fills it on its
      // next online run home.
      if (oldVersion < 3) {
        const driverReads = db.createObjectStore("driver_reads", { keyPath: "key" });
        driverReads.createIndex("by_stored_at", "storedAt");
      }
      // Version 3 → 4 (CR-DC-240): the maintenance store holding the pre-update clear record.
      //
      // 🔴 ADDITIVE ONLY. One new store; `pending_writes` is not recreated, deleted or re-indexed.
      if (oldVersion < 4) {
        db.createObjectStore("queue_maintenance", { keyPath: "id" });
      }
      // Future migrations append here. Each one gates on `oldVersion < N` and
      // bumps `DB_VERSION` at the top of this file. Keep migrations additive —
      // never drop or rename stores or indexes (matches Postgres migration
      // discipline at M002 + M003 + M005).
    },
    blocked() {
      // Another tab has the DB open at an older version. Browser will retry
      // automatically once that tab unloads. No-op here — the offline queue
      // can survive a brief blocked window because writes go to the SW context.
    },
    terminated() {
      // The browser killed the connection (e.g., low memory). Next caller will
      // re-open. No persistent state to clean up.
    },
  });
}

/**
 * CR-DC-068 version-1 → version-2 backfill: walk `pending_writes` with a cursor and stamp
 * `operatorId` / `stationId` as null on every row that predates them. Every row is PRESERVED —
 * the store is never recreated, and no field other than the two new ones is touched.
 *
 * Runs inside the caller's `versionchange` transaction (IndexedDB keeps it alive across the awaits
 * because every await is on one of its own requests).
 *
 * Errors are swallowed: a version-1 row that never gets backfilled still behaves correctly, because
 * `writeBelongsToSession` is fail-closed on a missing identity. Letting the rejection escape would
 * only add noise — the queue's safety does not depend on this function succeeding.
 */
async function backfillIdentityFields(
  store: IDBPObjectStore<
    OfflineQueueSchema,
    ArrayLike<StoreNames<OfflineQueueSchema>>,
    "pending_writes",
    "versionchange"
  >,
): Promise<void> {
  try {
    let cursor = await store.openCursor();
    while (cursor) {
      const row = cursor.value as LegacyPendingWriteRecordV1;
      if (row.operatorId === undefined || row.stationId === undefined) {
        await cursor.update({
          ...row,
          operatorId: row.operatorId ?? null,
          stationId: row.stationId ?? null,
        });
      }
      cursor = await cursor.continue();
    }
  } catch (err) {
    console.warn("[offline-queue] identity backfill could not complete; rows stay held", err);
  }
}
