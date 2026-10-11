// The message handlers bound to the neutral build id — the shape the ported suite expects.

import { createMessageHandlers } from "../../src/sw/message-handlers";
import { SW_BUILD_ID } from "./build-id";

export {
  shouldRenewAfterMessage,
  shouldReplayAfterMessage,
  type MessageHandlerDeps,
} from "../../src/sw/message-handlers";

export const { buildSyncSnapshot, handleMessage } = createMessageHandlers({ buildId: SW_BUILD_ID });
