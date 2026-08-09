import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import i18nExtension, {
  readChatPresentation,
  resolveI18nPath,
} from "../extensions/i18n.ts";

test("i18n extension reads command responses and working frames from its catalog", async () => {
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
    assert.deepEqual(readChatPresentation(agentDir), {
      commandResponses: {
        abort: "Stop",
        new: "New session",
        reload: "Reloaded",
        compactionStart: "Compact",
        compactionSummaryLine: "Done {tokens}",
      },
      workingFrames: ["Working A", "Working B"],
    });
    await writeFile(resolveI18nPath(agentDir), "invalid");
    assert.deepEqual(readChatPresentation(agentDir), {
      commandResponses: {},
      workingFrames: [],
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("i18n extension publishes presentation on session start and resource reload", () => {
  const handlers = new Map<string, Function>();
  i18nExtension({
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  const published: unknown[] = [];
  const ctx = {
    rin: { agentDir: "/missing" },
    ui: {
      rinChatPresentation(value: unknown) {
        published.push(value);
      },
    },
  };
  handlers.get("session_start")?.({}, ctx);
  handlers.get("resources_discover")?.({}, ctx);
  assert.equal(published.length, 2);
  assert.deepEqual(published[0], { commandResponses: {}, workingFrames: [] });
});
