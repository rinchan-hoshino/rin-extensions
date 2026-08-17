import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createEventBus,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type {
  ChatPlatformContribution,
  ChatPlatformInput,
} from "../extensions/chat-platform-protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function platformInput(rootDir: string): ChatPlatformInput {
  return {
    agentDir: path.join(rootDir, "agent"),
    dataDir: path.join(rootDir, "data"),
    config: {},
    logger: {},
    receive() {},
    updateStatus() {},
    composeKey: (chatId, botId) => `test/${botId}:${chatId}`,
    beginRecovery() {},
    completeRecovery() {},
    async recoverInbound() {
      return {
        recovered: [],
        failures: [],
        deferred: [],
        retired: [],
        scopeHealthy: true,
      };
    },
  };
}

test("Pi public loader receives the private OneBot and Lark Chat platforms", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rin-platforms-"));
  const eventBus = createEventBus();
  const contributions: ChatPlatformContribution[] = [];
  eventBus.on("rin.chat.platform.v1", (value) => {
    contributions.push(value as ChatPlatformContribution);
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(tempRoot, "agent"),
    eventBus,
    additionalExtensionPaths: [
      path.join(root, "extensions", "onebot.ts"),
      path.join(root, "extensions", "lark.ts"),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await loader.reload();

  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(contributions.map((entry) => entry.platform).sort(), [
    "lark",
    "onebot",
  ]);
  for (const contribution of contributions) {
    assert.equal(contribution.apiVersion, 1);
    const platform = await contribution.create(platformInput(tempRoot));
    assert.equal(platform.bot.platform, contribution.platform);
    assert.equal(typeof platform.start, "function");
    assert.equal(typeof platform.stop, "function");
    await platform.stop();
  }
});

test("OneBot implementation is protocol-neutral about server products", () => {
  const files = [
    "onebot.ts",
    "onebot-platform.ts",
    "chat-platform-common.ts",
    "chat-platform-protocol.ts",
  ];
  const source = files
    .map((name) => fs.readFileSync(path.join(root, "extensions", name), "utf8"))
    .join("\n");
  const forbiddenProducts = [
    ["nap", "cat"],
    ["snow", "luma"],
  ].map((parts) => parts.join(""));
  for (const product of forbiddenProducts) {
    assert.equal(source.toLowerCase().includes(product), false);
  }
});
