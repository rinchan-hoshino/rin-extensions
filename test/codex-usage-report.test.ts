import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCodexUsageReportArgs,
  renderCodexUsageReport,
} from "../extensions/codex-usage-report.ts";
import {
  appendTokenTelemetryEvent,
  closeCodexUsageStore,
} from "../extensions/codex-usage-store.ts";

test("usage report preserves the original CLI query surface", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "codex-usage-report-"));
  try {
    appendTokenTelemetryEvent(
      {
        id: "report-event",
        timestamp: "2026-08-08T12:00:00.000Z",
        eventType: "message_end",
        provider: "openai-codex",
        model: "gpt-5-codex",
        totalTokens: 321,
      },
      agentDir,
    );
    const parsed = parseCodexUsageReportArgs(
      "--days 2 --group-by provider_model --filter event_type=message_end --limit 10 --asc",
    );
    assert.equal(parsed.days, 2);
    assert.deepEqual(parsed.groupBy, ["provider_model"]);
    assert.deepEqual(parsed.filters, [
      { key: "event_type", value: "message_end" },
    ]);
    assert.equal(parsed.direction, "asc");
    const report = renderCodexUsageReport(
      agentDir,
      parsed,
      new Date("2026-08-09T00:00:00.000Z"),
    );
    assert.match(report, /openai-codex\/gpt-5-codex/);
    assert.match(report, /321/);
    const json = renderCodexUsageReport(
      agentDir,
      parseCodexUsageReportArgs("--all-time --events --json"),
    );
    assert.equal(JSON.parse(json)[0].provider, "openai-codex");
    assert.match(
      renderCodexUsageReport(
        agentDir,
        parseCodexUsageReportArgs("--list-dimensions"),
      ),
      /provider_model/,
    );
    assert.throws(
      () => parseCodexUsageReportArgs("--filter broken"),
      /Invalid filter/,
    );
  } finally {
    closeCodexUsageStore(agentDir);
    await rm(agentDir, { recursive: true, force: true });
  }
});
