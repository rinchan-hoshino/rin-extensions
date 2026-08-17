import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  contributeChatPlatform,
  createChatPlatformHost,
} from "./chat-platform-protocol.js";
import { OneBotPlatform } from "./onebot-platform.js";

export default function onebot(pi: ExtensionAPI) {
  contributeChatPlatform(pi, {
    apiVersion: 1,
    platform: "onebot",
    defaults: {
      reconnectBaseDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
    },
    create(input) {
      return new OneBotPlatform(
        createChatPlatformHost(input),
        input.dataDir,
        input.config,
        input.logger,
      );
    },
  });
}
