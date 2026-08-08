import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

function defaultAgentDir(): string {
  return path.resolve(
    process.env.RIN_DIR ||
      process.env.PI_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".rin"),
  );
}

interface StoredReminderConfig {
  chatKey?: unknown;
  stateDir?: unknown;
}

interface MessageEntry {
  type: "message";
  id?: unknown;
  message: Record<string, unknown>;
}

export interface SelfImproveReport {
  entryId: string;
  text: string;
  trigger: string;
}

export interface RedactedText {
  text: string;
  redactions: number;
}

interface PromptContextLike {
  source?: unknown;
  taskContextKind?: unknown;
  taskId?: unknown;
}

interface SessionManagerLike {
  __rinLastPromptSource?: unknown;
  __rinLastPromptContext?: unknown;
  getBranch?: () => unknown;
  getSessionFile?: () => unknown;
}

interface AuthoritativeEventLike {
  source?: unknown;
  promptContext?: unknown;
}

interface AuthoritativeContextLike {
  source?: unknown;
  promptContext?: unknown;
  sessionManager?: unknown;
}

type RinAgentSettledEvent = AgentSettledEvent & AuthoritativeEventLike;
type RinExtensionContext = ExtensionContext & AuthoritativeContextLike;

interface ClaimFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenClaimFile = (
  filePath: string,
  flags: "wx",
  mode: number,
) => Promise<ClaimFileHandle>;

export interface DeliveryPayload {
  chatKey: string;
  text: string;
}

export interface DeliveryResult {
  delivered?: boolean;
  pending?: boolean;
  messageIds?: unknown[];
  outboxId?: unknown;
}

type DeliveryRecord = Record<string, unknown>;
type SendFunction = (payload: DeliveryPayload) => Promise<DeliveryResult>;
type AppendRecordFunction = (
  ledgerPath: string,
  record: DeliveryRecord,
) => Promise<void>;

export interface SelfImproveReminderOptions {
  agentDir?: string;
  configPath?: string;
  chatKey?: string;
  stateDir?: string;
  send?: SendFunction;
  appendRecord?: AppendRecordFunction;
}

interface ErrorLike extends Error {
  code?: string;
  preAcceptance?: boolean;
}

interface RinSdkModule {
  createRinAgentSdk(options: { timeoutMs: number }): {
    chat: {
      send(payload: DeliveryPayload): Promise<DeliveryResult>;
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

export function resolveSelfImproveReminderConfig(
  options: SelfImproveReminderOptions = {},
): { agentDir: string; chatKey?: string; stateDir: string } {
  const agentDir = path.resolve(options.agentDir || defaultAgentDir());
  const configPath = path.resolve(
    options.configPath ||
      process.env.RIN_SELF_IMPROVE_REMINDER_CONFIG ||
      path.join(
        agentDir,
        "data",
        "extensions",
        "self-improve-reminder",
        "config.json",
      ),
  );
  let stored: StoredReminderConfig = {};
  try {
    stored = asRecord(JSON.parse(readFileSync(configPath, "utf8"))) || {};
  } catch {
    stored = {};
  }
  const chatKey =
    optionalText(options.chatKey) ||
    optionalText(process.env.RIN_SELF_IMPROVE_REMINDER_CHAT_KEY) ||
    optionalText(stored.chatKey);
  const stateDir = path.resolve(
    optionalText(options.stateDir) ||
      optionalText(stored.stateDir) ||
      path.join(agentDir, "self_improve", "state", "self-improve-reminder"),
  );
  return { agentDir, chatKey, stateDir };
}

function toErrorLike(value: unknown): ErrorLike {
  if (value instanceof Error) return value as ErrorLike;
  return new Error(String(value)) as ErrorLike;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function safeErrorMessage(value: unknown): string {
  return redactSensitiveText(errorMessage(value)).text;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n")
    .trim();
}

function messageEntry(entry: unknown): MessageEntry | null {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  return record?.type === "message" && message
    ? { type: "message", id: record.id, message }
    : null;
}

export function isSelfImproveDistillationPrompt(text: unknown): boolean {
  const normalized = String(text ?? "").trim();
  return (
    normalized.startsWith("Follow ") &&
    normalized.includes(
      "self-improve-distillation.md as the complete contract for one self-improve distillation pass over ",
    ) &&
    normalized.includes("Evidence scope:")
  );
}

export function extractSelfImproveTrigger(text: unknown): string {
  const match = String(text ?? "").match(
    /Trigger context \([^)]*\):\s*("(?:\\.|[^"\\])*")\./,
  );
  if (!match) return "";
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === "string" ? parsed.trim() : "";
  } catch {
    return "";
  }
}

export function describeSelfImproveTrigger(
  trigger: unknown,
  promptContext?: PromptContextLike,
): string {
  if (
    String(promptContext?.taskId ?? "").trim() ===
    "builtin_self_improve_sleep_consolidation_daily"
  ) {
    return "每日 24 小时整合";
  }

  const normalized = String(trigger ?? "").trim();
  if (normalized === "self_improve:session_shutdown_review") {
    return "会话结束复盘";
  }
  if (normalized === "self_improve:periodic_review") {
    return "达到周期复盘间隔";
  }
  if (normalized === "cron:builtin_self_improve_sleep_consolidation_daily") {
    return "每日 24 小时整合";
  }
  if (normalized.startsWith("cron:")) return "计划任务完成后的复盘";
  if (normalized) return "内置 self-improve 任务";
  return "触发信息未提供";
}

export function formatSelfImproveDeliveryText(
  reportText: unknown,
  triggerReason: unknown,
): string {
  return [
    "🧬 自进化提炼结果",
    `触发原因：${String(triggerReason || "触发信息未提供").trim()}`,
    String(reportText ?? "").trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readPromptContext(
  event: AuthoritativeEventLike | unknown,
  ctx: AuthoritativeContextLike | unknown,
): PromptContextLike | undefined {
  const eventRecord = asRecord(event) as AuthoritativeEventLike | undefined;
  const contextRecord = asRecord(ctx) as AuthoritativeContextLike | undefined;
  const sessionManager = asRecord(contextRecord?.sessionManager) as
    SessionManagerLike | undefined;
  return asRecord(
    eventRecord?.promptContext ??
      contextRecord?.promptContext ??
      sessionManager?.__rinLastPromptContext,
  ) as PromptContextLike | undefined;
}

export function isAuthoritativeSelfImproveRun(
  event: AuthoritativeEventLike | unknown,
  ctx: AuthoritativeContextLike | unknown,
): boolean {
  const eventRecord = asRecord(event) as AuthoritativeEventLike | undefined;
  const contextRecord = asRecord(ctx) as AuthoritativeContextLike | undefined;
  const sessionManager = asRecord(contextRecord?.sessionManager) as
    SessionManagerLike | undefined;
  const source = String(
    eventRecord?.source ??
      contextRecord?.source ??
      sessionManager?.__rinLastPromptSource ??
      "",
  ).trim();
  if (source === "builtin:self-improve") return true;

  const promptContext = readPromptContext(event, ctx);
  return (
    (source === "scheduled-task" || source === "chat-bridge") &&
    (promptContext?.taskContextKind === "scheduled-task" ||
      promptContext?.source === "scheduled-task") &&
    promptContext?.taskId === "builtin_self_improve_sleep_consolidation_daily"
  );
}

export function extractSelfImproveReport(
  branch: unknown,
): SelfImproveReport | null {
  const entries = Array.isArray(branch) ? branch : [];
  let assistantIndex = -1;
  let assistantEntry: { entry: MessageEntry; text: string } | undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = messageEntry(entries[index]);
    if (entry?.message.role !== "assistant") continue;
    const text = textFromContent(entry.message.content);
    if (!text) continue;
    assistantIndex = index;
    assistantEntry = { entry, text };
    break;
  }
  if (!assistantEntry) return null;

  let latestUserText = "";
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const entry = messageEntry(entries[index]);
    if (entry?.message.role !== "user") continue;
    latestUserText = textFromContent(entry.message.content);
    break;
  }
  if (!isSelfImproveDistillationPrompt(latestUserText)) return null;

  const fallbackId = createHash("sha256")
    .update(assistantEntry.text)
    .digest("hex")
    .slice(0, 24);
  return {
    entryId: String(assistantEntry.entry.id ?? fallbackId),
    text: assistantEntry.text,
    trigger: extractSelfImproveTrigger(latestUserText),
  };
}

export function redactSensitiveText(value: unknown): RedactedText {
  let text = String(value ?? "");
  let redactions = 0;
  const replace = (pattern: RegExp, replacement = "[REDACTED]"): void => {
    text = text.replace(pattern, () => {
      redactions += 1;
      return replacement;
    });
  };

  replace(
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  );
  replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g);
  replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g);
  replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g);
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
  replace(
    /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|authorization)\b\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi,
    "[REDACTED_CREDENTIAL]",
  );

  return { text, redactions };
}

function deliveryKey(sessionFile: unknown, report: SelfImproveReport): string {
  return createHash("sha256")
    .update(`${String(sessionFile ?? "")}\n${report.entryId}\n${report.text}`)
    .digest("hex");
}

export async function claimDelivery(
  markersDir: string,
  key: string,
  openFile: OpenClaimFile = open as OpenClaimFile,
): Promise<string | false> {
  await mkdir(markersDir, { recursive: true });
  const claimPath = path.join(markersDir, `${key}.claimed`);
  let handle: ClaimFileHandle | undefined;
  try {
    handle = await openFile(claimPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ key, claimedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    return claimPath;
  } catch (error: unknown) {
    const errorRecord = asRecord(error);
    if (errorRecord?.code === "EEXIST" && !handle) return false;
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
      await rm(claimPath, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function appendLedger(
  ledgerPath: string,
  record: DeliveryRecord,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function sendThroughRinSdk(
  agentDir: string,
  payload: DeliveryPayload,
): Promise<DeliveryResult> {
  const sdkPath = path.join(
    agentDir,
    "app",
    "current",
    "dist",
    "core",
    "rin-agent-sdk",
    "index.js",
  );
  let sdkModule: RinSdkModule;
  try {
    sdkModule = (await import(pathToFileURL(sdkPath).href)) as RinSdkModule;
  } catch (error: unknown) {
    const normalizedError = toErrorLike(error);
    normalizedError.preAcceptance = true;
    throw normalizedError;
  }
  const rin = sdkModule.createRinAgentSdk({ timeoutMs: 60_000 });
  return await rin.chat.send(payload);
}

function hasAcceptanceEvidence(result: DeliveryResult | undefined): boolean {
  return Boolean(
    result?.pending === true ||
    (Array.isArray(result?.messageIds) && result.messageIds.length > 0) ||
    String(result?.outboxId ?? "").trim(),
  );
}

function isDefinitePreAcceptanceFailure(error: unknown): boolean {
  const errorRecord = asRecord(error);
  if (errorRecord?.preAcceptance === true) return true;
  return new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]).has(
    String(errorRecord?.code ?? ""),
  );
}

function callSessionMethod(
  sessionManager: SessionManagerLike | undefined,
  method: "getBranch" | "getSessionFile",
): unknown {
  const callback = sessionManager?.[method];
  return typeof callback === "function"
    ? callback.call(sessionManager)
    : undefined;
}

export function createSelfImproveReminder(
  options: SelfImproveReminderOptions = {},
): ExtensionFactory {
  const { agentDir, chatKey, stateDir } =
    resolveSelfImproveReminderConfig(options);
  const ledgerPath = path.join(stateDir, "deliveries.jsonl");
  const markersDir = path.join(stateDir, "claims");
  const send =
    options.send ??
    ((payload: DeliveryPayload) => sendThroughRinSdk(agentDir, payload));
  const appendRecord = options.appendRecord ?? appendLedger;

  return function selfImproveReminder(pi: ExtensionAPI): void {
    if (!chatKey) return;
    let pendingReport:
      | {
          report: SelfImproveReport;
          sessionFile: unknown;
          triggerReason: string;
        }
      | undefined;

    pi.on("agent_end", (event, ctx) => {
      pendingReport = undefined;
      try {
        const rinEvent = event as unknown as RinAgentSettledEvent;
        const rinContext = ctx as RinExtensionContext;
        if (!isAuthoritativeSelfImproveRun(rinEvent, rinContext)) return;

        const sessionManager = asRecord(rinContext.sessionManager) as
          SessionManagerLike | undefined;
        const report = extractSelfImproveReport(
          callSessionMethod(sessionManager, "getBranch"),
        );
        if (!report) return;

        pendingReport = {
          report,
          sessionFile:
            callSessionMethod(sessionManager, "getSessionFile") ?? "",
          triggerReason: describeSelfImproveTrigger(
            report.trigger,
            readPromptContext(rinEvent, rinContext),
          ),
        };
      } catch (error: unknown) {
        console.error(
          `[self-improve-reminder] snapshot failed: ${safeErrorMessage(error)}`,
        );
      }
    });

    pi.on("agent_settled", async (): Promise<void> => {
      const pending = pendingReport;
      pendingReport = undefined;
      if (!pending) return;

      try {
        const { report, sessionFile, triggerReason } = pending;
        const key = deliveryKey(sessionFile, report);
        const claimPath = await claimDelivery(markersDir, key);
        if (!claimPath) return;

        const safeReport = redactSensitiveText(report.text);
        const redactionNotice = safeReport.redactions
          ? `\n\n⚠️ 已自动遮盖 ${safeReport.redactions} 处疑似凭据。`
          : "";
        let status: "delivered" | "pending" | "failed" | "failed-retryable" =
          "failed";
        let result: DeliveryResult | undefined;
        let deliveryError: unknown;
        try {
          result = await send({
            chatKey,
            text: `${formatSelfImproveDeliveryText(safeReport.text, triggerReason)}${redactionNotice}`,
          });
          status =
            result?.delivered === true
              ? "delivered"
              : hasAcceptanceEvidence(result)
                ? "pending"
                : "failed";
          if (status === "failed") {
            throw new Error("self_improve_chat_delivery_unconfirmed");
          }
        } catch (error: unknown) {
          deliveryError = error;
          if (isDefinitePreAcceptanceFailure(error)) {
            status = "failed-retryable";
            await rm(claimPath, { force: true });
          }
        }

        await appendRecord(ledgerPath, {
          key,
          status,
          chatKey,
          at: new Date().toISOString(),
          redactions: safeReport.redactions,
          messageIds: Array.isArray(result?.messageIds)
            ? result.messageIds.map(String)
            : undefined,
          outboxId: result?.outboxId ? String(result.outboxId) : undefined,
          error: deliveryError
            ? safeErrorMessage(deliveryError).slice(0, 500)
            : undefined,
        }).catch((error: unknown) => {
          console.error(
            `[self-improve-reminder] ledger write failed: ${safeErrorMessage(error)}`,
          );
        });

        if (deliveryError) {
          console.error(
            `[self-improve-reminder] ${safeErrorMessage(deliveryError)}`,
          );
        }
      } catch (error: unknown) {
        console.error(
          `[self-improve-reminder] handler failed: ${safeErrorMessage(error)}`,
        );
      }
    });
  };
}

export default createSelfImproveReminder();
