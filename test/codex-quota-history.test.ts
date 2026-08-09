import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  queryQuotaConsumptionSeries,
  recordCodexQuotaSnapshot,
} from "../extensions/codex-quota-history.ts";
import { closeCodexUsageStore } from "../extensions/codex-usage-store.ts";

function status(percentLeft: number, resetAt: string) {
  return {
    accountId: "acct-owner",
    windows: [
      {
        name: "weekly",
        percentLeft,
        resetAt,
        windowSeconds: 604800,
      },
    ],
  };
}

test("quota history measures official percent-left deltas and excludes resets", async () => {
  const agentDir = await mkdtemp(
    path.join(os.tmpdir(), "codex-quota-history-"),
  );
  try {
    recordCodexQuotaSnapshot(
      status(90, "2026-08-15T00:00:00.000Z"),
      agentDir,
      "2026-08-09T00:00:00.000Z",
    );
    recordCodexQuotaSnapshot(
      status(87.5, "2026-08-15T00:00:00.000Z"),
      agentDir,
      "2026-08-09T01:00:00.000Z",
    );
    recordCodexQuotaSnapshot(
      status(87.5, "2026-08-15T00:00:00.000Z"),
      agentDir,
      "2026-08-09T02:00:00.000Z",
    );
    recordCodexQuotaSnapshot(
      status(100, "2026-08-22T00:00:00.000Z"),
      agentDir,
      "2026-08-09T03:00:00.000Z",
    );
    recordCodexQuotaSnapshot(
      status(99, "2026-08-22T00:00:00.000Z"),
      agentDir,
      "2026-08-09T04:00:00.000Z",
    );
    const series = queryQuotaConsumptionSeries(agentDir, {
      windowName: "weekly",
      from: "2026-08-09T00:00:00.000Z",
      until: "2026-08-09T05:00:00.000Z",
    });
    assert.equal(series.consumedPercent, 3.5);
    assert.equal(series.peakConsumedPercent, 2.5);
    assert.deepEqual(
      series.points.map((point) => point.consumedPercent),
      [0, 2.5, 0, 0, 1],
    );
  } finally {
    closeCodexUsageStore(agentDir);
    await rm(agentDir, { recursive: true, force: true });
  }
});
