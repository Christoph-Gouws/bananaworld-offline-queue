// The NEUTRAL settings the package's own suites run against (CR-DC-227).
//
// 🔴 THESE ARE DELIBERATELY NOT THE DC'S VALUES. A package suite that ran against the DC's paths would
// pass while quietly depending on them, and the packhouse — whose paths differ — would inherit a green
// that proves nothing. Every route below is one the DC does not use, so a leaked DC literal inside the
// package fails a suite instead of hiding behind a coincidence.

import type { QueueWorkerSettings } from "../../src/settings";

export const NEUTRAL_DB_NAME = "neutral-offline-queue";

const NEVER_QUEUED = /^\/api\/labels\/(print|reprint)\/?$/;
const CACHED_READS = [/^\/api\/runs\/home\/?$/, /^\/api\/runs\/stop\/[^/]+\/?$/];

export const NEUTRAL_SETTINGS: QueueWorkerSettings = {
  dbName: NEUTRAL_DB_NAME,
  isTabletSurfacePath: (pathname) => pathname === "/station" || pathname.startsWith("/station/"),
  authPathPrefix: "/api/identity/",
  authLogoutPath: "/api/identity/logout",
  stationPairRedeemPath: "/api/stations/redeem",
  sessionRenewalPath: "/api/identity/renew",
  renewalThresholdMinutes: (autoLogoffMinutes) => Math.max(15, autoLogoffMinutes / 2),
  isNeverQueuedWrite: (requestUrl) => {
    try {
      return NEVER_QUEUED.test(new URL(requestUrl).pathname);
    } catch {
      return false;
    }
  },
  isCachedReadPath: (pathname) => CACHED_READS.some((re) => re.test(pathname)),
  isProtectedReadPath: (pathname) => /^\/api\/runs\/home\/?$/.test(pathname),
  queueFullCode: "NEUTRAL_FULL",
  queueFullMessage: "Neutral: not saved, this device is full.",
  navigation: {
    isRoutePath: (pathname) =>
      pathname === "/station" || /^\/station\/job\/[^/]+\/?$/.test(pathname),
    baseDocuments: ["/station"],
    pagesToWarm: (apiPath) => {
      if (/^\/api\/runs\/home\/?$/.test(apiPath)) return ["/station"];
      const stop = /^\/api\/runs\/stop\/([^/]+)\/?$/.exec(apiPath);
      return stop === null ? [] : [`/station/job/${stop[1]}`];
    },
    navCache: "neutral-nav-v1",
    assetCache: "neutral-assets-v1",
    navCachePrefix: "neutral-nav-",
    assetCachePrefix: "neutral-assets-",
  },
  shellCacheVersion: "neutral-shell-v1",
  managedCachePrefixes: ["neutral-shell-v0", "neutral-nav-", "neutral-assets-"],
  shellPrecacheAssets: ["/manifest.webmanifest"],
  backgroundSyncTag: "neutral-replay",
  buildId: "neutral-build",
};
