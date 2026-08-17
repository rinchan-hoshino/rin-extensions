import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendTokenTelemetryEvent,
  closeCodexUsageStore,
} from "../extensions/codex-usage-store.ts";
import { buildUsageTrendSeries } from "../extensions/codex-usage-trend.ts";

function localDateKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

test("default usage trend groups the latest fourteen local calendar days", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "codex-usage-trend-"));
  const now = new Date(2026, 7, 13, 12, 0, 0, 0);
  const previousDay = new Date(2026, 7, 12, 23, 30, 0, 0);
  const currentDay = new Date(2026, 7, 13, 0, 30, 0, 0);
  try {
    appendTokenTelemetryEvent(
      {
        id: "previous-local-day",
        timestamp: previousDay.toISOString(),
        eventType: "message_end",
        provider: "openai-codex",
        totalTokens: 100,
        costTotal: 1.25,
      },
      agentDir,
    );
    appendTokenTelemetryEvent(
      {
        id: "current-local-day",
        timestamp: currentDay.toISOString(),
        eventType: "message_end",
        provider: "openai-codex",
        totalTokens: 200,
        costTotal: 2.5,
      },
      agentDir,
    );

    const trend = buildUsageTrendSeries(agentDir, { now });
    assert.equal(trend.bucket, "day");
    assert.equal(trend.points.length, 14);
    assert.equal(trend.start, localDateKey(new Date(2026, 6, 31, 12)));
    assert.equal(trend.end, localDateKey(now));
    assert.deepEqual(
      trend.points.slice(-2).map((point) => ({
        date: point.timestamp,
        tokens: point.total_tokens,
        cost: point.cost_total,
      })),
      [
        { date: localDateKey(previousDay), tokens: 100, cost: 1.25 },
        { date: localDateKey(currentDay), tokens: 200, cost: 2.5 },
      ],
    );
  } finally {
    closeCodexUsageStore(agentDir);
    await rm(agentDir, { recursive: true, force: true });
  }
});
