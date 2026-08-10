import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { registerCodexTelemetry } from "./codex-usage-telemetry.js";
import { resolveAgentDir } from "./codex-usage-store.js";
import { recordCodexQuotaSnapshot } from "./codex-quota-history.js";
import {
  parseCodexUsageReportArgs,
  renderCodexUsageHelp,
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

export type CodexUsageExtensionOptions = {
  fetch?: FetchLike;
  agentDir?: string;
  now?: () => Date;
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
  if (name === "five_hour") return "5h limit";
  if (name === "weekly") return "Weekly limit";
  return `${name.replaceAll("_", " ")} limit`;
}

function percentLeft(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function renderLimitProgress(value: unknown): string {
  const remaining = percentLeft(value);
  if (remaining === undefined) return `[${"░".repeat(20)}] unknown`;
  const filled = Math.round(remaining / 5);
  const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
  const rounded = Math.round(remaining * 10) / 10;
  const label = Number.isInteger(rounded)
    ? rounded.toFixed(0)
    : rounded.toFixed(1);
  return `[${bar}] ${label}% left`;
}

function resetTime(value: string | undefined): string {
  if (!value) return "Resets unknown";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Resets unknown";
  return `Resets ${new Date(timestamp).toLocaleString()}`;
}

export function renderCodexUsage(status: CodexUsageStatus): string {
  const lines = ["ChatGPT Codex"];
  const account = status.accountName || status.accountId;
  if (account) {
    lines.push(`Account: ${account}${status.plan ? ` (${status.plan})` : ""}`);
  } else if (status.plan) {
    lines.push(`Plan: ${status.plan}`);
  }
  lines.push("");
  if (!status.windows.length) {
    lines.push("Quota windows unavailable");
  } else {
    status.windows.forEach((window, index) => {
      if (index) lines.push("");
      lines.push(
        windowLabel(window.name),
        renderLimitProgress(window.percentLeft),
        resetTime(window.resetAt),
      );
    });
  }
  if (status.credits) {
    lines.push("", `Credits: ${status.credits}`);
  }
  return lines.join("\n");
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
      description: "Show ChatGPT Codex usage and quota",
      chat: true,
      handler: async (args, ctx) => {
        try {
          if (["-h", "--help"].includes(args.trim())) {
            ctx.ui.notify(renderCodexUsageHelp(), "info");
            return;
          }
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
          ctx.ui.notify(renderCodexUsage(status), "info");
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
