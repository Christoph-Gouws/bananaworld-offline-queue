// The service-worker WIRING for the offline write queue — install / activate / fetch / message / sync
// (TECH-COMP-006). CR-DC-227: this is the body of the DC's `src/sw/index.ts`, moved verbatim into the
// package so the packhouse runs the same listeners instead of a copy. The app's serwist entry is now one
// call, `installQueueWorker(self, SETTINGS)`; everything an app can differ on is in `QueueWorkerSettings`.
//
// Lifecycle wiring:
//   - install:   precache the M006 shell assets (carry-forward), skipWaiting.
//   - activate:  drop M006 cache version + claim clients.
//   - fetch:     route POST/PUT/PATCH/DELETE from /tablet-pwa surface through
//                handleTabletWrite (queue + optimistic 202). Pass through GETs
//                with shell-asset precache + network-fallback (M006 pattern).
//   - message:   route SyncRequest typed messages to handleMessage, then — for the four types
//                shouldReplayAfterMessage names (RETRY_ALL, RETRY_WRITE, DRAIN_QUEUE,
//                STORE_SESSION_TOKEN) — run a replay pass. CR-DC-069; before it, "Retry" changed a
//                row's status in IndexedDB and sent nothing.
//   - sync:      Background Sync API; runs runReplay on reconnect.
//   - online (window-side): not observable from the SW at all. The PAGE observes it and posts
//     DRAIN_QUEUE (src/components/tablet/QueueDrainTriggers.tsx), which is also what it posts on app
//     start and when the tablet is picked up (`visibilitychange` → visible). 🔴 THERE IS NO
//     HEARTBEAT AND NO setInterval ANYWHERE IN THE SYNC PATH — an earlier version of this comment
//     claimed a 30-second one and a SYNC_STATUS_REQUEST that fired it; neither ever existed
//     (SYNC_STATUS_REQUEST only builds a snapshot). CR-DC-069 D-2 decided against building one: the
//     browser terminates an idle service worker and a timer inside it dies with it, and a page-side
//     clock costs a wake-up every tick all night on a battery-powered cold-room tablet.

import { openQueueDb, type OfflineQueueDB } from "../schema";
import type { QueueWorkerSettings } from "../settings";
import type { SyncRequest } from "../sync-protocol";
import { readStationSession, type StationSession } from "../token-storage";
import { createReadCache } from "../read-cache";
import { createFetchHandler, isSameOriginApiUrl, planQueueFlush } from "./fetch-handler";
import {
  createMessageHandlers,
  shouldRenewAfterMessage,
  shouldReplayAfterMessage,
} from "./message-handlers";
import { createNavigationCache, isCacheableStaticAsset } from "./navigation-cache";
import { reportPreUpdateClears, runPreUpdateClear } from "./pre-update-clear";
import { runReplay } from "./replay-loop";
import { createSessionRenewal } from "./session-renewal";
import { singleFlight } from "./single-flight";

/** The slice of a ServiceWorkerGlobalScope this wiring touches — the app passes its own `self`. */
export type QueueWorkerScope = ServiceWorkerGlobalScope;

export function installQueueWorker(self: QueueWorkerScope, settings: QueueWorkerSettings): void {
  // Bind the app's settings ONCE. Every function below has the signature the DC has always called.
  const { handleAuthRequest, handleTabletRead, handleTabletWrite, isTabletClientUrl } =
    createFetchHandler({
      isTabletSurfacePath: settings.isTabletSurfacePath,
      authPathPrefix: settings.authPathPrefix,
      authLogoutPath: settings.authLogoutPath,
      stationPairRedeemPath: settings.stationPairRedeemPath,
      isNeverQueuedWrite: settings.isNeverQueuedWrite,
      isCachedReadPath: settings.isCachedReadPath,
      readCache: createReadCache({ isProtectedReadPath: settings.isProtectedReadPath }),
      queueFullCode: settings.queueFullCode,
      queueFullMessage: settings.queueFullMessage,
    });
  const {
    handleDriverNavigation,
    handleStaticAsset,
    isDriverNavigation,
    warmDriverPages: warmDriverPageDocuments,
  } = createNavigationCache(settings.navigation);
  const { handleMessage, buildSyncSnapshot } = createMessageHandlers({ buildId: settings.buildId });
  const renewal = createSessionRenewal({
    renewalPath: settings.sessionRenewalPath,
    renewalThresholdMinutes: settings.renewalThresholdMinutes,
  });

  const CACHE_VERSION = settings.shellCacheVersion;

  // CR-DC-088 — every cache THIS worker owns. A cache named here survives `activate`; a cache whose
  // name merely starts with one of the MANAGED prefixes below and is NOT here is deleted, which is what
  // makes both new caches self-retiring when their version string moves.
  const CURRENT_CACHES: ReadonlySet<string> = new Set([
    CACHE_VERSION,
    settings.navigation.navCache,
    settings.navigation.assetCache,
  ]);
  const MANAGED_CACHE_PREFIXES = settings.managedCachePrefixes;

  // Lazy-opened DB handle — opened on first need; SW retains until terminated.
  let dbPromise: Promise<OfflineQueueDB> | null = null;
  function getDB(): Promise<OfflineQueueDB> {
    if (dbPromise === null) {
      dbPromise = openQueueDb(settings.dbName);
    }
    return dbPromise;
  }

  // CR-DC-068 — this now hands back the WHOLE station session (token, expiry, warehouse, station,
  // operator), not just the token and warehouse. The identity is what the replay loop compares a
  // queued row against before it will send it, and what the fetch handler stamps onto a row at
  // capture. It stays SW-internal: nothing here is reachable from page code (SEC-AUTH-013).
  async function readTokenFromDB(db: OfflineQueueDB): Promise<StationSession | null> {
    return readStationSession(db);
  }

  async function isTabletFlowEvent(event: FetchEvent): Promise<boolean> {
    if (event.clientId.length === 0) return false;
    const client = await self.clients.get(event.clientId);
    return isTabletClientUrl(client?.url, self.location.origin);
  }

  // EPIC-003-M002 / KI-M002E3-003 — flush the queue after a tablet write is accepted.
  //
  // Every tablet write is queued first (optimistic 202) even when online. Without a flush trigger the
  // write just sits in the queue and never reaches the server (the receiving confirm exposed this: the
  // PO never flipped to Received). So once a write is queued we:
  //   - if ONLINE: replay right away (so an online confirm posts within a moment) — fire-and-forget, with
  //     errors swallowed so a replay failure never breaks the 202 the page already has;
  //   - register Background Sync (`bananaworld-replay`) so an OFFLINE write flushes on reconnect even if
  //     the tab is gone. registration.sync is Chromium-only (TECH-FE-003 reference device); the
  //     immediate-replay path covers browsers without it, so the try/catch degrades gracefully.
  function flushQueueAfterWrite(): void {
    const plan = planQueueFlush(self.navigator.onLine);
    if (plan.replayNow) {
      // CR-DC-069 (Stage 05) — the `.catch` is what makes "errors swallowed" above TRUE. A bare
      // `void promise` does not swallow anything; it produces an unhandled rejection in the worker.
      // That was survivable while this was one of two triggers, but the pass is now single-flighted,
      // so a rejection is shared with every caller coalesced into the same run — including the
      // message handler, which catches its own. One uncaught sibling would still surface it.
      replayAndBroadcast().catch(() => {
        /* a replay failure is reported through the queue's own row state, never by throwing */
      });
    }
    if (plan.registerSync) {
      void registerBackgroundSync();
    }
  }

  // CR-DC-070 — tell every open tab that the device is out of room, so the pinned bar and the header
  // chip can say so on whatever screen the operator is looking at. `QUEUE_FULL_BACKOFF` was declared in
  // the sync protocol at M007 and NOTHING ever emitted it; this is the emitter.
  //
  // `includeUncontrolled: true` matches the existing broadcast in runReplayAndBroadcast — a tab that
  // has not yet been claimed still needs to hear this, because the write it just tried to make is the
  // one that failed.
  async function broadcastQueueFull(idempotencyKey: string): Promise<void> {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: "QUEUE_FULL_BACKOFF", idempotencyKey });
    }
  }

  async function registerBackgroundSync(): Promise<void> {
    try {
      const reg = self.registration as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      };
      await reg.sync?.register(settings.backgroundSyncTag);
    } catch {
      // Background Sync unavailable/denied. CR-DC-069 — the fallbacks are the online immediate-replay
      // path above and the page's DRAIN_QUEUE messages, posted on reconnect, on app start and when the
      // tablet is picked up (QueueDrainTriggers). Before that change the only stated fallback was the
      // page's online-event RETRY_ALL, which replayed nothing and never touched a `queued` row — so
      // Background Sync was in truth the ONLY thing that drained a queue on reconnect, and a tablet
      // without it stranded its work. Never let this throw into the fetch handler.
    }
  }

  // ---------------------------------------------------------------------------
  // install + activate (lifecycle)
  // ---------------------------------------------------------------------------

  self.addEventListener("install", (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_VERSION);
        await Promise.all(
          settings.shellPrecacheAssets.map((asset) =>
            cache.add(asset).catch((err) => {
              console.warn("[sw] failed to precache", asset, err);
            }),
          ),
        );
        await self.skipWaiting();
      })(),
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter(
              (k) =>
                !CURRENT_CACHES.has(k) &&
                MANAGED_CACHE_PREFIXES.some((prefix) => k.startsWith(prefix)),
            )
            .map((k) => caches.delete(k)),
        );
        // CR-DC-240 — clear the work a pre-fix worker saved, BEFORE claiming clients, so no sync / drain /
        // retry can run ahead of it. Failure is caught inside; a failed sweep never stops activation
        // (the replay pass runs it again, and the replay loop refuses pre-fix rows regardless).
        await runPreUpdateClear(await getDB());
        await self.clients.claim();
      })(),
    );
  });

  // ---------------------------------------------------------------------------
  // fetch — write interception + GET shell-cache (M006 carry-forward)
  // ---------------------------------------------------------------------------

  self.addEventListener("fetch", (event) => {
    const { request } = event;

    // Write methods: route through handleTabletWrite. The handler returns null
    // for browser-admin writes (so they pass through to network) and a 202
    // Response for tablet-flow writes (which become queue rows).
    if (request.method !== "GET") {
      // REV-9 — the SAME-ORIGIN /api/* gate lives HERE (mirroring the GET branch below), NOT in the
      // pure handler. A cross-origin write — notably the QC photo PUT to the Supabase signed upload URL,
      // fired from the /tablet-pwa surface — must pass straight through to the network: it must never
      // receive the SW-held station Bearer (token-leak guard, SEC-AUTH-013), and if the write queue
      // caught it the failed cross-origin send would be retried forever ("continuously syncing").
      if (!isSameOriginApiUrl(request.url, self.location.origin)) return;
      event.respondWith(
        (async () => {
          const db = await getDB();
          const readToken = () => readTokenFromDB(db);
          const isTabletFlow = await isTabletFlowEvent(event);
          // Auth (PIN login / logout / auto-logoff) goes live, never queued — login carries no token,
          // logout has the station token injected for attribution (EPIC-002-M002).
          const authResponse = await handleAuthRequest(request, { readToken });
          if (authResponse) return authResponse;
          const online = self.navigator.onLine;
          const response = await handleTabletWrite(request, {
            db,
            readToken,
            isTabletFlowRequest: () => isTabletFlow,
            // ONLINE → handleTabletWrite sends directly to the server + returns the real response
            // (KI-M002E3-004). OFFLINE → it queues + returns a 202.
            isOnline: () => online,
            // CR-DC-070 — the write could not be stored because the tablet is out of room. The handler
            // returns a 507 to the flow; this puts the same truth on every other open screen.
            onQueueFull: (key) => void broadcastQueueFull(key),
          });
          if (response) {
            // A 202 X-Queued-Locally means the write was QUEUED (offline path, or an online send that
            // failed mid-flight). Register Background Sync so it flushes on reconnect, and try a replay
            // now in case connectivity returned. A direct (online) send needs neither — it already
            // reached the server. (KI-M002E3-003/-004.)
            if (response.headers.get("X-Queued-Locally") === "true") {
              flushQueueAfterWrite();
            }
            return response;
          }
          // Non-tablet-flow write (browser admin) — pass through to network.
          return fetch(request);
        })(),
      );
      return;
    }

    // GET: shell assets served from the M006 precache; tablet-flow API reads get the SW-held station
    // Bearer injected (KI-M002E3-002 — the token is SW-only per SEC-AUTH-013, so only the SW can attach
    // it); everything else passes through to the network.
    const url = new URL(request.url);
    if (settings.shellPrecacheAssets.includes(url.pathname)) {
      event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
      return;
    }
    // Same-origin API reads only — the same-origin gate is HERE (not in the pure handler) so the SW-held
    // token can never be attached to a cross-origin request (token-leak guard, SEC-AUTH-013).
    if (isSameOriginApiUrl(request.url, self.location.origin)) {
      event.respondWith(
        (async () => {
          const db = await getDB();
          const readToken = () => readTokenFromDB(db);
          const isTabletFlow = await isTabletFlowEvent(event);
          const authed = await handleTabletRead(request, {
            db,
            readToken,
            isTabletFlowRequest: () => isTabletFlow,
            // CR-DC-088 — the driver's read cache is written AFTER the response has gone to the page.
            // `waitUntil` is what keeps this worker alive long enough for that write to land; without
            // it the browser is free to tear the worker down the moment `respondWith` settles, and a
            // tablet would reach the yard gate with an empty store.
            keepAlive: (p) => event.waitUntil(p),
            // 🔴 CR-DC-088 revision 2 (D-7) — THE OTHER HALF OF PART 3. A successful driver-station
            //    read also pulls down the PAGE DOCUMENTS it implies, so a stop the driver has never
            //    opened can still open in a dead zone. Without this the navigation cache holds only
            //    pages that were hard-navigated to, which for a stop is never.
            warmDriverPages: (path) =>
              warmDriverPageDocuments(path, { caches, keepAlive: (p) => event.waitUntil(p) }),
          });
          // null → not a tablet-flow API read (browser admin, or no token) → plain network passthrough.
          return authed ?? fetch(request);
        })(),
      );
      return;
    }

    // CR-DC-088 (Part 3) — THE PAGES MUST LOAD. A driver-route DOCUMENT is network-first with the
    // cached copy on failure; the build's content-hashed chunks are cache-first, because a shell
    // without its chunks renders nothing. Both are bounded and both are dropped silently if the device
    // refuses storage — the offline WRITE queue shares this origin's quota and must never be starved
    // by a cache that only makes reading nicer.
    //
    // 🔴 SCOPED TO FOUR DRIVER ROUTES, not the whole `/tablet-pwa/` tree — see navigation-cache.ts's
    //    header for the deliberate resolution of addendum (B).
    if (isDriverNavigation(request, self.location.origin)) {
      event.respondWith(
        handleDriverNavigation(request, { caches, keepAlive: (p) => event.waitUntil(p) }),
      );
      return;
    }
    if (isCacheableStaticAsset(request, self.location.origin)) {
      event.respondWith(
        handleStaticAsset(request, { caches, keepAlive: (p) => event.waitUntil(p) }),
      );
    }
    // All other GETs pass through to the network (browser default behaviour).
  });

  // ---------------------------------------------------------------------------
  // message — page ↔ SW protocol
  // ---------------------------------------------------------------------------

  self.addEventListener("message", (event) => {
    event.waitUntil(
      (async () => {
        const db = await getDB();
        const reply = await handleMessage(event.data, {
          db,
          isOnline: () => self.navigator.onLine,
        });
        // Reply via the MessageChannel port if the page sent one.
        if (event.ports[0]) {
          event.ports[0].postMessage(reply);
        }

        // CR-DC-069 — the send. handleMessage is deliberately pure queue-state manipulation with no
        // fetch dependency (which is why its unit tests are cheap and trusted), so the replay is
        // triggered HERE instead, from the entry that already owns replayAndBroadcast and already
        // broadcasts the result to every open tab (D-1 route (a)).
        //
        // 🔴 ORDERING IS LOAD-BEARING: the reply goes out FIRST. askServiceWorker times out at 1500 ms,
        // so awaiting a network drain before replying would hand the page `null` on any slow
        // connection and its toast would silently not appear. The UI catches up through the
        // SYNC_STATE_CHANGED + REPLAY_BATCH_COMPLETE broadcasts below.
        //
        // The drain runs INSIDE waitUntil so the worker stays alive for it, and its failure is caught
        // here: a drain that rejects must never reject the message lifecycle.
        const type = (event.data as SyncRequest | undefined)?.type;

        // CR-DC-071 — the session renewal. Same route (a) shape as the drain above and for the same
        // reason: `handleMessage` stays pure queue/session state with no fetch dependency, so the
        // network call lives here and the DECISION lives in a tested module (./session-renewal.ts).
        //
        // 🔴 SINGLE-FLIGHTED. Several tabs can be open on one tablet and each posts its own
        // SESSION_ACTIVITY; without coalescing they would race to mint, and the loser would overwrite
        // the winner's fresher token with a staler one. Nothing here throws: a renewal that cannot
        // happen (offline, refused, capped) leaves the session exactly as it was, and the page timer
        // still signs the operator out with the audited row.
        if (type !== undefined && shouldRenewAfterMessage(type)) {
          await renewSessionNow().catch(() => {
            /* a renewal failure is never fatal — the session simply runs out its remaining life */
          });
        }

        if (type !== undefined && shouldReplayAfterMessage(type)) {
          await replayAndBroadcast().catch(() => {
            /* a replay failure is reported through the queue's own row state, never by throwing */
          });
        }
      })(),
    );
  });

  // ---------------------------------------------------------------------------
  // sync — Background Sync API (Chrome on Android per TECH-FE-003)
  // ---------------------------------------------------------------------------

  self.addEventListener("sync", (event) => {
    const syncEvent = event as Event & { tag?: string; waitUntil: (p: Promise<unknown>) => void };
    if (syncEvent.tag !== settings.backgroundSyncTag) return;
    syncEvent.waitUntil(replayAndBroadcast());
  });

  // CR-DC-069 — SINGLE-FLIGHT. Six triggers now reach this function (a new write, Background Sync,
  // Retry all, Retry one, PIN sign-in, and the page's DRAIN_QUEUE on reconnect / app start /
  // pick-up), and several of them fire within milliseconds of each other the moment a tablet is picked
  // up on WiFi. Wrapping the pass means those coalesce into ONE run instead of racing each other
  // through `getPendingWrites`, which ranks `syncing` rows rather than excluding them. See
  // ./single-flight.ts for why the old "the syncing flip prevents this" comment was false.
  const replayAndBroadcast = singleFlight(runReplayAndBroadcast);

  // CR-DC-071 — one renewal at a time, for the same reason the replay pass is single-flighted: a
  // tablet can have several tabs open on the station shell and each posts its own SESSION_ACTIVITY.
  // Two concurrent mints would both succeed server-side and the second store would win, which could
  // leave the SHORTER-lived token in place. Coalescing removes the race entirely.
  const renewSessionNow = singleFlight(async (): Promise<void> => {
    const db = await getDB();
    await renewal.renewSessionIfDue({ db });
  });

  async function runReplayAndBroadcast(): Promise<void> {
    const db = await getDB();
    // CR-DC-240 — idempotent: one marker read once it has run. Every replay trigger passes through here,
    // so no replay can run before the pre-update clear has.
    await runPreUpdateClear(db);
    const outcomes = await runReplay({
      db,
      readToken: () => readTokenFromDB(db),
      // REV-9 follow-up — lets the loop discard any queued cross-origin write (e.g. a pre-fix QC photo
      // PUT) that can never sync, instead of retrying it forever.
      swOrigin: self.location.origin,
    });
    // CR-DC-240 — tell the office what the clear removed, once a usable session exists.
    await reportPreUpdateClears({
      db,
      readToken: () => readTokenFromDB(db),
      queueActionPath: settings.queueActionPath,
    });

    // Broadcast state change to every connected client tab so useSyncStatus()
    // refreshes immediately without polling.
    const snapshot = await buildSyncSnapshot({
      db,
      isOnline: () => self.navigator.onLine,
    });
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: "SYNC_STATE_CHANGED", snapshot });
    }
    const processed = outcomes.filter((o) => o.outcome === "synced").length;
    const failed = outcomes.filter((o) => o.outcome === "failed").length;
    for (const client of clients) {
      client.postMessage({ type: "REPLAY_BATCH_COMPLETE", processed, failed });
    }
  }
}
