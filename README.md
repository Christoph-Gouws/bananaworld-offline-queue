# `@bananaworld/offline-queue`

The shared offline write queue for the Bananaworld estate's tablet apps. **Created at CR-DC-227**
(packhouse API-CHG-005) by moving the DC's queue out of `src/lib/offline-queue/`, `src/sw/` and
`src/components/tablet/QueueDrainTriggers.tsx` — byte for byte, with the DC's own routes turned into
settings. The DC consumes it; the packhouse consumes it from its EPIC-002. Neither may copy it.

Shipped as **TypeScript source** (no build step): consumers add it to Next.js `transpilePackages`, the same
way `@bananaworld/org-contract` is consumed. **There is no barrel** — every leaf is a subpath export.

## Leaves

| Subpath                       | What it is                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `./schema`                    | The IndexedDB schema and **`openQueueDb(dbName)`**. `DB_VERSION = 3` and the v1→v2→v3 upgrade code. |
| `./queue`                     | enqueue / dequeue / retry / discard / held-write APIs, the synced-history retention (200).         |
| `./idempotency`               | The `Idempotency-Key` header and UUID v4 generator.                                                |
| `./sync-protocol`             | Page ↔ worker message types and `askServiceWorker()`.                                              |
| `./token-storage`             | Worker-protected session storage (SEC-AUTH-013) and the idle / expiry predicates.                  |
| `./read-cache`                | The device-side read cache: identity-keyed, two bounds, quota-refusal drop. `createReadCache(...)`. |
| `./settings`                  | **`QueueWorkerSettings`** — the one typed object an app hands over.                                |
| `./sw/install`                | **`installQueueWorker(self, settings)`** — the whole listener wiring.                              |
| `./sw/fetch-handler`          | Tablet write / read handling, auth passthrough. `createFetchHandler(...)`.                         |
| `./sw/replay-loop`            | The replay pass: backoff 1/2/4/8/16/30 s, 100 attempts, the session gate.                          |
| `./sw/message-handlers`       | Page → worker messages. `createMessageHandlers({ buildId })`.                                      |
| `./sw/session-renewal`        | The sliding-window renewal. `createSessionRenewal(...)`.                                           |
| `./sw/navigation-cache`       | Network-first documents, cache-first chunks, bounded prune. `createNavigationCache(...)`.          |
| `./sw/single-flight`          | One in-flight pass at a time.                                                                      |
| `./react/QueueDrainTriggers`  | The page-side drain triggers (reconnect, app start, pick-up). Needs React as a peer dependency.   |

## Using it from an app

```ts
// src/sw/index.ts — the serwist entry (swSrc)
import { installQueueWorker } from "@bananaworld/offline-queue/sw/install";
import { APP_WORKER_SETTINGS } from "./app-settings";

declare const self: ServiceWorkerGlobalScope & { __SW_MANIFEST?: unknown };
installQueueWorker(self, APP_WORKER_SETTINGS);
const _manifest = self.__SW_MANIFEST; // serwist injects this; the entry must still mention it
```

`APP_WORKER_SETTINGS` is a `QueueWorkerSettings`. **Every field is required and none has a default**, so a
setting you forget is a compile error rather than a silent fall-back to another app's route. The fields:
the IndexedDB name, the tablet-surface predicate, the auth paths, the renewal path and threshold, the
never-queued writes, which GETs are cached offline (and which row the prune holds back), the full-device
code and words, the navigation routes / caches, the shell cache version, the Background Sync tag and the
worker's build id.

## What is the package's, and must not be renamed

The **on-device format** is identical for every app: the four store names (`pending_writes`,
`sync_history`, `session_token`, `driver_reads`), the record fields (`warehouseId`, `stationId`,
`operatorId` …), `DB_VERSION`, the idempotency header, the replay backoff and attempt ceiling, the
synced-history retention and the read-cache bounds. Renaming any of them strands work queued on a tablet
that updates mid-shift. The field name `warehouseId` is the DC's vocabulary living inside a shared format
— renaming it is a format migration, deliberately **not** done here (recorded as TD-227-01).

## The invariants the suites hold

- **SEC-AUTH-013 — the station token never leaves the worker.** The same-origin `/api/*` gate on both the
  write and read branches lives in `installQueueWorker`; the renewal endpoint is never given the logout's
  Bearer injection; an idle or lapsed session attaches no token and its write is queued instead.
- **A never-queued write is forwarded live with the Bearer, or not at all — it is never enqueued.**
- **The reply goes out before the drain starts** (`askServiceWorker` times out at 1500 ms).
- **The package names none of an app's routes.** A scan over `src/` (comments stripped) fails on
  `/tablet-pwa`, `driver-station`, `/api/auth`, `bananaworld-` and the rest.

The suites run against **neutral settings** (`tests/support/neutral-settings.ts`) that share no value with
the DC's, so a DC literal leaking into the package fails a suite instead of hiding behind a coincidence.
`pnpm test` also runs `tsc`-checked `@ts-expect-error` legs proving a missing setting is a type error.

## Stewardship and changing it

Proposed: the DC project stewards the package (the `org-contract` model, with the DC in Org Admin's place).
A change is an estate change run that **names every consumer**; consumers move only by bumping their pinned
commit SHA. A consumer never edits the package from its own repo.

Device-key signing of queued actions (TA-OFF-008) is **API-CHG-011 part b** and is not in v0.1.0 — no unused
extension point ships. It arrives as a new version that a consumer opts into by bumping its pin.

## Known defects (v0.1.0)

**KI-227-01 — a queued write never replays in a real browser.** `src/sw/replay-loop.ts` keeps the native
`fetch` in a variable (`const fetchImpl = deps.fetch ?? fetch`) and later calls it as a method of another
object (`ctx.fetchImpl(url, init)`). Chromium refuses that with *"Illegal invocation"*, and the surrounding
`catch` reads it as "no signal", so every replay attempt of every queued write retries with backoff for ever.
Unit suites never see it because they inject a stub `fetch`. It was found while proving the move in a real
browser; it is **byte-for-byte what the DC shipped**, so v0.1.0 carries it unchanged — fixing it changes
what tablets do (rows stuck on a device would start to send) and is the DC owner's decision, taken in a
change run that names every consumer. Verified fix: `fetch.bind(globalThis)`. The DC pins the defect with an
`it.fails` test that goes red the day it is fixed.

**Consumers must not assume the offline drain works until this is fixed.** The queue, its on-device format, the
idempotency key, the token confinement and the page-side triggers are unaffected; only the send is.
