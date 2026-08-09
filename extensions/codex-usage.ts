import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  writeCodexUsageCard,
  type CodexUsageCardOptions,
} from "./codex-usage-card.js";
import { registerCodexTelemetry } from "./codex-usage-telemetry.js";
import { resolveAgentDir } from "./codex-usage-store.js";
import type { UsageTrendSeries } from "./codex-usage-trend.js";
import {
  queryQuotaConsumptionSeries,
  recordCodexQuotaSnapshot,
  type QuotaConsumptionSeries,
} from "./codex-quota-history.js";
import {
  parseCodexUsageReportArgs,
  renderCodexUsageReport,
} from "./codex-usage-report.js";
import {
  loadCodexUsageFromAccessToken,
  type CodexUsageStatus,
  type CodexUsageWindow,
  type FetchLike,
} from "./codex-usage-client.js";

export {
  credentialFromAccessToken,
  decodeJwtPayload,
  loadCodexUsageFromAccessToken,
  parseCodexUsageResponse,
} from "./codex-usage-client.js";
export type {
  CodexUsageStatus,
  CodexUsageWindow,
} from "./codex-usage-client.js";

const CODEX_PROVIDER = "openai-codex";

export type CodexUsageExtensionOptions = CodexUsageCardOptions & {
  fetch?: FetchLike;
  agentDir?: string;
};

type RinExtensionCommandResultUi = ExtensionCommandContext["ui"] & {
  rinCommandResult?: (result: {
    text?: string;
    fallbackText?: string;
    parts?: Array<Record<string, unknown>>;
  }) => void;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function loadCodexUsage(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
  fetchImpl: FetchLike = fetch,
): Promise<CodexUsageStatus> {
  const resolved = await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER);
  const accessToken = text(resolved?.auth.apiKey);
  if (!accessToken) {
    throw new Error("Codex usage unavailable: sign in to openai-codex first");
  }
  return loadCodexUsageFromAccessToken(accessToken, fetchImpl);
}

function windowLabel(name: string): string {
  if (name === "five_hour") return "5-hour";
  if (name === "weekly") return "weekly";
  return name.replaceAll("_", "-");
}

function percent(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "unknown";
  const rounded = Math.round(numeric * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}% left`;
}

function resetTime(value: string | undefined): string {
  if (!value) return "reset unknown";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "reset unknown";
  return `resets ${new Date(timestamp).toLocaleString()}`;
}

export function renderCodexUsage(status: CodexUsageStatus): string {
  const lines = ["ChatGPT Codex usage"];
  if (status.accountName || status.accountId) {
    lines.push(`Account: ${status.accountName || status.accountId}`);
  }
  if (status.plan) lines.push(`Plan: ${status.plan}`);
  if (!status.windows.length) {
    lines.push("Quota windows unavailable");
  } else {
    for (const window of status.windows) {
      lines.push(
        `${windowLabel(window.name)}: ${percent(window.percentLeft)}, ${resetTime(window.resetAt)}`,
      );
    }
  }
  if (status.credits) lines.push(`Credits: ${status.credits}`);
  return lines.join("\n");
}

function readActualQuotaTrends(agentDir: string, now: Date) {
  const until = now.toISOString();
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const read = (windowName: string) =>
    queryQuotaConsumptionSeries(agentDir, { windowName, from, until });
  return { fiveHour: read("five_hour"), weekly: read("weekly") };
}

function quotaTrendForCard(series: QuotaConsumptionSeries): UsageTrendSeries {
  const points = series.points.map((point) => ({
    timestamp: point.observedAt,
    label: point.observedAt.slice(5, 16).replace("T", " "),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: point.consumedPercent,
    rows: 1,
    token_events: 0,
    cost_total: 0,
    context_tokens: 0,
  }));
  return {
    generatedAt: series.until,
    start: series.from,
    end: series.until,
    days: 7,
    bucketHours: 0,
    points,
    total_tokens: series.consumedPercent,
    peak_total_tokens: series.peakConsumedPercent,
  };
}

function renderActualQuotaHistory(
  fiveHour: QuotaConsumptionSeries,
  weekly: QuotaConsumptionSeries,
): string {
  return [
    "Observed actual Codex quota consumption (7d)",
    `5-hour window: ${fiveHour.consumedPercent.toFixed(2)}%`,
    `weekly window: ${weekly.consumedPercent.toFixed(2)}%`,
    "Derived from official quota percent-left snapshots; resets are not counted as usage.",
  ].join("\n");
}

export function createCodexUsageExtension(
  options: CodexUsageExtensionOptions = {},
): ExtensionFactory {
  return function codexUsage(pi: ExtensionAPI): void {
    const agentDir = resolveAgentDir(options.agentDir);
    const captureQuota = async (ctx: any) => {
      const status = await loadCodexUsage(ctx, options.fetch);
      recordCodexQuotaSnapshot(status, agentDir);
    };
    registerCodexTelemetry(pi, {
      agentDir,
      captureQuota,
    });
    pi.registerCommand("usage", {
      description: "Show ChatGPT Codex quota status",
      chat: true,
      handler: async (args, ctx) => {
        try {
          if (args.trim()) {
            const report = renderCodexUsageReport(
              agentDir,
              parseCodexUsageReportArgs(args),
              options.now?.() || new Date(),
            );
            ctx.ui.notify(report, "info");
            return;
          }
          const status = await loadCodexUsage(ctx, options.fetch);
          const now = options.now?.() || new Date();
          recordCodexQuotaSnapshot(status, agentDir, now.toISOString());
          const quota = readActualQuotaTrends(agentDir, now);
          const trend = options.trend || quotaTrendForCard(quota.weekly);
          const fallbackText = [
            renderCodexUsage(status),
            renderActualQuotaHistory(quota.fiveHour, quota.weekly),
          ].join("\n\n");
          const richUi = ctx.ui as RinExtensionCommandResultUi;
          if (richUi.rinCommandResult) {
            const imagePath = await writeCodexUsageCard(status, {
              ...options,
              now: () => now,
              trend,
              trendTitle: "7D ACTUAL QUOTA CONSUMPTION - WEEKLY",
              trendUnit: "%",
              trendSecondary: `5H ${quota.fiveHour.consumedPercent.toFixed(2)}%`,
            });
            richUi.rinCommandResult({
              fallbackText,
              parts: [
                {
                  type: "image",
                  path: imagePath,
                  mimeType: "image/png",
                },
              ],
            });
          } else {
            ctx.ui.notify(fallbackText, "info");
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `Codex usage unavailable: ${String(error)}`;
          ctx.ui.notify(message, "error");
        }
      },
    } as Parameters<ExtensionAPI["registerCommand"]>[1] & { chat: true });
  };
}

export default createCodexUsageExtension();
