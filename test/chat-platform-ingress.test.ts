import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkPlatform } from "../extensions/lark-platform.ts";
import { OneBotPlatform } from "../extensions/onebot-platform.ts";
import {
  createChatPlatformHost,
  type ChatPlatformInput,
} from "../extensions/chat-platform-protocol.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-ingress-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function input(
  agentDir: string,
  overrides: Partial<ChatPlatformInput> = {},
): ChatPlatformInput {
  return {
    agentDir,
    dataDir: path.join(agentDir, "data"),
    config: {},
    logger: {},
    receive() {},
    updateStatus() {},
    composeKey: (chatId, botId) => `chat/${botId}:${chatId}`,
    beginRecovery() {},
    completeRecovery() {},
    recoverInbound: async () => ({
      processed: 0,
      incomplete: 0,
      recovered: [],
      pending: [],
      failures: [],
      deferred: [],
      retired: [],
      scopeHealthy: true,
    }),
    ...overrides,
  };
}

test("onebot group ingress keeps the group card and account nickname", async () => {
  await withTempDir(async (agentDir) => {
    const platform = new OneBotPlatform(
      createChatPlatformHost(input(agentDir)),
      path.join(agentDir, "data"),
      { selfId: "1", url: "ws://127.0.0.1:9" },
      {},
    );
    const session = await (platform as any).buildSession({
      post_type: "message",
      message_type: "group",
      self_id: 1,
      group_id: 2000,
      user_id: 1000,
      message_id: 42,
      sender: { card: "Group Card", nickname: "Account Name" },
      message: "hello",
    });
    assert.equal(session.author.name, "Group Card");
    assert.equal(session.author.nickname, "Account Name");
  });
});

test("lark recovery remains owned by Chat through the platform context", async () => {
  await withTempDir(async (agentDir) => {
    const calls: Array<Record<string, unknown>> = [];
    const platform = new LarkPlatform(
      createChatPlatformHost(
        input(agentDir, {
          recoverInbound: async (botId, _fetchSince, options) => {
            calls.push({ botId, options });
            return {
              processed: 2,
              incomplete: 0,
              recovered: [],
              pending: [],
              failures: [],
              deferred: [],
              retired: [],
              scopeHealthy: true,
            };
          },
        }),
      ),
      path.join(agentDir, "data"),
      { appId: "app-id", appSecret: "secret" },
      {},
    );
    platform.bot.selfId = "open-id";
    await (platform as any).recoverLarkMessages();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.botId, "open-id");
  });
});

test("onebot thinking reactions use the QQ-visible protocol face", async () => {
  await withTempDir(async (agentDir) => {
    const platform = new OneBotPlatform(
      createChatPlatformHost(input(agentDir)),
      path.join(agentDir, "data"),
      { selfId: "1", url: "ws://127.0.0.1:9" },
      {},
    );
    const calls: any[] = [];
    (platform as any).callAction = async (action: string, params: unknown) => {
      calls.push({ action, params });
      return {};
    };
    await (platform as any).createReaction("2000", "42", "🤔");
    assert.deepEqual(calls, [
      {
        action: "set_msg_emoji_like",
        params: { message_id: 42, emoji_id: "212", set: true },
      },
    ]);
  });
});
