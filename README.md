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
| `./schema`                    | The IndexedDB schema and **`openQueueDb(dbName)`**. `DB_VERSION = 4` and the v1→…→v4 upgrade code. |
| `./queue`                     | enqueue / dequeue / retry / discard / held-write APIs, the synced-history retention (200).         |
| `./idempotency`               | The `Idempotency-Key` header and UUID v4 generator.                                                |
| `./sync-protocol`             | Page ↔ worker message types and `askServiceWorker()`.                                              |
| `./token-storage`             | Worker-protected session storage (SEC-AUTH-013) and the idle / expiry predicates.                  |
| `./read-cache`                | The device-side read cache: identity-keyed, two bounds, quota-refusal drop. `createReadCache(...)`. |
| `./settings`                  | **`QueueWorkerSettings`** — the one typed object an app hands over.                                |
| `./sw/install`                | **`installQueueWorker(self, settings)`** — the whole listener wiring.                              |
| `./sw/fetch-handler`          | Tablet write / read handling, auth passthrough. `createFetchHandler(...)`.                         |
| `./pre-update-clear`          | The one-off clear of pre-fix rows: `clearPreUpdateWrites`, the marker, `readPreUpdateClear`.       |
| `./sw/pre-update-clear`       | The worker half: `runPreUpdateClear`, `reportPreUpdateClears` (the audit report).                  |
| `./sw/global-fetch`           | `globalFetch` — the `this`-ignoring default `fetch`.                                               |
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

The **on-device format** is identical for every app: the five store names (`pending_writes`,
`sync_history`, `session_token`, `driver_reads`, `queue_maintenance`), the record fields (`warehouseId`, `stationId`,
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

Device-key signing of queued actions (TA-OFF-008) is **API-CHG-011 part b** and is not in this package yet —
no unused extension point ships. It arrives as a new version that a consumer opts into by bumping its pin.

## v0.4.0 — the live-only refusal tells held work from work that is only still sending (CR-DC-269)

**The defect.** v0.3.0 refused a live-only write with one fixed sentence, "still sending, wait a moment". When the
earlier work was HELD for someone else (they signed out, or it was saved under another station) that was untrue:
waiting never sends a held row and Send now cannot move it. Reviewer finding F2 on DC PR #523.

- **Two codes, one 409, nothing queued either way.** `EARLIER_WORK_HELD` when ANY waiting row is held (`getHeldWrites` for the live session, pre-update rows excluded — the Sync details predicate); otherwise `EARLIER_WORK_WAITING`, byte for byte as in v0.3.0. Both are exported (`EARLIER_WORK_WAITING_CODE`, `EARLIER_WORK_HELD_CODE`) from `sw/fetch-handler`.
- **One new REQUIRED setting, no defaults:** `earlierWorkHeldMessage` — the app's name-free fallback sentence. A page that knows more (time, station) may replace it; it branches on the code.
- The send order, the queue, the live-only set and the on-device format are unchanged (`DB_VERSION` stays 4). A consumer on v0.3.0 does not compile on v0.4.0 until it answers the new setting.

## v0.3.0 — the queue sends in the order it was saved (CR-DC-267)

**The rule.** Within one device queue, a row is never sent while an earlier row is still waiting — held (no
usable session, or another person's), backed off, or its send got no answer. A refused (`failed`) row, an
exhausted row, a pre-update row and a discarded cross-origin row never hold anything back. v0.2.0 stepped over
a row inside its backoff window and sent the next, so a later save overtook an earlier one (two pallets swapped
numbers on the packhouse, bananaworld-ph PR #55).

- **`runReplay`** — head-of-line block; a row behind a waiting one reports `skipped` / `behind-earlier` and is left untouched (no attempt counted).
- **Send timeout** — every replay send is bounded by `REPLAY_FETCH_TIMEOUT_MS` (30 s) with an abort signal; a hung request no longer stalls every later pass. A timeout takes the ordinary retryable path.
- **`getPendingWrites`** — `queued` and `syncing` share one rank (a stale `syncing` row is retried first), ties broken by insertion order.
- **An online save waits its turn** — with earlier work waiting, an ordinary write is queued (202) behind it; a live-only write is refused `409 EARLIER_WORK_WAITING`, nothing queued.
- **Two new REQUIRED settings, no defaults:** `isLiveOnlyWrite(requestUrl)` and `earlierWorkWaitingMessage`. An app that does not answer both does not compile.
- No on-device format change (`DB_VERSION` stays 4). The backoff schedule, attempt ceiling and refusal handling are unchanged.

## v0.2.0 — KI-227-01 fixed (CR-DC-240, carried in by CR-DC-227)

**KI-227-01 — a queued write never replayed in a real browser.** v0.1.0 kept the native `fetch` in a variable
and later called it as a method of another object (`ctx.fetchImpl(url, init)`). Chromium refuses that with
*"Illegal invocation"*, and the surrounding `catch` read it as "no signal", so no queued write ever reached a
server. v0.2.0 carries the DC's fix (CR-DC-240, live in production since 2026-10-11):

- **`sw/global-fetch`** — `globalFetch`, a `this`-ignoring wrapper, is the replay loop's default `fetch`, and the
  call itself is unbound (`const send = ctx.fetchImpl; send(…)`). Fenced by `tests/unit/sw/no-method-form-fetch.test.ts`.
- **DB_VERSION 4** — one new store, `queue_maintenance`; every row `enqueueWrite` writes now carries
  `replayGeneration`.
- **The pre-update clear** (`pre-update-clear`, `sw/pre-update-clear`) — rows WITHOUT `replayGeneration` were written
  by a worker that could never send; they are cleared ONCE on the first activation (before any replay, and again
  at the top of every replay pass), a record of what was cleared is kept (method, path, time, status — never a
  body), the app's audit door (`queueActionPath`, a new required setting) is told, and the snapshot carries
  `preUpdateCleared: { count, clearedAt }` for the panel.
- 🔴 **The marker travels with the database.** Its presence (`queue_maintenance` / `pre-update-clear-ki-227-01`) is
  what stops a second clear. The database name stays the app's setting, the store and the record id are the
  format — a tablet that already ran CR-DC-240 on the DC does NOT clear again after moving to the package. A
  fresh app (the packhouse) sweeps once over an empty queue and is then "done".
