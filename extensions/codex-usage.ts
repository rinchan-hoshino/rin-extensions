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
import {
  buildUsageTrendSeries,
  renderUsageTrendTextChart,
} from "./codex-usage-trend.js";
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

export function createCodexUsageExtension(
  options: CodexUsageExtensionOptions = {},
): ExtensionFactory {
  return function codexUsage(pi: ExtensionAPI): void {
    registerCodexTelemetry(pi, { agentDir: options.agentDir });
    pi.registerCommand("usage", {
      description: "Show ChatGPT Codex quota status",
      chat: true,
      handler: async (args, ctx) => {
        try {
          const agentDir = resolveAgentDir(options.agentDir);
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
          const trend =
            options.trend || buildUsageTrendSeries(agentDir, { now });
          const fallbackText = [
            renderCodexUsage(status),
            renderUsageTrendTextChart(trend),
          ].join("\n\n");
          const richUi = ctx.ui as RinExtensionCommandResultUi;
          if (richUi.rinCommandResult) {
            const imagePath = await writeCodexUsageCard(status, {
              ...options,
              now: () => now,
              trend,
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
