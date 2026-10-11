// The package's schema bound to the NEUTRAL database name — the shape the ported suites (written
// against the DC's `@/lib/offline-queue/schema`) expect.

import { openQueueDb } from "../../src/schema";
import { NEUTRAL_DB_NAME } from "./neutral-settings";

export * from "../../src/schema";

export const DB_NAME = NEUTRAL_DB_NAME;

export async function openOfflineQueueDB(
  customOpen?: Parameters<typeof openQueueDb>[1],
): ReturnType<typeof openQueueDb> {
  return openQueueDb(DB_NAME, customOpen);
}
