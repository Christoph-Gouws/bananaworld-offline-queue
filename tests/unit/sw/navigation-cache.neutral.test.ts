// The response cache, bound to a NEUTRAL route set and NEUTRAL cache names (CR-DC-227). The DC's own
// 47-test navigation-cache suite keeps proving its driver routes through its binding.

import { describe, expect, it, vi } from "vitest";

import {
  TABLET_ASSET_CACHE_MAX_ENTRIES,
  TABLET_NAV_CACHE_MAX_ENTRIES,
  createNavigationCache,
  isCacheableStaticAsset,
  pruneCache,
} from "../../../src/sw/navigation-cache";
import { NEUTRAL_SETTINGS } from "../../support/neutral-settings";
import { fakeCaches, ORIGIN } from "../../support/fakes";

const nav = NEUTRAL_SETTINGS.navigation;
const cache = createNavigationCache(nav);

function navigation(path: string): Request {
  const req = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(req, "mode", { value: "navigate", configurable: true });
  return req;
}

const throwing = (() => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

describe("which requests are the cache's — decided by the SETTINGS", () => {
  it("only a navigate GET to one of the app's routes, on the worker's own origin", () => {
    expect(cache.isDriverNavigation(navigation("/station"), ORIGIN)).toBe(true);
    expect(cache.isDriverNavigation(navigation("/station/job/42"), ORIGIN)).toBe(true);
    expect(cache.isDriverNavigation(navigation("/station/other"), ORIGIN)).toBe(false);
    expect(cache.isDriverNavigation(navigation("/tablet-pwa"), ORIGIN)).toBe(false);
    expect(cache.isDriverNavigation(new Request(`${ORIGIN}/station`), ORIGIN)).toBe(false);
    expect(cache.isDriverNavigation(navigation("/station"), "https://elsewhere.test")).toBe(false);
  });

  it("static assets are the build's content-hashed chunks, same origin only", () => {
    expect(isCacheableStaticAsset(new Request(`${ORIGIN}/_next/static/a.js`), ORIGIN)).toBe(true);
    expect(isCacheableStaticAsset(new Request(`${ORIGIN}/other/a.js`), ORIGIN)).toBe(false);
    expect(isCacheableStaticAsset(new Request("https://cdn.test/_next/static/a.js"), ORIGIN)).toBe(
      false,
    );
  });
});

describe("documents — network first, the cached copy on failure, under the SETTINGS' cache name", () => {
  it("stores a good response under a bare key in the settings' nav cache, and serves it when the network throws", async () => {
    const fake = fakeCaches();
    const keep: Promise<unknown>[] = [];
    const ok = vi.fn(async () => new Response("<html>station</html>", { status: 200 }));
    await cache.handleDriverNavigation(navigation("/station?x=1"), {
      caches: fake.storage,
      fetchImpl: ok as unknown as typeof fetch,
      keepAlive: (p) => keep.push(p),
    });
    await Promise.all(keep);
    expect(fake.names()).toEqual([nav.navCache]);
    expect(fake.entries(nav.navCache)).toEqual([`${ORIGIN}/station`]);

    const served = await cache.handleDriverNavigation(navigation("/station"), {
      caches: fake.storage,
      fetchImpl: throwing,
    });
    expect(await served.text()).toBe("<html>station</html>");
  });

  it("on a miss the original rejection is re-thrown (the browser shows its own offline page)", async () => {
    await expect(
      cache.handleDriverNavigation(navigation("/station"), {
        caches: fakeCaches().storage,
        fetchImpl: throwing,
      }),
    ).rejects.toThrow("Failed to fetch");
  });
});

describe("the warm — an API read implies page documents, per the SETTINGS' mapping", () => {
  it("warms exactly the pages the app's mapping names, into the settings' nav cache, fetched WITHOUT a Bearer", async () => {
    const fake = fakeCaches();
    const keep: Promise<unknown>[] = [];
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: Request | string) => {
      seen.push(typeof input === "string" ? input : input.url);
      return new Response("doc", { status: 200 });
    });
    cache.warmDriverPages("/api/runs/stop/s9", {
      caches: fake.storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      keepAlive: (p) => keep.push(p),
    });
    await Promise.all(keep);
    expect(seen).toEqual(["/station/job/s9"]);
    expect(fake.entries(nav.navCache)).toHaveLength(1);
  });

  it("a read the mapping does not name warms nothing (an allowlist by construction)", async () => {
    const fake = fakeCaches();
    const fetchImpl = vi.fn();
    cache.warmDriverPages("/api/something/else", {
      caches: fake.storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.names()).toEqual([]);
  });
});

describe("bounds — oldest out, but the app's entry-point documents go LAST", () => {
  it("the document cache is bounded and the settings' base documents survive eviction", async () => {
    const fake = fakeCaches();
    const store = await fake.storage.open(nav.navCache);
    // The entry point goes in FIRST — insertion order is eviction order, which is exactly the defect
    // the protection exists to prevent.
    await store.put(`${ORIGIN}${nav.baseDocuments[0]}`, new Response("home"));
    for (let i = 0; i < TABLET_NAV_CACHE_MAX_ENTRIES + 10; i += 1) {
      await store.put(`${ORIGIN}/station/job/${i}`, new Response("doc"));
    }
    await cache.pruneNavCache(store);
    const kept = fake.entries(nav.navCache);
    expect(kept).toHaveLength(TABLET_NAV_CACHE_MAX_ENTRIES);
    expect(kept).toContain(`${ORIGIN}/station`);
    // …and a bound on the asset cache without any protection, as before.
    const assets = await fake.storage.open(nav.assetCache);
    for (let i = 0; i < TABLET_ASSET_CACHE_MAX_ENTRIES + 3; i += 1) {
      await assets.put(`${ORIGIN}/_next/static/${i}.js`, new Response("js"));
    }
    expect(await cache.pruneAssetCache(assets)).toBe(3);
  });

  it("pruneCache skips a protected entry rather than counting it as deleted", async () => {
    const fake = fakeCaches();
    const store = await fake.storage.open("c");
    for (const name of ["a", "b", "c", "d"])
      await store.put(`${ORIGIN}/${name}`, new Response(name));
    const deleted = await pruneCache(store, 2, (raw) => raw.endsWith("/a"));
    expect(deleted).toBe(2);
    expect(fake.entries("c")).toEqual([`${ORIGIN}/a`, `${ORIGIN}/d`]);
  });
});
