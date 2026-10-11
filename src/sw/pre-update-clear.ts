// The service worker's half of the pre-update clear (owner ruling 2026-10-11, CR-DC-240).
// Carried into the package by CR-DC-227 (packhouse API-CHG-005); the words sent are unchanged.
//
// Anchors: KI-227-01, KI-M007-001, SEC-AUTH-013, PRD-NFR-005.
//
// 🔴 WHY THIS IS A MODULE AND NOT A FEW LINES IN THE INSTALL WIRING. Nothing under `tests/**` imports a
// serwist-compiled entry, so anything written there is unprovable. The wiring keeps one call per
// trigger; the decisions and the network call live here, tested.
//
// TWO JOBS, BOTH IDEMPOTENT:
//   1. `runPreUpdateClear` — remove every row a pre-fix worker saved, once, before any replay can run.
//   2. `reportPreUpdateClears` — tell the office, through the app's EXISTING station-session audit door
//      (`queueActionPath`, a setting), about the rows that were removed. Retried on later passes until
//      each row is accepted or refused.
//
// The SW's own fetch does not pass through its own `fetch` event, so the report is never queued.

import { clearPreUpdateWrites, markPreUpdateReport, readPreUpdateClear } from "../pre-update-clear";
import type { OfflineQueueDB, PreUpdateClearedRow } from "../schema";
import { isSessionIdle, isSessionTokenExpired, type StationSession } from "../token-storage";
import { globalFetch } from "./global-fetch";

export const PRE_UPDATE_REASON_CODE = "PRE_UPDATE_CLEARED";
/** How many rows one pass reports, so a big backlog cannot hold the replay pass open. */
export const REPORTS_PER_PASS = 25;

export interface PreUpdateReportDeps {
  db: OfflineQueueDB;
  readToken: () => Promise<StationSession | null>;
  /**
   * The app's queue-action audit door (`QueueWorkerSettings.queueActionPath`). Station-session gated;
   * the package names none of an app's routes, so the caller says where it is.
   */
  queueActionPath: string;
  /** Override for tests; defaults to the worker's global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Run the one-off sweep. Never throws: a failed sweep must not stop the worker activating or replaying. */
export async function runPreUpdateClear(
  db: OfflineQueueDB,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    await clearPreUpdateWrites(db, now().toISOString());
  } catch (err) {
    console.warn("[sw] pre-update clear skipped", err);
  }
}

/** `/api/item-receipt/…` → `item-receipt`. Anything not under /api/ is `unknown`. */
export function entityTypeOf(path: string): string {
  const match = /^\/api\/([^/]+)/.exec(path);
  return match?.[1] ?? "unknown";
}

/** The exact words sent to the office for one cleared row. No body, no header, no query string. */
export function reasonTextFor(row: PreUpdateClearedRow): string {
  return (
    "Cleared automatically by the tablet update (CR-DC-240): never reached the office. " +
    `${row.method} ${row.path}, saved ${row.queuedAt}, was ${row.status}, ` +
    `captured by operator ${row.operatorId ?? "unknown"} at station ${row.stationId ?? "unknown"}.`
  );
}

/**
 * Report up to REPORTS_PER_PASS pending rows. Nothing is sent without a usable session (the same test
 * `mayAttachToken` and the replay gate apply). 2xx → sent; 400 → refused and never retried (e.g. a
 * non-UUID key from a very early build); 401/403/5xx/network → stays pending for the next pass.
 */
export async function reportPreUpdateClears(deps: PreUpdateReportDeps): Promise<void> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const record = await readPreUpdateClear(deps.db);
    if (record === null) return;
    const pending = record.rows
      .filter((r) => r.report.state === "pending")
      .slice(0, REPORTS_PER_PASS);
    if (pending.length === 0) return;
    const session = await deps.readToken();
    if (session === null || isSessionTokenExpired(session.expiresAt, now)) return;
    if (isSessionIdle(session, now)) return;
    const send = deps.fetch ?? globalFetch;
    for (const row of pending) {
      const state = await reportOne(send, deps.queueActionPath, session, row);
      if (state !== null)
        await markPreUpdateReport(deps.db, row.idempotencyKey, state, now.toISOString());
    }
  } catch (err) {
    console.warn("[sw] pre-update report skipped", err);
  }
}

async function reportOne(
  send: typeof fetch,
  queueActionPath: string,
  session: StationSession,
  row: PreUpdateClearedRow,
): Promise<"sent" | "refused" | null> {
  try {
    const response = await send(queueActionPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        queue_action: "discard",
        client_mutation_id: row.idempotencyKey,
        entity_type: entityTypeOf(row.path),
        reason_code: PRE_UPDATE_REASON_CODE,
        reason_text: reasonTextFor(row),
      }),
      credentials: "include",
    });
    if (response.status >= 200 && response.status < 300) return "sent";
    if (response.status === 400) return "refused";
    return null;
  } catch {
    return null;
  }
}
