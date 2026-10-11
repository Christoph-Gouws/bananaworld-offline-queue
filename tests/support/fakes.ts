// Shared fakes for the package's settings-bound suites: an in-memory Cache Storage and a fake
// ServiceWorkerGlobalScope. Neither models more than the decisions under test need.

import { vi } from "vitest";

export const ORIGIN = "https://app.neutral.test";

/**
 * A minimal in-memory Cache + CacheStorage. `put` DELETES BEFORE IT SETS, because that is what the
 * Cache API does and a plain `Map.set` on an existing key does not move it to the end — emulating
 * `put` as a bare `set` would make the touch-on-hit LRU look like it worked when it did not.
 */
export function fakeCaches(): {
  storage: CacheStorage;
  entries: (name: string) => string[];
  names: () => string[];
  drop: (name: string) => boolean;
} {
  const stores = new Map<string, Map<string, Response>>();
  const urlOf = (req: Request | string): string =>
    typeof req === "string" ? new URL(req, ORIGIN).toString() : req.url;
  const stripSearch = (raw: string): string => {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  };
  const open = async (name: string): Promise<Cache> => {
    let store = stores.get(name);
    if (store === undefined) {
      store = new Map();
      stores.set(name, store);
    }
    const s = store;
    return {
      match: async (req: Request | string, options?: CacheQueryOptions) => {
        const wanted = urlOf(req);
        const direct = s.get(wanted);
        if (direct !== undefined || options?.ignoreSearch !== true) return direct;
        const bare = stripSearch(wanted);
        for (const [key, res] of s) if (stripSearch(key) === bare) return res;
        return undefined;
      },
      put: async (req: Request | string, res: Response) => {
        const url = urlOf(req);
        s.delete(url);
        s.set(url, res);
      },
      add: async (req: Request | string) => {
        s.set(urlOf(req), new Response("precached"));
      },
      keys: async () => Array.from(s.keys()).map((u) => new Request(u)),
      delete: async (req: Request | string) => s.delete(urlOf(req)),
    } as unknown as Cache;
  };
  return {
    storage: {
      open,
      keys: async () => Array.from(stores.keys()),
      delete: async (name: string) => stores.delete(name),
    } as unknown as CacheStorage,
    entries: (name) => Array.from(stores.get(name)?.keys() ?? []),
    names: () => Array.from(stores.keys()),
    drop: (name) => stores.delete(name),
  };
}

type Listener = (event: unknown) => void;

/** A fake ServiceWorkerGlobalScope that records its listeners and lets a test fire them. */
export function fakeScope(options: { origin?: string; online?: boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const posted: unknown[] = [];
  const registeredSyncTags: string[] = [];
  const caches = fakeCaches();
  const clientList = [
    { url: `${ORIGIN}/station/job/1`, postMessage: (m: unknown) => posted.push(m) },
  ];
  const scope = {
    location: { origin: options.origin ?? ORIGIN },
    navigator: { onLine: options.online ?? true },
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      get: vi.fn(async (id: string) => (id === "tablet" ? clientList[0] : undefined)),
      matchAll: vi.fn(async () => clientList),
    },
    registration: {
      sync: {
        register: vi.fn(async (tag: string) => {
          registeredSyncTags.push(tag);
        }),
      },
    },
    addEventListener: (type: string, fn: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  };
  return {
    scope: scope as unknown as ServiceWorkerGlobalScope,
    caches,
    posted,
    registeredSyncTags,
    online: (value: boolean) => {
      scope.navigator.onLine = value;
    },
    count: (type: string) => listeners.get(type)?.length ?? 0,
    fire: (type: string, event: Record<string, unknown>) => {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

/** Collects what an event passed to `waitUntil`, so a test can await the worker's whole reaction. */
export function lifecycleEvent<T extends Record<string, unknown>>(extra: T) {
  const waits: Promise<unknown>[] = [];
  return {
    event: { ...extra, waitUntil: (p: Promise<unknown>) => void waits.push(p) },
    settled: async () => {
      await Promise.all(waits);
    },
  };
}
