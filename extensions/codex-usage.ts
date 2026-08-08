import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  writeCodexUsageCard,
  type CodexUsageCardOptions,
} from "./codex-usage-card.js";

const CODEX_PROVIDER = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type FetchLike = typeof fetch;

type CodexCredential = {
  accessToken: string;
  accountId: string;
  accountName?: string;
  plan?: string;
};

export type CodexUsageWindow = {
  name: string;
  percentLeft?: number;
  resetAt?: string;
  windowSeconds?: number;
};

export type CodexUsageStatus = {
  accountId: string;
  accountName?: string;
  plan?: string;
  windows: CodexUsageWindow[];
  credits?: string;
};

export type CodexUsageExtensionOptions = CodexUsageCardOptions & {
  fetch?: FetchLike;
};

type RinExtensionCommandResultUi = ExtensionCommandContext["ui"] & {
  rinCommandResult?: (result: {
    text?: string;
    fallbackText?: string;
    parts?: Array<Record<string, unknown>>;
  }) => void;
};

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, any>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampPercent(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, numeric));
}

export function decodeJwtPayload(
  token: string,
): Record<string, any> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return record(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

export function credentialFromAccessToken(
  accessToken: string,
): CodexCredential {
  const payload = decodeJwtPayload(accessToken);
  const auth = record(payload?.["https://api.openai.com/auth"]);
  const profile = record(payload?.["https://api.openai.com/profile"]);
  const accountId = text(auth?.chatgpt_account_id);
  if (!accountId) {
    throw new Error("Codex usage unavailable: OAuth account id missing");
  }
  return {
    accessToken,
    accountId,
    accountName: text(profile?.email || profile?.name) || undefined,
    plan: text(auth?.chatgpt_plan_type) || undefined,
  };
}

function epochToIso(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const date = new Date(numeric > 10 ** 11 ? numeric : numeric * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeWindowName(name: string, windowSeconds: unknown): string {
  const seconds = Number(windowSeconds || 0);
  if (seconds > 0 && seconds <= 6 * 3600) return "five_hour";
  if (seconds >= 6 * 24 * 3600) return "weekly";
  return name;
}

function parseLimitWindow(
  name: string,
  value: unknown,
): CodexUsageWindow | undefined {
  const outer = record(value);
  if (!outer) return undefined;
  const window =
    !outer.reset_at && !outer.reset_time_ms && record(outer.primary_window)
      ? record(outer.primary_window)
      : outer;
  if (!window) return undefined;
  const percentLeft =
    clampPercent(window.percent_left ?? window.remaining_percent) ??
    clampPercent(
      window.used_percent === undefined
        ? undefined
        : 100 - Number(window.used_percent),
    );
  const windowSeconds =
    Number(window.limit_window_seconds || 0) > 0
      ? Number(window.limit_window_seconds)
      : undefined;
  return {
    name: normalizeWindowName(name, windowSeconds),
    percentLeft,
    resetAt: epochToIso(window.reset_at ?? window.reset_time_ms),
    windowSeconds,
  };
}

function parseRateLimitWindows(value: unknown): CodexUsageWindow[] {
  const rateLimit = record(value);
  if (!rateLimit) return [];
  const primary =
    parseLimitWindow("five_hour", rateLimit.five_hour) ||
    parseLimitWindow("five_hour", rateLimit.five_hour_limit) ||
    parseLimitWindow("five_hour", rateLimit.primary_window) ||
    parseLimitWindow("five_hour", rateLimit.primary);
  const secondary =
    parseLimitWindow("weekly", rateLimit.weekly) ||
    parseLimitWindow("weekly", rateLimit.weekly_limit) ||
    parseLimitWindow("weekly", rateLimit.secondary_window) ||
    parseLimitWindow("weekly", rateLimit.secondary);
  return [primary, secondary].filter((window): window is CodexUsageWindow =>
    Boolean(window),
  );
}

export function parseCodexUsageResponse(
  data: unknown,
  credential: CodexCredential,
): CodexUsageStatus {
  const payload = record(data) || {};
  const credits = record(payload.credits);
  return {
    accountId:
      text(payload.account_id || payload.accountId) || credential.accountId,
    accountName: text(payload.email) || credential.accountName || undefined,
    plan:
      text(payload.plan_type || payload.planType) ||
      credential.plan ||
      undefined,
    windows: parseRateLimitWindows(payload.rate_limit || payload.rate_limits),
    credits:
      credits && credits.balance !== undefined
        ? String(credits.balance).trim()
        : undefined,
  };
}

export async function loadCodexUsageFromAccessToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CodexUsageStatus> {
  const credential = credentialFromAccessToken(accessToken);
  const response = await fetchImpl(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
      "ChatGPT-Account-Id": credential.accountId,
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "User-Agent": "rin-codex-usage-extension",
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Codex usage unavailable: HTTP ${response.status}`);
  }
  const data = await response.json();
  return parseCodexUsageResponse(data, credential);
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
    pi.registerCommand("usage", {
      description: "Show ChatGPT Codex quota status",
      chat: true,
      handler: async (_args, ctx) => {
        try {
          const status = await loadCodexUsage(ctx, options.fetch);
          const fallbackText = renderCodexUsage(status);
          const richUi = ctx.ui as RinExtensionCommandResultUi;
          if (richUi.rinCommandResult) {
            const imagePath = await writeCodexUsageCard(status, options);
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
