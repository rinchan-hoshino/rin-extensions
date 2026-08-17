import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  contributeChatPlatform,
  createChatPlatformHost,
} from "./chat-platform-protocol.js";
import { LarkPlatform } from "./lark-platform.js";

export default function lark(pi: ExtensionAPI) {
  contributeChatPlatform(pi, {
    apiVersion: 1,
    platform: "lark",
    defaults: {
      markdownMode: "post",
      quoteReply: true,
    },
    create(input) {
      return new LarkPlatform(
        createChatPlatformHost(input),
        input.dataDir,
        input.config,
        input.logger,
      );
    },
  });
}
