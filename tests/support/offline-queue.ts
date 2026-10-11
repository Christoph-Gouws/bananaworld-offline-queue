// A test-only barrel with the same export list as the DC's `@/lib/offline-queue`, so the suites ported
// from the DC run unchanged. It is NOT public surface: the package has no barrel on purpose.

export * from "./schema";
export * from "../../src/idempotency";
export * from "../../src/queue";
export * from "../../src/sync-protocol";
export * from "../../src/token-storage";
export {
  clearDriverReads,
  createReadCache,
  driverReadIdentity,
  driverReadKey,
  readCachedDriverRead,
  DRIVER_READ_MAX_BYTES,
  DRIVER_READ_MAX_ENTRIES,
  type DriverReadIdentity,
} from "../../src/read-cache";

import { createReadCache } from "../../src/read-cache";
import { NEUTRAL_SETTINGS } from "./neutral-settings";

export const { cacheDriverRead, pruneDriverReads } = createReadCache(NEUTRAL_SETTINGS);
