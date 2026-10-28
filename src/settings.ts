// The one typed object an app hands to `installQueueWorker` (CR-DC-227, packhouse API-CHG-005).
//
// 🔴 EVERY FIELD IS REQUIRED, AND NONE HAS A DEFAULT. The packhouse's paths differ from the DC's, so a
// setting that fell back to the DC's value would route a packhouse write under the wrong rule with no
// error anywhere. A forgotten setting is a TYPE error instead.
//
// What is deliberately NOT here — it is the ON-DEVICE FORMAT, owned by the package and identical for
// every app: the four store names, the record field names, `DB_VERSION`, the idempotency header, the
// replay backoff and attempt ceiling, the synced-history retention and the read-cache bounds.
// Renaming any of them would strand work queued on a tablet that updates mid-shift.

import type { ReadCacheSettings } from "./read-cache";

/** The response-cache half: which routes the worker keeps readable offline, and what the caches are called. */
export interface NavigationSettings {
  /** Pure predicate over a PATHNAME — is this one of the app's offline-readable document routes? */
  readonly isRoutePath: (pathname: string) => boolean;
  /**
   * The entry-point documents the bounded prune holds back last. 🔴 ONE LIST, NOT TWO: the same array
   * is what `pagesToWarm` returns for the app's home read, so what is warmed first is what is kept last.
   */
  readonly baseDocuments: readonly string[];
  /** Which page documents a successful API read implies. An allowlist: anything else returns []. */
  readonly pagesToWarm: (apiPath: string) => readonly string[];
  /** The two VERSIONED caches. A version bump retires the old copies at `activate`. */
  readonly navCache: string;
  readonly assetCache: string;
  /** The prefixes the `activate` sweep manages, so a version bump collects the previous generation. */
  readonly navCachePrefix: string;
  readonly assetCachePrefix: string;
}

export interface QueueWorkerSettings extends ReadCacheSettings {
  /** The IndexedDB database name. Origin-scoped, so two apps naming theirs alike cannot collide. */
  readonly dbName: string;
  /** The one spelling of "this pathname is the tablet shell" (CR-DC-084), shared with the page. */
  readonly isTabletSurfacePath: (pathname: string) => boolean;

  /** Auth endpoints are never queued: you cannot authenticate offline. */
  readonly authPathPrefix: string;
  /** Logout / auto-logoff goes live WITH the station token injected, for attribution. */
  readonly authLogoutPath: string;
  /** The station-pairing redeem door: live, never queued, never given a Bearer. */
  readonly stationPairRedeemPath: string;

  /**
   * The app's existing station-session audit door for queue actions (CR-DC-240). The pre-update clear
   * tells the office what it removed through it. Same-origin; the worker is its only caller.
   */
  readonly queueActionPath: string;

  /** The sliding-window renewal endpoint. Same-origin; the worker is its only caller. */
  readonly sessionRenewalPath: string;
  /** `max(grace, half the token's life)` — the app's session-lifetime rule, as minutes remaining. */
  readonly renewalThresholdMinutes: (autoLogoffMinutes: number) => number;

  /** The writes that must reach the server NOW or not at all (a print is a physical act). */
  readonly isNeverQueuedWrite: (requestUrl: string) => boolean;
  /** Which GETs are also stored on the device and served back when the live fetch THROWS. */
  readonly isCachedReadPath: (pathname: string) => boolean;

  /** The `code` on the 507 body. A flow branches on it; it is not shown to anyone. */
  readonly queueFullCode: string;
  /** The words the operator reads when the tablet is full. Single-line: it travels in a JSON body. */
  readonly queueFullMessage: string;

  /** CR-DC-267 — writes whose screen needs the office's answer NOW (refused, not queued, while earlier work waits). */
  readonly isLiveOnlyWrite: (requestUrl: string) => boolean;
  /** CR-DC-267 — the words the operator reads for that refusal. Single-line: it travels in a JSON body. */
  readonly earlierWorkWaitingMessage: string;
  /**
   * CR-DC-269 — the words for the SAME refusal when the earlier work is HELD for someone else (they
   * signed out, or it was saved under another station). Waiting never releases a held row, so
   * `earlierWorkWaitingMessage` would be untrue. This is the app's name-free fallback sentence; a page may
   * replace it with a fuller one. Single-line: it travels in a JSON body. Required, no default.
   */
  readonly earlierWorkHeldMessage: string;

  readonly navigation: NavigationSettings;

  /** The shell cache's current version name, and every cache name THIS worker owns is derived from it. */
  readonly shellCacheVersion: string;
  /** Names that start with one of these and are not current are deleted at `activate`. */
  readonly managedCachePrefixes: readonly string[];
  /** The assets precached at `install` and served cache-first. */
  readonly shellPrecacheAssets: readonly string[];

  /** The Background Sync tag the worker registers and answers. */
  readonly backgroundSyncTag: string;
  /** This worker's own version marker, put on every status snapshot (CR-DC-086). */
  readonly buildId: string;
}
