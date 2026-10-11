// CR-DC-240 — the one-off clear of work saved by a worker whose replay could never send.
// Carried into the package by CR-DC-227 (packhouse API-CHG-005), unchanged.
//
// Anchors: KI-227-01 (the replay `fetch` was called as a method of a context object and Chromium
//          refuses that), PRD-NFR-005, SEC-AUTH-013, TECH-COMP-006.
//
// Owner ruling 2026-10-11: work queued before the fix is NOT sent late — it is cleared, once, on the
// first activation of the fixed worker, BEFORE any replay can run, and a record of what was cleared is
// kept (method, path, time, status — never a body).
//
// 🔴 "BEFORE THE FIX" IS A STAMP, NOT A CLOCK. `enqueueWrite` writes `replayGeneration` on every row; a
// row without it was written by an old worker. A stamp (rather than "whatever is present when the
// sweep runs") is what keeps the sweep safe to re-run LATE: if the activation-time sweep ever fails,
// a later run still cannot touch a row the fixed worker saved.
//
// 🔴 THE MARKER IS THE RECORD, AND IT LIVES IN THE SAME DATABASE AS THE QUEUE. A tablet that already
// ran the sweep (CR-DC-240, DB version 4) carries the marker with it across this package move because
// the database name, the store name (`queue_maintenance`) and the record id are the format, not
// settings. Move none of them: renaming any would make every such tablet clear a second time.
//
// ⚠ A PURE `idb`-TYPED LEAF — no `node:` import and no browser-only global at module scope, because
// this module is on the service-worker bundle's path.

import {
  PRE_UPDATE_CLEAR_ID,
  type OfflineQueueDB,
  type PendingWriteRecord,
  type PreUpdateClearRecord,
  type PreUpdateClearedRow,
} from "./schema";

/** Was this row written by a pre-fix worker? The one definition, shared by the sweep and the replay. */
export function isPreUpdateRow(row: Pick<PendingWriteRecord, "replayGeneration">): boolean {
  return row.replayGeneration === undefined;
}

/** Path only — no origin, no query string (the query can carry business identifiers). */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "unknown";
  }
}

function toClearedRow(row: PendingWriteRecord): PreUpdateClearedRow {
  // Built field by field on purpose: spreading `row` would copy `body` and `headers` into the record.
  return {
    idempotencyKey: row.idempotencyKey,
    method: row.method,
    path: pathOf(row.url),
    queuedAt: row.queuedAt,
    status: row.status === "synced" ? "queued" : row.status,
    operatorId: row.operatorId,
    stationId: row.stationId,
    report: { state: "pending", at: null },
  };
}

/**
 * Delete every pre-update row, of every status, and write the marker + record — in ONE transaction.
 * Returns `{ ran: false }` when the marker already exists. IndexedDB serialises overlapping readwrite
 * transactions on the same stores, so two racing callers produce exactly one sweep.
 *
 * Written even on a clean tablet (`rows: []`): that is what makes the sweep "done" there too.
 */
export async function clearPreUpdateWrites(
  db: OfflineQueueDB,
  now: string = new Date().toISOString(),
): Promise<{ ran: boolean; cleared: number }> {
  const tx = db.transaction(["pending_writes", "queue_maintenance"], "readwrite");
  const pendingStore = tx.objectStore("pending_writes");
  const maintenance = tx.objectStore("queue_maintenance");
  if ((await maintenance.get(PRE_UPDATE_CLEAR_ID)) !== undefined) {
    await tx.done;
    return { ran: false, cleared: 0 };
  }
  const old = (await pendingStore.getAll()).filter(isPreUpdateRow);
  const rows: PreUpdateClearedRow[] = [];
  for (const row of old) {
    if (row.id === undefined) continue;
    rows.push(toClearedRow(row));
    await pendingStore.delete(row.id);
  }
  await maintenance.put({ id: PRE_UPDATE_CLEAR_ID, clearedAt: now, rows });
  await tx.done;
  return { ran: true, cleared: rows.length };
}

/** The stored clear record, or null when the sweep has not run on this device. */
export async function readPreUpdateClear(db: OfflineQueueDB): Promise<PreUpdateClearRecord | null> {
  return (await db.get("queue_maintenance", PRE_UPDATE_CLEAR_ID)) ?? null;
}

/** Record how the office report for one cleared row went. One `put` of the marker record. */
export async function markPreUpdateReport(
  db: OfflineQueueDB,
  idempotencyKey: string,
  state: "sent" | "refused",
  at: string,
): Promise<void> {
  const tx = db.transaction("queue_maintenance", "readwrite");
  const store = tx.objectStore("queue_maintenance");
  const record = await store.get(PRE_UPDATE_CLEAR_ID);
  if (record) {
    await store.put({
      ...record,
      rows: record.rows.map((r) =>
        r.idempotencyKey === idempotencyKey ? { ...r, report: { state, at } } : r,
      ),
    });
  }
  await tx.done;
}
