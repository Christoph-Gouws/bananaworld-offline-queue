// CR-DC-088 (Part 3) — THE PAGES MUST LOAD: the response-cache MECHANISM.
//
// CR-DC-227 — THIS FILE MOVED FROM THE DC (`src/sw/navigation-cache.ts`). The mechanism — network-first
// documents, cache-first chunks, the touch-on-hit LRU, the bounded prune that holds the entry point
// back — is the package's and is what it was. What names the DC's own driver routes is NOT here: the
// route pattern, the entry-point documents, the API-read → page-warm mapping and the cache names are
// `NavigationSettings`, passed in once through `createNavigationCache`. The DC's reasoning for WHICH
// routes (CR-DC-088 addendum B, CR-DC-101, CR-DC-201) stays in the DC's `src/sw/navigation-cache.ts`.
//
// ============================================================================
// 🔴 THIS CACHE HOLDS DOCUMENTS AND NOTHING ELSE — `ignoreVary` DEPENDS ON IT
// ============================================================================
// Every lookup below passes `{ ignoreSearch: true, ignoreVary: true }` (D-8). `ignoreVary` is SAFE
// ONLY BECAUSE `TABLET_NAV_CACHE` holds documents and nothing else: no branch of this worker ever
// puts an RSC payload, an API response or a variant-negotiated body in it. 🔴 IF A LATER CHANGE EVER
// CACHES AN RSC PAYLOAD IN THIS CACHE, `ignoreVary` BECOMES A DEFECT — it would let a document
// request be answered with a flight payload. Put it in its own cache instead.

import type { NavigationSettings } from "../settings";

/**
 * The build's static chunks.
 *
 * ⚠ MEASURED THIS BUILD, AND THE MEASUREMENT IS NARROWER THAN THE BOUND — SAID PLAINLY RATHER THAN
 *   ROUNDED UP (revision 2, open question 2). `.next/app-build-manifest.json` declares **30 distinct
 *   `/_next/static/` URLs** across the four driver routes plus receiving, once the shared root,
 *   polyfill and low-priority files are folded in. That is the STATICALLY DECLARED set; chunks
 *   pulled in later by a dynamic import are not in the manifest and are not counted, and the whole
 *   build ships 446 files under `.next/static/` as the absolute ceiling for any one generation.
 *   Method and figures: `runs/change-89/output/implementation-summary.md`.
 *
 * 120 was already above the measured 30, so this raise is NOT what makes the driver routes fit — the
 * eviction ORDER (D-11) was the actual defect. 300 buys room for the unmeasured dynamic imports plus
 * a second build generation living alongside the first after a deploy, which is the case that would
 * otherwise evict a working set mid-shift.
 *
 * ⚠ A HOUSEKEEPING BOUND, NOT A BUSINESS THRESHOLD. Nothing downstream reads it, and moving it
 *   changes only how many builds' chunks a tablet keeps.
 */
export const TABLET_ASSET_CACHE_MAX_ENTRIES = 300;

/**
 * The warmed page documents (D-10).
 *
 * 🔴 WITHOUT THIS BOUND THE WARM IS A LEAK. Revision 1's navigation cache held the handful of pages a
 *    driver had hard-navigated to, so it needed none. D-7 turns it into TWO DOCUMENTS PER STOP PER
 *    DAY, keyed by dispatch id, so a week of runs would accumulate hundreds of entries at tens of KB
 *    each — several MB on a device whose quota already runs out in practice (CR-DC-070). Addendum (A)
 *    applies to this cache exactly as it applies to the read store.
 *
 * 90 = the four base routes plus two documents for each of ~43 stops. Matched deliberately to the
 * read store's 80-entry stop budget (`DRIVER_READ_MAX_ENTRIES`) so the two stores cannot disagree
 * about how much of a day is retained.
 *
 * ⚠ CR-DC-201 — ONE document per stop now (the crate page is retired), and the read store likewise
 *   keeps one read per stop, so the same two bounds hold roughly twice the stops. NEITHER IS RAISED.
 *
 * ⚠ A HOUSEKEEPING BOUND, NOT A BUSINESS THRESHOLD.
 */
export const TABLET_NAV_CACHE_MAX_ENTRIES = 90;

/**
 * Is this one of the build's content-hashed static chunks, on our own origin?
 *
 * 🔴 A SHELL WITHOUT ITS CHUNKS RENDERS NOTHING, which is why Part 3 needs this second piece at all.
 *    These URLs are content-hashed and immutable, so cache-first is always correct and a new build
 *    simply populates new keys.
 *
 * ⚠ RELYING ON THE BROWSER'S HTTP CACHE INSTEAD WAS CONSIDERED AND REJECTED. Next serves these assets
 *   `immutable`, so it usually works — and "usually works" is the thing this change exists to end.
 *   The HTTP cache is also the first thing evicted under storage pressure, which is precisely the
 *   tablet this matters on.
 */
export function isCacheableStaticAsset(request: Request, swOrigin: string): boolean {
  if (request.method !== "GET") return false;
  try {
    const url = new URL(request.url);
    return url.origin === swOrigin && url.pathname.startsWith("/_next/static/");
  } catch {
    return false;
  }
}

export interface NavigationCacheDeps {
  /** Cache Storage — injectable so the decisions are unit-testable without a real worker. */
  caches: CacheStorage;
  /** Network fetch — injectable for deterministic tests. */
  fetchImpl?: typeof fetch;
  /** Keep the worker alive for a cache write that must not block the response (`event.waitUntil`). */
  keepAlive?: (p: Promise<unknown>) => void;
}

/**
 * Keep a cache inside its bound, oldest-out.
 *
 * `Cache.keys()` resolves in INSERTION order, so the front of the list is the oldest entry — the same
 * oldest-first discipline `pruneDriverReads` applies to the read store. With D-11's touch-on-hit in
 * place, "oldest inserted" is "least recently used".
 *
 * 🔴 CR-DC-101 (F2) — `isProtected` DEFAULTS TO "NOTHING IS PROTECTED", so `pruneAssetCache` is
 *    BYTE-IDENTICAL to what it was. The asset cache has no entry point to save: a chunk is a chunk,
 *    D-11's touch-on-hit already gives it a real LRU, and pinning one there would only mean a stale
 *    build's chunk outliving the build. The predicate is passed by `pruneNavCache` alone.
 *
 * ⚠ A PROTECTED ENTRY IS SKIPPED, NOT COUNTED AS DELETED — the loop walks past it and keeps going, so
 *   the bound is still enforced against the entries that CAN go. If every remaining entry is
 *   protected the loop runs out of keys and stops, which is why the protected set must be small and
 *   fixed (`DRIVER_BASE_DOCUMENTS`: two).
 *
 * @param isProtected receives the entry's RAW request URL (absolute, as `Cache.keys()` yields it).
 */
export async function pruneCache(
  cache: Cache,
  maxEntries: number,
  isProtected: (rawUrl: string) => boolean = () => false,
): Promise<number> {
  const keys = await cache.keys();
  let deleted = 0;
  for (const key of keys) {
    if (keys.length - deleted <= maxEntries) break;
    if (isProtected(key.url)) continue;
    await cache.delete(key);
    deleted += 1;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * D-8 — the ONE spelling of a navigation-cache key: origin + pathname, search and hash stripped.
 *
 * Stripping the search is what makes the returns deep link (`/tablet-pwa/returns?dispatch={id}`,
 * `DriverStationHome.tsx`) resolve to the one stored returns shell instead of missing.
 *
 * 🔴 CR-DC-101 (F1) — THE REASON IT CANNOT CROSS STOPS, CORRECTED. This said "the other three routes
 *    carry their id in the PATH, not the query", which was true of three routes and silent about the
 *    fourth: the returns page DID bake `?dispatch=` into its document, so stripping the search here
 *    served stop A's document for stop B. The true reason is now stronger and covers all four: NO
 *    DRIVER DOCUMENT DEPENDS ON THE QUERY AT ALL. The returns page is a bare shell and
 *    `ReturnsFloorFlow` reads the id on mount, so the one stored returns shell is the correct answer
 *    for every `?dispatch=`. The source fence in `navigation-cache.test.ts` is what keeps it true.
 */
function navCacheKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * D-8 — the match options for a DOCUMENT lookup, and the reason each one is there.
 *
 * 🔴 `ignoreVary` removes the whole class of Next `Vary` failure, and is safe ONLY because
 *    `TABLET_NAV_CACHE` holds documents and nothing else (see the file header).
 * 🔴 `ignoreSearch` is what makes the returns deep link resolve to the one stored returns shell.
 *
 * ⚠ ASSERTED FROM THE CACHE API SPEC AND NEXT'S RESPONSE HEADERS, NOT MEASURED IN CI. A wrong reading
 *   here looks exactly like "the cache is empty", which is why it is step 3 of the device verification.
 *
 * ⚠ DELIBERATELY NOT APPLIED TO THE ASSET CACHE. Chunk URLs are content-hashed and exact; loosening a
 *   lookup that is already exact only widens what could match.
 */
const DOCUMENT_MATCH: CacheQueryOptions = { ignoreSearch: true, ignoreVary: true };

/** `caches.match` scoped to ONE named cache, so a hit can never come from another cache's copy. */
async function matchIn(
  cacheStorage: CacheStorage,
  cacheName: string,
  request: Request | string,
  options?: CacheQueryOptions,
): Promise<Response | undefined> {
  try {
    const cache = await cacheStorage.open(cacheName);
    return await cache.match(request, options);
  } catch {
    return undefined;
  }
}

/**
 * Bind the app's navigation settings once. Every function returned has the signature the DC has
 * always called; only the four values that name the app's own routes and caches come from `settings`.
 */
export function createNavigationCache(settings: NavigationSettings) {
  const TABLET_NAV_CACHE = settings.navCache;
  const TABLET_ASSET_CACHE = settings.assetCache;
  const DRIVER_BASE_DOCUMENTS = settings.baseDocuments;
  const driverPagesToWarm = settings.pagesToWarm;
  const isDriverRoutePath = settings.isRoutePath;

  /**
   * Is this a document navigation to one of the driver routes, on our own origin?
   *
   * 🔴 `request.mode === "navigate"` IS PART OF THE PREDICATE, not decoration. It is what keeps this
   *    cache to DOCUMENTS and off every other GET the page makes — and `ignoreVary` on every lookup is
   *    only defensible because of it (see this file's header).
   *
   * ⚠ WHAT THIS PREDICATE DOES *NOT* SEE, STATED PLAINLY: a SOFT (`next/link`) navigation fetches an
   *   RSC payload, not a document, and its mode is `"cors"` — so it is neither cached nor served here,
   *   and revision 1's claim that Next's router falls back to a full page load was ASSERTED, NEVER
   *   PRESSED ON A DEVICE. Revision 2 does not rely on it for the common case: when a driver screen's
   *   data came from the device, the app already knows there is no signal and renders its navigations
   *   as plain `<a href>` / `window.location.assign` (D-9, `src/components/tablet/offline-navigation.tsx`),
   *   which IS a document navigation and does reach this function. The one residual case — home loaded
   *   online, signal lost afterwards, driver taps a `<Link>` — is verification step 6 in
   *   `runs/change-89/evidence/user-verification-steps.md`, to be RECORDED either way. A source scan
   *   cannot see a control that does not work (DEF-ADJ04-01).
   */
  function isDriverNavigation(request: Request, swOrigin: string): boolean {
    if (request.method !== "GET") return false;
    if (request.mode !== "navigate") return false;
    try {
      const url = new URL(request.url);
      return url.origin === swOrigin && isDriverRoutePath(url.pathname);
    } catch {
      return false;
    }
  }

  /**
   * D-7 — pull down the page DOCUMENTS a successful driver-station read implies, while there is signal.
   *
   * 🔴 THIS IS WHAT MAKES PART 3 WORK AT ALL. See this file's revision-2 header: without it the
   *    navigation cache is empty for every stop and a driver in a dead zone gets the browser's offline
   *    page. Delete this call and `tests/unit/sw/driver-page-warm.test.ts` reddens.
   *
   * Design notes, each load-bearing:
   *
   * - **Worker-side, off the read the prefetch pass already makes.** No new message type and no new
   *   page code, so the mapping and every Cache Storage call live in ONE testable module and
   *   `handleTabletRead` stays ignorant of Cache Storage.
   * - **Addendum (C) falls out for free.** The warm rides the same pass that refreshes the API
   *   snapshot, so every ONLINE home load re-fetches every stop document. No second trigger, no
   *   staleness gate, no once-a-day check.
   * - 🔴 **BEST-EFFORT AND NEVER BLOCKING.** Nothing awaits this from the response path; the whole warm
   *   goes to `keepAlive` (`event.waitUntil`) and is `.catch`-swallowed at source. A warm that rejects
   *   can never reject into `event.respondWith` and can never fail the read the driver is waiting on.
   * - 🔴 **A DOCUMENT THAT CANNOT BE CACHED IS DROPPED, SILENTLY** (addendum A). Never retried, never
   *   rethrown. The offline WRITE queue shares this origin's quota and a write that cannot be queued is
   *   LOST WORK, while a document that cannot be cached is only a degraded offline experience.
   * - **Fetched WITHOUT the station Bearer**, because these shells carry no operator data and this
   *   module must never see a token (SEC-AUTH-013).
   * - ⚠ **Cost, stated:** ~2 extra document fetches per stop on top of the 2 API reads. A 20-stop run is
   *   ~80 requests on yard wifi instead of ~40. Sequential and best-effort, same as the API walk.
   */
  function warmDriverPages(apiPath: string, deps: NavigationCacheDeps): void {
    const pages = driverPagesToWarm(apiPath);
    if (pages.length === 0) return;
    const warmed = (async () => {
      const cache = await deps.caches.open(TABLET_NAV_CACHE);
      for (const page of pages) {
        // Sequential and individually swallowed: one page that cannot be fetched or stored must never
        // stop the next one. Same shape as `prefetchRun`'s walk over the API reads.
        await warmOnePage(cache, page, deps).catch(() => {
          /* dropped silently — see this function's header */
        });
      }
    })().catch(() => {
      /* opening the cache can itself fail on a full device — dropped silently, same rule */
    });
    deps.keepAlive?.(warmed);
  }

  async function warmOnePage(cache: Cache, page: string, deps: NavigationCacheDeps): Promise<void> {
    // Defence in depth: `driverPagesToWarm` only ever emits driver routes, and this makes that a
    // property of the STORE rather than of one function's correctness.
    if (!isDriverRoutePath(page)) return;
    const doFetch = deps.fetchImpl ?? fetch;
    const response = await doFetch(page);
    if (!response.ok) return;
    await cache.put(page, response);
    await pruneNavCache(cache);
  }

  /**
   * A driver-route navigation: NETWORK FIRST, CACHED COPY ON FAILURE.
   *
   * 🔴 NETWORK FIRST, NEVER CACHE FIRST. The shell must be the CURRENT one whenever there is signal —
   *    a cache-first document would pin a driver to a stale build until the cache was swept, and the
   *    tablet reaching the new service worker at all is addendum (D)'s whole concern.
   *
   * 🔴 ON A MISS THE ORIGINAL REJECTION IS RE-THROWN, so the browser does exactly what it does today
   *    (its own offline page). Nothing about a tablet that has never been online changes.
   *
   * 🔴 D-8 — STORED UNDER A BARE, SEARCH-STRIPPED URL, NEVER UNDER THE INBOUND REQUEST. `Cache.match`
   *    honours the STORED response's `Vary` by default, and Next's App Router sets
   *    `Vary: RSC, Next-Router-State-Tree, Next-Url, Next-Router-Prefetch`. A document stored under a
   *    request that carried any of those headers would never match a plain navigation: the cache would
   *    be FULL and every lookup would MISS, which looks exactly like "the cache is empty". Storing
   *    under a bare URL string is precisely what a document navigation looks like on the wire.
   */
  async function handleDriverNavigation(
    request: Request,
    deps: NavigationCacheDeps,
  ): Promise<Response> {
    const doFetch = deps.fetchImpl ?? fetch;
    const key = navCacheKey(request.url);
    let response: Response;
    try {
      response = await doFetch(request);
    } catch (err) {
      const cached = await matchIn(
        deps.caches,
        TABLET_NAV_CACHE,
        key ?? request.url,
        DOCUMENT_MATCH,
      );
      if (cached !== undefined) return cached;
      throw err;
    }
    if (response.ok && key !== null) {
      const copy = response.clone();
      const stored = (async () => {
        const cache = await deps.caches.open(TABLET_NAV_CACHE);
        await cache.put(key, copy);
        await pruneNavCache(cache);
      })().catch(() => {
        // 🔴 A DOCUMENT THAT COULD NOT BE CACHED IS DROPPED, SILENTLY — the same rule as the read
        //    store, for the same reason: the origin quota is shared with the offline WRITE queue, and
        //    a write that cannot be queued is lost work while a document that cannot be cached is only
        //    a degraded offline experience.
      });
      deps.keepAlive?.(stored);
    }
    return response;
  }

  /**
   * A build chunk: CACHE FIRST (they are content-hashed and immutable), then network, then bounded.
   *
   * 🔴 D-11 — A HIT RE-`put`s THE ENTRY, AND WITHOUT THAT THE EVICTION ORDER IS BACKWARDS. `Cache.keys()`
   *    resolves in INSERTION order and `pruneCache` deletes from the FRONT, so a cache-first chunk that
   *    is used every single day never moves and is the FIRST evicted. On a shared tablet that also runs
   *    receiving, that means the DRIVER's chunks — fetched first at app start — go first, and a warmed
   *    stop document whose chunks have been evicted renders NOTHING offline. It would look like it
   *    worked in testing and fail in the field. `Cache.put` deletes the matching entry and appends, so
   *    re-putting on a hit moves the touched entry to the end and turns FIFO into a genuine LRU.
   *
   *    ⚠ Cost, stated: one Cache Storage write per asset REQUEST — tens per document load, not per
   *      interaction. Swallowed and non-blocking like every other write here.
   */
  async function handleStaticAsset(request: Request, deps: NavigationCacheDeps): Promise<Response> {
    const cached = await matchIn(deps.caches, TABLET_ASSET_CACHE, request);
    if (cached !== undefined) {
      const touch = cached.clone();
      const touched = (async () => {
        const cache = await deps.caches.open(TABLET_ASSET_CACHE);
        await cache.put(request, touch);
      })().catch(() => {
        /* a failed touch only costs this entry its place in the queue — dropped silently */
      });
      deps.keepAlive?.(touched);
      return cached;
    }

    const doFetch = deps.fetchImpl ?? fetch;
    const response = await doFetch(request); // a throw propagates — today's behaviour
    if (response.ok) {
      const copy = response.clone();
      const stored = (async () => {
        const cache = await deps.caches.open(TABLET_ASSET_CACHE);
        await cache.put(request, copy);
        await pruneAssetCache(cache);
      })().catch(() => {
        /* dropped silently — see handleDriverNavigation */
      });
      deps.keepAlive?.(stored);
    }
    return response;
  }

  /**
   * The asset cache's bound.
   *
   * ⚠ NO PROTECT PREDICATE, DELIBERATELY — see `pruneCache`. This call is unchanged by CR-DC-101 and
   *   D-11's existing LRU cases must stay green with no edit.
   */
  async function pruneAssetCache(
    cache: Cache,
    maxEntries: number = TABLET_ASSET_CACHE_MAX_ENTRIES,
  ): Promise<number> {
    return pruneCache(cache, maxEntries);
  }

  /**
   * The warmed-document bound (D-10), with the entry point held back (CR-DC-101 F2).
   *
   * The two base documents are the LAST things evicted rather than the first. See
   * `DRIVER_BASE_DOCUMENTS` for what went wrong and why the bound itself is not raised.
   */
  async function pruneNavCache(
    cache: Cache,
    maxEntries: number = TABLET_NAV_CACHE_MAX_ENTRIES,
  ): Promise<number> {
    return pruneCache(cache, maxEntries, isDriverBaseDocument);
  }

  /**
   * Is this cache entry one of the two base documents?
   *
   * Compares PATHNAMES: `Cache.keys()` yields absolute URLs, while the warm puts under a bare path
   * string (`cache.put("/tablet-pwa", …)`, which the Cache API resolves against the worker's base URL)
   * and `handleDriverNavigation` puts under `${origin}${pathname}`. The fallback covers a store that
   * hands back the raw relative string it was given, so the protection cannot quietly stop matching.
   */
  function isDriverBaseDocument(rawUrl: string): boolean {
    try {
      return DRIVER_BASE_DOCUMENTS.includes(new URL(rawUrl).pathname);
    } catch {
      return DRIVER_BASE_DOCUMENTS.includes(rawUrl);
    }
  }

  return {
    isDriverNavigation,
    warmDriverPages,
    handleDriverNavigation,
    handleStaticAsset,
    pruneAssetCache,
    pruneNavCache,
  };
}

export type NavigationCache = ReturnType<typeof createNavigationCache>;
