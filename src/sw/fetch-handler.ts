// Service-worker fetch handler for the offline write queue (TECH-COMP-006).
//
// Anchors: EPIC-001-M007-SCOPE-003, PRD-FUNC-127, PRD-FUNC-129, TECH-FE-002,
//          UX-PRINCIPLE-015 (optimistic UI), API-PRINCIPLE-008 (Idempotency-Key).
//
// Pure function: takes the inbound Request + the queue DB + helpers, returns a
// Response. The SW entrypoint (src/sw/index.ts) wires this into the SW
// `fetch` event. Extracting as a pure function keeps the algorithm unit-
// testable without a real SW.

import { IDEMPOTENCY_HEADER, generateIdempotencyKey } from "../idempotency";
import { isPreUpdateRow } from "../pre-update-clear";
import {
  QueueStorageFullError,
  enqueueWrite,
  getHeldWrites,
  hasEarlierWaitingWork,
} from "../queue";
import { driverReadIdentity, readCachedDriverRead, type ReadCache } from "../read-cache";
import type { DriverReadRecord, OfflineQueueDB, PendingWriteRecord } from "../schema";
import { isSessionIdle, isSessionTokenExpired, type StationSession } from "../token-storage";

// CR-DC-227 — THIS FILE MOVED FROM THE DC (`src/sw/fetch-handler.ts`). The algorithm is byte-for-byte
// what it was; what is no longer spelled here is every VALUE that names the DC's own routes. Those are
// the settings below, passed in once through `createFetchHandler`, with NO defaults — a packhouse path
// that differs from the DC's must be a type error to forget, never a silent fallback to the DC's.
//
// The DC's own values, with their full CR-DC-011 / -013 / -084 / -202 reasoning, are in the DC's
// `src/sw/dc-settings.ts`. The reasoning about WHY a never-queued write is forwarded rather than queued
// stays below, because that half is the package's.
export interface FetchHandlerSettings {
  /** The one spelling of "this pathname is the tablet shell" (CR-DC-084), shared with the page. */
  readonly isTabletSurfacePath: (pathname: string) => boolean;
  /** Auth endpoints must NEVER be queued — you cannot authenticate offline. */
  readonly authPathPrefix: string;
  /** Logout / auto-logoff goes live WITH the station token injected, so the audit attributes it. */
  readonly authLogoutPath: string;
  /** The station-pairing redeem door: live, never queued, and never given a Bearer. */
  readonly stationPairRedeemPath: string;
  /** The writes that must reach the server NOW or not at all. A URL that will not parse is not one. */
  readonly isNeverQueuedWrite: (requestUrl: string) => boolean;
  /** Which GETs are also stored on the device and served back when the live fetch THROWS. */
  readonly isCachedReadPath: (pathname: string) => boolean;
  /** The device-side read cache, bound to the app's protected-row rule. */
  readonly readCache: ReadCache;
  /** The error `code` on the 507 body. A flow branches on it; it is not shown to anyone. */
  readonly queueFullCode: string;
  /** The words the operator reads when the tablet is full. Single-line: it travels in a JSON body. */
  readonly queueFullMessage: string;
  /** CR-DC-267 — writes whose screen needs the office's answer NOW, so they cannot wait in a queue. */
  readonly isLiveOnlyWrite: (requestUrl: string) => boolean;
  /** CR-DC-267 — what the operator reads when a live-only write is refused because earlier work waits. */
  readonly earlierWorkWaitingMessage: string;
  /** CR-DC-269 — the same refusal when the earlier work is held for someone else (waiting will not clear it). */
  readonly earlierWorkHeldMessage: string;
}

// HTTP methods that route through the queue. GETs pass through to the network
// (or the M006 minimal precache for shell assets).
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 🔴 CR-DC-071 — THE RENEWAL ENDPOINT IS DELIBERATELY *NOT* GIVEN THE LOGOUT'S BEARER INJECTION.
// The renewal path matches `authPathPrefix`, so a call from PAGE code is forwarded live and
// UNMODIFIED — with no Authorization header — and is answered 401. That is the intended behaviour and
// it is a control, not an oversight: the only legitimate caller is the service worker itself
// (`sw/session-renewal.ts`), whose own fetches do not pass through this handler at all, and which
// consumes the response internally so no renewed token ever reaches a page `Response` (SEC-AUTH-013).
// ⚠ Adding that path to the injection below would hand page code a live renewal endpoint. Do not.

export interface FetchHandlerDeps {
  db: OfflineQueueDB;
  /** Returns the active session token if any, for outbound request injection. */
  readToken: () => Promise<StationSession | null>;
  /** Now() — injectable for deterministic tests. */
  now?: () => Date;
  /** Decides whether the request originates from a tablet-pwa surface. */
  isTabletFlowRequest?: (request: Request) => boolean;
  /** Idempotency-Key factory — injectable for deterministic tests. */
  generateKey?: () => string;
  /** Network fetch — injectable for deterministic tests (used by the read-auth path). */
  fetchImpl?: typeof fetch;
  /**
   * Online detector (KI-M002E3-004). When it returns true, a tablet write is sent DIRECTLY to the
   * server and the real response is returned to the page (so a receipt confirm posts immediately and
   * the PO flips to Received on the spot). When false — or omitted — the write is queued for offline
   * replay. Defaults to OFFLINE-when-omitted so the always-queue unit tests keep their behaviour; the
   * SW entry passes `() => self.navigator.onLine` in production.
   */
  isOnline?: () => boolean;
  /**
   * CR-DC-070 — the device refused the write because the origin is out of quota. The injectable seam
   * that makes the `QUEUE_FULL_BACKOFF` broadcast unit-testable without a real service worker (same
   * shape as `isOnline` / `readToken` / `generateKey` above); the SW entry passes a function that
   * posts the broadcast to every client.
   *
   * Optional, and a no-op when omitted — but the 507 below is returned either way. A tablet whose SW
   * entry forgot to wire this still refuses the write honestly at the point of the tap.
   */
  onQueueFull?: (idempotencyKey: string) => void;
  /**
   * CR-DC-088 — keep the worker alive for work that must NOT block the response.
   *
   * The SW entry passes `(p) => event.waitUntil(p)`; unit tests pass a collector so the caching can
   * be awaited deterministically. Optional and a no-op when omitted — the caching still happens, it
   * simply has no lifetime guarantee, which is the correct degradation for a cache.
   *
   * 🔴 THE PROMISE HANDED TO THIS IS ALREADY `.catch`-SWALLOWED AT SOURCE. A cache failure must never
   *    be able to reject into `event.respondWith` and take down the read the driver is waiting on.
   */
  keepAlive?: (p: Promise<unknown>) => void;
  /**
   * CR-DC-088 revision 2 (D-7) — WARM THE PAGE DOCUMENTS THIS SUCCESSFUL READ IMPLIES.
   *
   * 🔴 WITHOUT THIS SEAM PART 3 CACHES NOTHING FOR A STOP. The navigation cache is only ever written
   *    by a real DOCUMENT navigation to that exact URL, and a driver never makes one to a stop: every
   *    tap out of the run home is a `next/link` SOFT navigation whose RSC fetch has mode `"cors"`.
   *    So the cache was empty for every stop and a driver in a dead zone got the browser's offline
   *    page. Warming rides the prefetch pass that is already running while there is signal.
   *
   * ⚠ THE MAPPING AND EVERY Cache Storage CALL LIVE IN `src/sw/navigation-cache.ts`, not here. This
   *   handler stays ignorant of Cache Storage; it only says WHICH READ SUCCEEDED. The SW entry wires
   *   the two together.
   *
   * Optional and a no-op when omitted (every existing unit test), synchronous, and it must never
   * throw: the implementation swallows at source and puts its own work on `keepAlive`.
   */
  warmDriverPages?: (path: string) => void;
}

/**
 * CR-DC-070 — the response for a write that could not be queued.
 *
 * 🔴 507 Insufficient Storage, and NOT a 202, and NOT `X-Queued-Locally`. This is the one place the
 * optimistic-UI contract (UX-PRINCIPLE-015) must break, deliberately and visibly: a write that could
 * not be queued HAS NOT HAPPENED, and the operator must not be allowed to believe it has. The tablet
 * flows' 202-is-success branches key on the 202, so a 507 cannot be reported as saved by any of them,
 * and `parseError` routes the message above straight to the screen. The form keeps what was typed.
 */
function queueFullResponseImpl(settings: FetchHandlerSettings, idempotencyKey: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: settings.queueFullCode, message: settings.queueFullMessage },
    }),
    {
      status: 507,
      headers: {
        "Content-Type": "application/json",
        "X-Queue-Full": "true",
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
    },
  );
}

/**
 * CR-DC-267 — the answer to a live-only write while earlier work on this device is still waiting.
 * A 409, NOT a 202 and NOT `X-Queued-Locally`: nothing was saved, nothing was queued, and the screen
 * shows the sentence in its existing error banner.
 */
export const EARLIER_WORK_WAITING_CODE = "EARLIER_WORK_WAITING";
/**
 * CR-DC-269 — the same 409, under its own code, when some of the earlier work is HELD for someone else.
 * Waiting alone never sends a held row (it matches only its own operator at its own station), so the
 * "still sending" sentence would be untrue and Send now cannot help. The page branches on the code.
 */
export const EARLIER_WORK_HELD_CODE = "EARLIER_WORK_HELD";

function earlierWorkRefusalResponse(
  code: string,
  message: string,
  idempotencyKey: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { code, message },
    }),
    {
      status: 409,
      headers: { "Content-Type": "application/json", [IDEMPOTENCY_HEADER]: idempotencyKey },
    },
  );
}

export interface AuthRequestDeps {
  /** Returns the active session token if any (to attribute a logout/auto-logoff). */
  readToken: () => Promise<StationSession | null>;
  /** Network fetch — injectable for deterministic tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Handle an auth request (login / logout / auto-logoff). Returns a live Response for any
 * `/api/auth/*` request (these must never be queued), else null so the caller falls through to the
 * write-queue path. PIN login is forwarded unmodified (the operator has no token yet); PIN logout is
 * forwarded with `Authorization: Bearer <token>` injected from the SW-protected store so the server
 * can attribute the logout / auto-logoff to the operator + station (SEC-AUTH-004/007 / SEC-AUTH-013 —
 * the token never reaches page code; only the SW adds it).
 */
async function handleAuthRequestImpl(
  settings: FetchHandlerSettings,
  request: Request,
  deps: AuthRequestDeps,
): Promise<Response | null> {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const isLiveRequest =
    path.startsWith(settings.authPathPrefix) || path === settings.stationPairRedeemPath;
  if (!isLiveRequest) return null;

  const doFetch = deps.fetchImpl ?? fetch;
  if (path === settings.authLogoutPath) {
    const token = await deps.readToken();
    if (token) {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${token.token}`);
      return doFetch(new Request(request, { headers }));
    }
  }
  // PIN login, or logout with no stored token — forward live, unmodified.
  return doFetch(request);
}

/**
 * Handle a fetch event for a tablet-flow write. Returns:
 *   - ONLINE (KI-M002E3-004): the request is sent DIRECTLY to the server with the SW-held station
 *     Bearer injected, and the real server Response is returned to the page — so a receipt confirm
 *     posts immediately and the operator sees the true result (201 success, or a 4xx/5xx they can act
 *     on). If that live send throws (genuine network failure mid-flight), it falls back to queuing.
 *   - OFFLINE (or `isOnline` omitted): a 202 Accepted with X-Queued-Locally + the Idempotency-Key,
 *     and the write is stored in the offline queue for replay on reconnect.
 *   - NEVER-QUEUED (CR-DC-084): forwarded live with the station Bearer injected and the server's
 *     Response returned verbatim — see `forwardNeverQueued`. Nothing is enqueued on any branch.
 *   - For browser-admin or non-tablet writes: null (caller falls through to default network fetch).
 *
 * Why online sends directly: always-queue-then-background-replay proved fragile in production — the SW
 * can be torn down before the fire-and-forget replay completes, so the write never reached the server
 * (KI-M002E3-003/-004). Sending directly when online removes that dependency for the common case while
 * keeping the offline queue as the genuine-outage safety net (PRD-NFR-005). Idempotency-Key is attached
 * on the direct send too, so a server-side retry/replay can still dedupe.
 */
async function handleTabletWriteImpl(
  settings: FetchHandlerSettings,
  request: Request,
  deps: FetchHandlerDeps,
): Promise<Response | null> {
  if (!WRITE_METHODS.has(request.method)) return null;

  const isTabletFlow = deps.isTabletFlowRequest
    ? deps.isTabletFlowRequest(request)
    : defaultIsTabletFlowRequest(settings, request);
  if (!isTabletFlow) return null;

  // EPIC-019-M003 / OD-M003-E — a print is NEVER queued. Same reasoning as the auth prefix above,
  // different cause: you cannot authenticate offline, and you must not print late.
  //
  // A label is a physical act tied to a moment. Queued, it replays when signal returns — which at
  // M005, once the NTS Q304f is dispensing paper, means a sticker printing hours later for a pallet
  // that is already in the ripening room and already labelled by hand. The offline queue is for
  // writes that record what happened; a print MAKES something happen, in the world, now.
  //
  // 🔴 CR-DC-084 — AND IT IS FORWARDED WITH THE STATION BEARER, NOT PASSED THROUGH BARE.
  //
  // ⚠ THE COMMENT THAT USED TO SIT HERE WAS FALSE, and it is the whole of defect 2. It said returning
  //   null "passes the request through to the network untouched: online it just works". Untouched also
  //   means UNAUTHENTICATED: `sendDirect` is the ONLY path that attaches the SW-held station Bearer,
  //   and page code can never hold the token itself (SEC-AUTH-013). So every never-queued write left
  //   the tablet with no Authorization header at all, `requireSession` found no Bearer, fell to the
  //   cookie branch, found no cookie — a tablet has none — and answered 401 UNAUTHENTICATED. It hit
  //   EVERY tablet user unconditionally, on all three members of the set, and nothing has ever
  //   physically printed from the live system, which is why nobody met it.
  //
  // 🔴 THE NEVER-QUEUE RULE ITSELF IS COMPLETELY UNTOUCHED. `forwardNeverQueued` cannot reach
  //    `enqueueWrite` on ANY branch: it sends live or it returns null, and every null is exactly the
  //    behaviour this line has always had. OD-M003-E holds unbroken — a queued label replays hours
  //    later as a sticker for a pallet already in a ripening room.
  //
  // CR-DC-011 widened this from the print prefix to the never-queued SET; the second member is the
  // draft delivery-details correction and the third (CR-DC-013) is the draft-receipt discard, for the
  // reasons at isNeverQueuedWrite. All three were 401ing; all three are fixed by the one forwarder,
  // because the fix belongs at the SET boundary and carving one member out would cost more code to
  // keep two known defects.
  if (settings.isNeverQueuedWrite(request.url)) return forwardNeverQueued(request, deps);

  // Read the inbound Idempotency-Key if the caller supplied one (tests often
  // do); otherwise generate a fresh UUID v4. Either way, the SAME key is used
  // for every replay attempt of this write (replay-loop reuses the queue row's
  // stored idempotencyKey), and for the direct-send path below.
  const inboundKey = request.headers.get(IDEMPOTENCY_HEADER);
  const idempotencyKey = inboundKey ?? (deps.generateKey ?? generateIdempotencyKey)();

  // Read the body once (Request bodies are single-use streams).
  const body = await request.clone().text();
  const headers = {
    ...serialiseHeaders(request.headers),
    [IDEMPOTENCY_HEADER]: idempotencyKey,
  };

  // The identity triple comes from the active session (read from the SW-protected token store).
  // warehouse_id preserves M002's multi-DC isolation through replay; CR-DC-068 adds the operator
  // and the station, so the replay loop can refuse to send this write under anyone else's session.
  // All three are stamped ONCE, here, at capture — and none of them is ever rewritten afterwards.
  //
  // 🔴 CR-DC-071 — THE IDENTITY IS STAMPED FROM THE SESSION EVEN WHEN IT IS IDLE. The row is that
  // operator's work; keeping their identity on it is what lets `writeBelongsToSession` match when
  // they tap back in, and the queue drain (CR-DC-069) then sends it under their own name. Dropping
  // to null here would hold the row for a human forever — the opposite of the intent.
  const token = await deps.readToken();
  const warehouseId = token?.warehouseId ?? null;

  // ONLINE → send directly to the server and return the real response (KI-M002E3-004).
  //
  // 🔴 CR-DC-071 — UNLESS THE SESSION IS NOT USABLE, in which case the write is QUEUED instead. Two
  // things fall out of this one condition, and both matter:
  //
  //   · NO TOKEN IS ATTACHED PAST THE IDLE WINDOW. `sendDirect` is the only path that attaches a
  //     Bearer to a tablet write, so refusing to take it IS the refuse-to-attach gate the offline
  //     grace depends on. The token deliberately outlives the window by OFFLINE_GRACE_MINUTES so a
  //     10-minute outage is survivable on a five-minute station (PRD-NFR-005); the grace must buy an
  //     OUTAGE its margin and must not buy an unattended tablet a longer usable session.
  //   · THE OPERATOR'S WORK IS NOT LOST. Sending it unauthenticated instead would return a 401 to
  //     the page. Queueing it returns the ordinary 202, CR-DC-068's `checkSessionSkip` holds the row
  //     untouched, and CR-DC-069's sign-in trigger drains it the moment the same person taps back
  //     in. That is the promise the tablet already makes on screen (UX-SCREEN-230).
  //
  // 🔴 CR-DC-267 — ...AND ONLY IF NOTHING SAVED EARLIER IS STILL WAITING. A live send used to jump the
  // line: with signal back and earlier work backed off or held, a new save reached the office first
  // and took the next number. Now an ordinary write joins the queue behind the earlier work (the
  // ordinary 202; `flushQueueAfterWrite` starts an in-order pass at once). A LIVE-ONLY write — one whose
  // screen needs the office's answer now — cannot wait in a queue, so it is refused with a plain
  // sentence and NOTHING is queued.
  if (deps.isOnline?.() === true && mayAttachToken(token, (deps.now ?? defaultNow)())) {
    const earlierWaiting = await hasEarlierWaitingWork(deps.db);
    if (earlierWaiting && settings.isLiveOnlyWrite(request.url)) {
      // CR-DC-269 — ANY held row among the earlier work makes "still sending" untrue: a held row is
      // released only by its own person signing in, or by a manager's Clear. Same predicate as Sync
      // details' Held section; pre-update rows are excluded exactly as `hasEarlierWaitingWork` excludes them.
      const held = (await getHeldWrites(deps.db, token)).some((row) => !isPreUpdateRow(row));
      return held
        ? earlierWorkRefusalResponse(
            EARLIER_WORK_HELD_CODE,
            settings.earlierWorkHeldMessage,
            idempotencyKey,
          )
        : earlierWorkRefusalResponse(
            EARLIER_WORK_WAITING_CODE,
            settings.earlierWorkWaitingMessage,
            idempotencyKey,
          );
    }
    if (!earlierWaiting) {
      const direct = await sendDirect(request, { headers, token, fetchImpl: deps.fetchImpl });
      if (direct !== null) return direct;
      // direct === null → the live send threw (network dropped mid-request). Fall through to queue it.
    }
  }

  try {
    await enqueueWrite(deps.db, {
      idempotencyKey,
      method: request.method as PendingWriteRecord["method"],
      url: request.url,
      headers,
      body: body === "" ? null : body,
      queuedAt: (deps.now ?? defaultNow)().toISOString(),
      warehouseId,
      operatorId: token?.operatorId ?? null,
      stationId: token?.stationId ?? null,
    });
  } catch (err) {
    // CR-DC-070 — the device is full. Before this, the rejection propagated out of this function
    // inside `event.respondWith` and the operator got a generic failure on a write the whole design
    // had promised was safe to make offline.
    //
    // 🔴 The error is NOT swallowed — it is TRANSLATED. It becomes a broadcast every open tab sees
    // and a 507 the flow renders in our own words. A caught error the operator never sees would be
    // worse than the crash it replaced.
    //
    // Any other rejection still propagates exactly as it did today: `enqueueWrite` only converts a
    // genuine quota refusal, so a ConstraintError (duplicate key — a queue bug) is never dressed up
    // as a full device.
    if (err instanceof QueueStorageFullError) {
      deps.onQueueFull?.(idempotencyKey);
      return queueFullResponseImpl(settings, idempotencyKey);
    }
    throw err;
  }

  return new Response(
    JSON.stringify({
      queued: true,
      idempotencyKey,
      message: "Write queued locally — will sync on reconnect.",
    }),
    {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        "X-Queued-Locally": "true",
        [IDEMPOTENCY_HEADER]: idempotencyKey,
      },
    },
  );
}

/**
 * CR-DC-084 — forward a NEVER-QUEUED tablet write live, with the station Bearer injected, and return
 * the server's Response verbatim.
 *
 * 🔴 NOTHING IS ENQUEUED ON ANY BRANCH, AND THAT IS THE POINT. `enqueueWrite` is not reachable from
 *    here. This function only decides between "send it, authenticated" and "do exactly what this code
 *    path did before" — which is return null, so the SW entry passes the original request through.
 *    OD-M003-E is therefore provably intact rather than re-argued: a print is still never queued.
 *
 * ⚠ DELIBERATELY NOT `sendDirect`. That path also stamps an `Idempotency-Key` and REBUILDS the
 *   request. This is a transport fix: the request must reach the server byte-identical apart from the
 *   one Authorization header, so the response and audit shapes cannot move.
 *
 * The four `null` returns are each TODAY'S EXACT BEHAVIOUR, kept deliberately:
 *
 *   (a) OFFLINE — never attempt. The page's own `fetch` then rejects and the caller reports
 *       `offline: true`, which is OD-3's own state (tests/unit/receipts/label-offline-refusal.test.ts).
 *   (b) NO SESSION — pass through, 401 naturally, the page returns to the PIN screen. The same rule
 *       `handleTabletRead` already applies when there is no token to withhold.
 *   (c) IDLE / EXPIRED — CR-DC-071's refuse-to-attach gate, REUSED and never re-derived. The offline
 *       grace must buy an OUTAGE its margin and must not buy an unattended tablet a longer session.
 *   (d) THREW MID-SEND — pass through; the entry retries it unauthenticated, which 401s and cannot
 *       print, and the page reports offline. No double print is possible, because a throw means the
 *       first attempt never got an answer and this one carries no Bearer either.
 */
async function forwardNeverQueued(
  request: Request,
  deps: FetchHandlerDeps,
): Promise<Response | null> {
  if (deps.isOnline?.() !== true) return null; // (a)
  const token = await deps.readToken();
  // ⚠ `!token`, not `token === null` — the same spelling `handleTabletRead` uses for the same fact.
  //   (An `=== null` on an identifier called `token` also trips `security/detect-possible-timing-attacks`.)
  if (!token) return null; // (b)
  if (!mayAttachToken(token, (deps.now ?? defaultNow)())) return null; // (c)

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token.token}`);
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    return await doFetch(new Request(request, { headers }));
  } catch {
    return null; // (d)
  }
}

/**
 * Send a tablet write straight to the server with the station Bearer + Idempotency-Key attached, and
 * return the server's Response verbatim. Returns null when the fetch THROWS (a genuine network failure)
 * so the caller can fall back to queuing. A 4xx/5xx is a real server answer, NOT a throw — it is
 * returned to the page so the operator sees the actual outcome instead of a silent optimistic 202.
 */
async function sendDirect(
  request: Request,
  opts: {
    headers: Record<string, string>;
    token: StationSession | null;
    fetchImpl?: typeof fetch;
  },
): Promise<Response | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const outHeaders = new Headers(opts.headers);
  if (opts.token) {
    outHeaders.set("Authorization", `Bearer ${opts.token.token}`);
  }
  try {
    return await doFetch(
      new Request(request.url, {
        method: request.method,
        headers: outHeaders,
        body: await request.clone().text(),
        credentials: "include",
        redirect: "follow",
      }),
    );
  } catch {
    return null; // network failure mid-send — caller queues it for offline replay
  }
}

/**
 * Handle a tablet-flow API READ (EPIC-003-M002 / KI-M002E3-002). A station-bound tablet holds its
 * session token ONLY in the SW (SEC-AUTH-013); page code can never attach it. Tablet WRITES already
 * get the Bearer injected (handleTabletWrite) + queued, but authenticated READs (e.g.
 * GET /api/item-receipt/context for the receiving screen — the first authenticated tablet read) would
 * otherwise pass through with no auth and be rejected by requireSession.
 *
 * Returns a live (never queued — reads need connectivity) Response with `Authorization: Bearer <token>`
 * injected for an `/api/*` GET originating from the `/tablet-pwa` surface, or null so the caller falls
 * through to the default GET handling (shell precache / plain network passthrough). When there is no
 * stored token, returns null too (let it pass through and 401 naturally — the page reacts by sending the
 * operator back to the PIN screen). The token stays SW-internal (SEC-AUTH-013 preserved).
 *
 * The SAME-ORIGIN guard lives in the SW entry (src/sw/index.ts), which holds `self.location` — this keeps
 * the function a pure, testable unit and, critically, prevents the SW-held token from ever being attached
 * to a cross-origin request (token-leak guard). Callers MUST only invoke this for same-origin `/api/*`.
 *
 * ============================================================================
 * 🔴 CR-DC-088 — AND, FOR THE THREE DRIVER-STATION READS ONLY, THE DEVICE-SIDE COPY
 * ============================================================================
 * A driver in a dead zone could not open the stop, so the offline write they COULD make was
 * unreachable and the answer was paper. For a path `isDriverStationReadPath` names — and for no other
 * path on any other surface — this now also:
 *
 *   · stores a `200 OK` response body against the session identity triple, WITHOUT blocking the
 *     response (the promise goes to `deps.keepAlive`, already `.catch`-swallowed at source);
 *   · serves that stored body back WHEN AND ONLY WHEN THE LIVE FETCH THREW.
 *
 * 🔴 "WHEN AND ONLY WHEN THE LIVE FETCH THROWS." A 4xx/5xx is a REAL SERVER ANSWER and is returned
 *    verbatim, so the driver keeps CR-DC-086's honest refusal wording — the office cancelled this
 *    load, this stop is not yours, sign in again. A throw is the only case where the page would
 *    otherwise get nothing at all.
 *
 * 🔴 ON A MISS THE ORIGINAL REJECTION IS RE-THROWN, so it propagates out of `event.respondWith`
 *    exactly as it does today: the page's fetch rejects, `getJson` returns `status: 0`, and the driver
 *    reads "No signal — this couldn't be loaded." NOT ONE BRANCH of CR-DC-086's behaviour changes on
 *    a cache miss.
 *
 * ⚠ THE IDLE / EXPIRED / NO-TOKEN GATES ABOVE RUN FIRST AND ARE UNTOUCHED, so a session past its
 *   window gets no cached read either — it returns null before any of this is reached.
 *
 * ⚠ EVERY OTHER SURFACE IS BYTE-IDENTICAL. Receiving, dispatch, conversion and QC all happen at the
 *   DC on wifi; widening the predicate is how a stale-data defect reaches a surface that never needed
 *   one, and it is a stated non-goal.
 */
async function handleTabletReadImpl(
  settings: FetchHandlerSettings,
  request: Request,
  deps: FetchHandlerDeps,
): Promise<Response | null> {
  if (request.method !== "GET") return null;

  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!path.startsWith("/api/")) return null;

  const isTabletFlow = deps.isTabletFlowRequest
    ? deps.isTabletFlowRequest(request)
    : defaultIsTabletFlowRequest(settings, request);
  if (!isTabletFlow) return null;

  const token = await deps.readToken();
  if (!token) return null; // no token — pass through (will 401; page handles re-auth)
  // 🔴 CR-DC-071 — and the same refusal for a session that has LAPSED or gone IDLE. Passing through
  // untouched lands on exactly the branch above: the read 401s naturally and the page sends the
  // operator back to the PIN screen, which is today's behaviour for a station with no token at all.
  // A read is not queueable (it needs connectivity by definition), so there is nothing to protect
  // here — only a token not to attach.
  if (!mayAttachToken(token, (deps.now ?? defaultNow)())) return null;

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token.token}`);
  const doFetch = deps.fetchImpl ?? fetch;
  const outbound = new Request(request, { headers });

  // Every non-driver surface: exactly what this function has always done, on the same line.
  if (!settings.isCachedReadPath(path)) return doFetch(outbound);

  // 🔴 FAIL-CLOSED ON AN INCOMPLETE IDENTITY. `driverReadIdentity` returns null when any of the three
  //    is missing (a session stored by an older build carries no operator), and null means neither
  //    cache nor serve — i.e. today's behaviour. Two unknowns must never cancel into a match.
  const identity = driverReadIdentity(token);

  let response: Response;
  try {
    response = await doFetch(outbound);
  } catch (err) {
    const hit = await readCachedDriverRead(deps.db, identity, path);
    if (hit !== null) return snapshotResponse(hit);
    throw err; // MISS → today's behaviour, unchanged (CR-DC-086's "No signal").
  }

  // Only `200 OK` is cached. A 401 / 403 / 409 / 500 is a REFUSAL, not data; caching one would let a
  // transient server error be served back as this stop's plan for the rest of the shift.
  if (response.status === 200 && identity !== null) {
    const copy = response.clone();
    const cached = (async () => {
      await settings.readCache.cacheDriverRead(
        deps.db,
        identity,
        path,
        await copy.text(),
        (deps.now ?? defaultNow)(),
      );
    })().catch(() => {
      // ⚠ SWALLOWED AT SOURCE, so a cache failure can never reject into `event.respondWith`. The
      //   read the driver is waiting on has already been returned by the time this settles.
    });
    deps.keepAlive?.(cached);
    // 🔴 CR-DC-088 revision 2 (D-7) — AND THE PAGE DOCUMENTS THIS READ IMPLIES. The API body is
    //    useless to a driver whose tablet cannot even load the page that renders it; this is the
    //    other half, and it is the half revision 1 was missing. Fire-and-forget by contract: it
    //    returns void, swallows at source, and does its own `keepAlive`.
    //
    // ⚠ GATED ON THE SAME CONDITION AS THE READ CACHE, DELIBERATELY. With a null identity nothing is
    //   cached and nothing can be served offline, so warming the shells would be pure battery and
    //   bandwidth for a tablet that still could not open a stop.
    deps.warmDriverPages?.(path);
  }
  return response;
}

/**
 * CR-DC-088 — a stored driver read, dressed as the response it was.
 *
 * The two headers are what Part 4 hangs off: the page reads them in `getJson` and every driver screen
 * says "Offline · showing your run as of 06:12" instead of presenting a saved copy as live. Same
 * origin, so they are readable by page code with no CORS work.
 */
function snapshotResponse(hit: DriverReadRecord): Response {
  return new Response(hit.body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Offline-Snapshot": "true",
      "X-Snapshot-At": hit.storedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * CR-DC-071 — may the service worker attach this session's Bearer to an outbound request right now?
 *
 * 🔴 THIS IS THE REFUSE-TO-ATTACH GATE THE OFFLINE GRACE DEPENDS ON. A station token now lives
 * `auto_logoff_minutes + OFFLINE_GRACE_MINUTES`, because a renewal is impossible while the tablet is
 * offline and PRD-NFR-005 promises a 10-minute outage is survivable on every station — including the
 * six configured at five minutes. The grace is only defensible because the worker will not USE it
 * for an unattended tablet, and the worker is the only possible requester: the raw token never
 * leaves this boundary (SEC-AUTH-013). Net effect: the server enforces idle to within 15 minutes,
 * this gate enforces it to the minute, and the page timer still does the audited sign-out at the
 * configured minute exactly as before.
 *
 * ⚠ `null` MEANS TODAY'S BEHAVIOUR, NOT A REFUSAL. With no session stored at all there is no token
 * to withhold; the request goes live and the server answers it, which is what has always happened.
 * Diverting a no-session write into the queue instead would stamp it with a null identity, and
 * `writeBelongsToSession` is fail-closed on null — it would be held for a human forever, which is
 * the opposite of protecting it.
 */
function mayAttachToken(session: StationSession | null, now: Date): boolean {
  if (session === null) return true;
  return !isSessionTokenExpired(session.expiresAt, now) && !isSessionIdle(session, now);
}

/**
 * Default tablet-flow detection — checks if the originating client URL falls
 * under `/tablet-pwa/`. The SW's `clients.get(event.clientId)` is preferred
 * over the Referer header (which can be spoofed); the SW entry passes the
 * client URL through this helper via the `isTabletFlowRequest` override.
 *
 * The fallback (when no client URL is available) reads the Referer header,
 * matching what the test endpoint uses for QA-AUTO-041 / QA-AUTO-042.
 */
function defaultIsTabletFlowRequest(settings: FetchHandlerSettings, request: Request): boolean {
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const url = new URL(referer);
      return settings.isTabletSurfacePath(url.pathname);
    } catch {
      return false;
    }
  }
  // No referer (e.g. from a direct fetch in a unit test) — treat as
  // non-tablet-flow. Tablet flows always render under the /tablet-pwa shell
  // which sets Referer automatically.
  return false;
}

// EPIC-003-M002 / KI-M002E3-003 — what to do once a tablet write has been queued (optimistic 202).
// A queued write must still REACH the server; without this it just sits in the queue forever (the
// receiving confirm exposed it — the PO never flipped to Received). Pure decision so it's unit-tested
// in isolation; the SW entry (src/sw/index.ts) performs the two actions against `self`.
//   - replayNow:      when ONLINE, run the replay loop immediately so an online confirm posts at once.
//   - registerSync:   always register Background Sync so an OFFLINE write flushes on reconnect (and as
//                     a backstop if the immediate replay fails). CR-DC-069 — browsers without
//                     Background Sync fall back to the page's DRAIN_QUEUE messages, posted on
//                     reconnect, on app start and when the tablet is picked up
//                     (src/components/tablet/QueueDrainTriggers.tsx). The old claim here named the
//                     page's online-event RETRY_ALL, which replayed nothing and never looked at a
//                     `queued` row, so there was in fact no fallback at all.
export interface QueueFlushPlan {
  readonly replayNow: boolean;
  readonly registerSync: boolean;
}

export function planQueueFlush(isOnline: boolean): QueueFlushPlan {
  return { replayNow: isOnline, registerSync: true };
}

// EPIC-003-M002 / REV-9 — the SW only mediates SAME-ORIGIN `/api/*` requests (offline-queue writes,
// auth, and Bearer injection on tablet reads/writes). Every cross-origin request must pass straight
// through to the network untouched, for two reasons:
//   1. token-leak guard (SEC-AUTH-013): the SW-held station Bearer must NEVER be attached to a
//      cross-origin request.
//   2. the QC photo upload (C.1) does a cross-origin PUT to a Supabase Storage signed upload URL fired
//      from the `/tablet-pwa` surface. Without this guard the write branch caught it, tried to send it
//      with the station Bearer + credentials:"include" (which Supabase's signed URL rejects/CORS-fails),
//      the send threw → it was queued → the replay loop retried it forever ("continuously syncing").
// Pure so the entry-point guard (src/sw/index.ts holds `self.location`) stays unit-testable.
export function isSameOriginApiUrl(requestUrl: string, swOrigin: string): boolean {
  try {
    const url = new URL(requestUrl);
    return url.origin === swOrigin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

// Production tablet-flow detection uses the controlled client URL, not request headers. The SW entry
// resolves event.clientId via clients.get() and passes this predicate into handleTabletRead/Write.
// Browser-admin clients and cross-origin clients must never receive the station Bearer token.
function isTabletClientUrl(
  settings: FetchHandlerSettings,
  clientUrl: string | null | undefined,
  swOrigin: string,
): boolean {
  if (clientUrl === null || clientUrl === undefined || clientUrl.length === 0) return false;
  try {
    const url = new URL(clientUrl);
    return url.origin === swOrigin && settings.isTabletSurfacePath(url.pathname);
  } catch {
    return false;
  }
}

export interface FetchHandler {
  queueFullResponse(idempotencyKey: string): Response;
  handleAuthRequest(request: Request, deps: AuthRequestDeps): Promise<Response | null>;
  handleTabletWrite(request: Request, deps: FetchHandlerDeps): Promise<Response | null>;
  handleTabletRead(request: Request, deps: FetchHandlerDeps): Promise<Response | null>;
  defaultIsTabletFlowRequest(request: Request): boolean;
  isTabletClientUrl(clientUrl: string | null | undefined, swOrigin: string): boolean;
}

/** Bind the app's settings once. Every function below has the signature the DC has always called. */
export function createFetchHandler(settings: FetchHandlerSettings): FetchHandler {
  return {
    queueFullResponse: (key) => queueFullResponseImpl(settings, key),
    handleAuthRequest: (request, deps) => handleAuthRequestImpl(settings, request, deps),
    handleTabletWrite: (request, deps) => handleTabletWriteImpl(settings, request, deps),
    handleTabletRead: (request, deps) => handleTabletReadImpl(settings, request, deps),
    defaultIsTabletFlowRequest: (request) => defaultIsTabletFlowRequest(settings, request),
    isTabletClientUrl: (clientUrl, swOrigin) => isTabletClientUrl(settings, clientUrl, swOrigin),
  };
}

function defaultNow(): Date {
  return new Date();
}

const SERVER_DERIVED_HEADERS = new Set(["host", "cookie", "origin"]);

function serialiseHeaders(headers: Headers): Record<string, string> {
  // Skip headers the server will re-derive (Origin, Host, Cookie) — these
  // change on replay and shouldn't be persisted verbatim.
  const entries: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    if (!SERVER_DERIVED_HEADERS.has(key)) entries.push([key, value]);
  });
  return Object.fromEntries(entries);
}
