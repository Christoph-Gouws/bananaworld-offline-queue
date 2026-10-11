// The worker half of the pre-update clear bound to the NEUTRAL audit path — the shape the suite ported
// from the DC (written against the DC's `@/sw/pre-update-clear`) expects.

import {
  reportPreUpdateClears as report,
  type PreUpdateReportDeps,
} from "../../src/sw/pre-update-clear";
import { NEUTRAL_SETTINGS } from "./neutral-settings";

export {
  PRE_UPDATE_REASON_CODE,
  REPORTS_PER_PASS,
  entityTypeOf,
  reasonTextFor,
  runPreUpdateClear,
} from "../../src/sw/pre-update-clear";

export const QUEUE_ACTION_PATH = NEUTRAL_SETTINGS.queueActionPath;

export function reportPreUpdateClears(
  deps: Omit<PreUpdateReportDeps, "queueActionPath">,
): Promise<void> {
  return report({ ...deps, queueActionPath: QUEUE_ACTION_PATH });
}
