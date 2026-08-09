import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  calculateActualTokenUsage,
  registerCodexTelemetry,
} from "../extensions/codex-usage-telemetry.ts";
import {
  appendTokenTelemetryEvent,
  flushTokenTelemetryEvents,
  listTokenUsageDimensions,
  openTokenUsageDb,
  queryTokenUsageAggregate,
  queryTokenUsageEvents,
} from "../extensions/codex-usage-store.ts";
import { buildUsageTrendSeries } from "../extensions/codex-usage-trend.ts";

function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "codex-usage-telemetry-"));
}

function codexEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: `evt-${Math.random()}`,
    timestamp: "2026-08-08T12:00:00.000Z",
    eventType: "message_end",
    provider: "openai-codex",
    model: "gpt-5-codex",
    messageRole: "assistant",
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    costTotal: 0.25,
    ...overrides,
  };
}

test("actual token usage includes normalized cache reads and writes without using context length", () => {
  assert.deepEqual(
    calculateActualTokenUsage({
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      totalTokens: 210,
      cost: {},
    }),
    {
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      total: 210,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
    },
  );
  assert.equal(
    calculateActualTokenUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    }).total,
    210,
  );
  assert.equal(
    calculateActualTokenUsage({
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 10,
      totalTokens: 205,
    }).total,
    205,
  );
});

test("Codex usage store persists events, aggregates dimensions, and builds history", async () => {
  const agentDir = await tempDir();
  try {
    appendTokenTelemetryEvent(codexEvent({ id: "first" }), agentDir);
    appendTokenTelemetryEvent(
      codexEvent({
        id: "second",
        timestamp: "2026-08-08T15:00:00.000Z",
        totalTokens: 300,
      }),
      agentDir,
    );
    const events = queryTokenUsageEvents({ agentDir, limit: 10 });
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.provider === "openai-codex"));
    const rows = queryTokenUsageAggregate({
      agentDir,
      from: "2026-08-08T00:00:00.000Z",
      to: "2026-08-09T00:00:00.000Z",
      groupBy: ["provider_model"],
    });
    assert.equal(rows[0]?.total_tokens, 450);
    assert.equal(rows[0]?.provider_model, "openai-codex/gpt-5-codex");
    assert.ok(listTokenUsageDimensions().includes("capability"));
    const trend = buildUsageTrendSeries(agentDir, {
      now: "2026-08-09T00:00:00.000Z",
      days: 1,
      bucketHours: 3,
    });
    assert.equal(trend.total_tokens, 450);
    assert.ok(trend.points.some((point) => point.total_tokens > 0));
    assert.throws(
      () =>
        appendTokenTelemetryEvent(
          codexEvent({ provider: "anthropic" }),
          agentDir,
        ),
      /unsupported Codex usage provider/,
    );
  } finally {
    try {
      flushTokenTelemetryEvents(agentDir);
      openTokenUsageDb(agentDir).close();
    } catch {}
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("telemetry hooks record Codex sessions and ignore other providers", async () => {
  const agentDir = await tempDir();
  const handlers = new Map<
    string,
    Array<(event: any, ctx: any) => Promise<void>>
  >();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
      const entries = handlers.get(name) || [];
      entries.push(handler);
      handlers.set(name, entries);
    },
  } as unknown as ExtensionAPI;
  registerCodexTelemetry(pi, { agentDir });
  const context = {
    cwd: "/workspace",
    model: { provider: "openai-codex", id: "gpt-5-codex" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session-owner",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionName: () => "owner",
      getCwd: () => "/workspace",
    },
    rin: { frontendIdentity: { kind: "chat" }, agentDir },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: any) => {
    for (const handler of handlers.get(name) || [])
      await handler(event, context);
  };
  try {
    await emit("session_start", { reason: "startup" });
    await emit("message_end", {
      message: {
        id: "codex-message",
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5-codex",
        content: [{ type: "text", text: "done" }],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    await emit("message_end", {
      message: {
        id: "other-message",
        role: "assistant",
        provider: "anthropic",
        model: "claude",
        usage: { input: 999, output: 999 },
      },
    });
    await emit("agent_end", { messages: [] });
    const messages = queryTokenUsageEvents({
      agentDir,
      filters: [{ key: "event_type", value: "message_end" }],
      limit: 10,
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.provider, "openai-codex");
    assert.equal(messages[0]?.source, "frontend:chat");
    assert.equal(messages[0]?.total_tokens, 120);
  } finally {
    try {
      openTokenUsageDb(agentDir).close();
    } catch {}
    await rm(agentDir, { recursive: true, force: true });
  }
});
