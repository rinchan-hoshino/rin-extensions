import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import i18nExtension, {
  readI18nCatalog,
  resolveI18nPath,
  WORKING_ANIMATION_INTERVAL_MS,
} from "../extensions/i18n.ts";

test("i18n extension reads semantic messages and owns working animation frames", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "rin-i18n-extension-"));
  try {
    await writeFile(
      resolveI18nPath(agentDir),
      JSON.stringify({
        "chat.commandResponses.reload": "Reloaded",
        chat: {
          commandResponses: { abort: "Stop", new: "New session" },
          compaction: { start: "Compact", summaryLine: "Done {tokens}" },
          runtime: { working: { frames: ["Working A", "", "Working B"] } },
        },
      }),
    );
    assert.deepEqual(readI18nCatalog(agentDir), {
      messages: {
        "command.abort.completed": "Stop",
        "session.new.completed": "New session",
        "extensions.reload.completed": "Reloaded",
        "session.compaction.started": "Compact",
        "session.compaction.summary": "Done {tokens}",
      },
      workingFrames: ["Working A", "Working B"],
    });
    await writeFile(resolveI18nPath(agentDir), "invalid");
    assert.deepEqual(readI18nCatalog(agentDir), {
      messages: {},
      workingFrames: [],
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("i18n extension alone advances working text and clears its session timer", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "rin-i18n-extension-"));
  let intervalCallback: (() => void) | undefined;
  const intervalToken = {} as NodeJS.Timeout;
  const clearedTokens: NodeJS.Timeout[] = [];
  t.mock.method(globalThis, "setInterval", ((
    callback: () => void,
    intervalMs: number,
  ) => {
    intervalCallback = callback;
    assert.equal(intervalMs, WORKING_ANIMATION_INTERVAL_MS);
    return intervalToken;
  }) as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", ((token: NodeJS.Timeout) => {
    clearedTokens.push(token);
  }) as typeof clearInterval);

  try {
    await writeFile(
      resolveI18nPath(agentDir),
      JSON.stringify({
        chat: {
          commandResponses: { new: "New session" },
          runtime: { working: { frames: ["Working A", "Working B"] } },
        },
      }),
    );
    const handlers = new Map<string, Function>();
    i18nExtension({
      on(name: string, handler: Function) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI);
    const messageCatalogs: unknown[] = [];
    const workingMessages: unknown[] = [];
    const ctx = {
      rin: { agentDir },
      ui: {
        setMessageCatalog(value: unknown) {
          messageCatalogs.push(value);
        },
        setWorkingMessage(value: unknown) {
          workingMessages.push(value);
        },
      },
    };

    handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(messageCatalogs, [
      { "session.new.completed": "New session" },
    ]);
    assert.deepEqual(workingMessages, ["Working A"]);
    messageCatalogs.length = 0;
    workingMessages.length = 0;
    handlers.get("resources_discover")?.({}, ctx);
    handlers.get("input")?.({}, ctx);
    assert.deepEqual(messageCatalogs, [
      { "session.new.completed": "New session" },
      { "session.new.completed": "New session" },
    ]);
    assert.deepEqual(workingMessages, ["Working A", "Working A"]);
    assert.equal(intervalCallback, undefined);

    handlers.get("agent_start")?.({}, ctx);
    assert.equal(typeof intervalCallback, "function");
    const tick = intervalCallback as unknown as () => void;
    tick();
    tick();
    assert.deepEqual(workingMessages.slice(-2), ["Working B", "Working A"]);

    handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(clearedTokens, [intervalToken]);

    handlers.get("agent_start")?.({}, ctx);
    handlers.get("session_shutdown")?.({}, ctx);
    assert.deepEqual(clearedTokens, [intervalToken, intervalToken]);
    assert.equal(messageCatalogs.length, 2);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
