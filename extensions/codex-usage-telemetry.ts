import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  flushTokenTelemetryEvents,
  queueTokenTelemetryEvent,
  resolveAgentDir,
} from "./codex-usage-store.js";

const CODEX_PROVIDER = "openai-codex";

type SessionState = {
  sequence: number;
  provider: string;
  model: string;
  turnIndex: number | null;
};

const stateBySession = new Map<string, SessionState>();
const instanceId = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionMetadata(ctx: ExtensionContext) {
  const manager = ctx.sessionManager;
  return {
    id: text(manager.getSessionId?.()),
    file: text(manager.getSessionFile?.()),
    name: text(manager.getSessionName?.()),
    persisted: Boolean(manager.getSessionFile?.()),
    cwd: text(manager.getCwd?.()) || text(ctx.cwd),
  };
}

function sessionKey(ctx: ExtensionContext): string {
  const metadata = sessionMetadata(ctx);
  return metadata.id || metadata.file || metadata.cwd || "default";
}

function stateFor(ctx: ExtensionContext): SessionState {
  const key = sessionKey(ctx);
  let state = stateBySession.get(key);
  if (!state) {
    state = {
      sequence: 0,
      provider: text(ctx.model?.provider),
      model: text(ctx.model?.id),
      turnIndex: null,
    };
    stateBySession.set(key, state);
  }
  return state;
}

function isCodex(provider: unknown): boolean {
  return text(provider) === CODEX_PROVIDER;
}

function sourceFor(ctx: ExtensionContext): string {
  const rinContext = (
    ctx as ExtensionContext & {
      rin?: { frontendIdentity?: { kind?: string } };
    }
  ).rin;
  const kind = text(rinContext?.frontendIdentity?.kind);
  return kind ? `frontend:${kind}` : "";
}

function agentDirFor(ctx: ExtensionContext, configuredAgentDir = ""): string {
  const rinContext = (
    ctx as ExtensionContext & {
      rin?: { agentDir?: string };
    }
  ).rin;
  return resolveAgentDir(configuredAgentDir || text(rinContext?.agentDir));
}

function nextId(ctx: ExtensionContext, eventType: string): string {
  const state = stateFor(ctx);
  state.sequence += 1;
  return [sessionKey(ctx), instanceId, eventType, state.sequence].join(":");
}

export function calculateActualTokenUsage(usage: any) {
  const input = finite(usage?.input ?? usage?.input_tokens);
  const output = finite(usage?.output ?? usage?.output_tokens);
  const cacheRead = finite(usage?.cacheRead ?? usage?.cache_read_input_tokens);
  const cacheWrite = finite(
    usage?.cacheWrite ?? usage?.cache_creation_input_tokens,
  );
  const explicitTotal = finite(usage?.totalTokens ?? usage?.total_tokens);
  const cost = usage?.cost || {};
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: explicitTotal || input + output + cacheRead + cacheWrite,
    costInput: finite(cost.input),
    costOutput: finite(cost.output),
    costCacheRead: finite(cost.cacheRead),
    costCacheWrite: finite(cost.cacheWrite),
    costTotal: finite(cost.total),
  };
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return [
    ...new Set(
      content
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => text(part?.name))
        .filter(Boolean),
    ),
  ];
}

function record(
  ctx: ExtensionContext,
  eventType: string,
  input: Record<string, unknown> = {},
  configuredAgentDir = "",
) {
  const state = stateFor(ctx);
  const provider = text(input.provider) || state.provider;
  if (!isCodex(provider)) return;
  const metadata = sessionMetadata(ctx);
  queueTokenTelemetryEvent(
    {
      id: text(input.id) || nextId(ctx, eventType),
      timestamp: text(input.timestamp),
      sessionId: metadata.id,
      sessionFile: metadata.file,
      sessionName: metadata.name,
      sessionPersisted: metadata.persisted,
      cwd: metadata.cwd,
      eventType,
      source: sourceFor(ctx),
      turnIndex:
        input.turnIndex === undefined
          ? state.turnIndex
          : finite(input.turnIndex),
      phase: text(input.phase),
      provider: CODEX_PROVIDER,
      model: text(input.model) || state.model,
      thinkingLevel: text(ctx.thinkingLevel),
      messageId: text(input.messageId),
      messageRole: text(input.messageRole),
      stopReason: text(input.stopReason),
      toolCallId: text(input.toolCallId),
      toolName: text(input.toolName),
      toolCallCount: finite(input.toolCallCount),
      toolNames: Array.isArray(input.toolNames)
        ? (input.toolNames as string[])
        : [],
      capabilityKind: text(input.capabilityKind),
      capabilityKey: text(input.capabilityKey),
      inputTokens: finite(input.inputTokens),
      outputTokens: finite(input.outputTokens),
      cacheReadTokens: finite(input.cacheReadTokens),
      cacheWriteTokens: finite(input.cacheWriteTokens),
      totalTokens: finite(input.totalTokens),
      costInput: finite(input.costInput),
      costOutput: finite(input.costOutput),
      costCacheRead: finite(input.costCacheRead),
      costCacheWrite: finite(input.costCacheWrite),
      costTotal: finite(input.costTotal),
      contextTokens: finite(input.contextTokens),
      isError: Boolean(input.isError),
      metadata:
        input.metadata && typeof input.metadata === "object"
          ? (input.metadata as Record<string, unknown>)
          : null,
    },
    agentDirFor(ctx, configuredAgentDir),
  );
}

function flush(ctx: ExtensionContext, configuredAgentDir = "") {
  flushTokenTelemetryEvents(agentDirFor(ctx, configuredAgentDir));
}

export function registerCodexTelemetry(
  pi: ExtensionAPI,
  options: {
    agentDir?: string;
    captureQuota?: (ctx: ExtensionContext) => Promise<void>;
    quotaDelayMs?: number;
  } = {},
) {
  const configuredAgentDir = text(options.agentDir);
  const captureQuota = (ctx: ExtensionContext, delayed = false) => {
    if (!options.captureQuota) return;
    if (!delayed) {
      void options.captureQuota(ctx).catch(() => {});
      return;
    }
    const timer = setTimeout(
      () => void options.captureQuota?.(ctx).catch(() => {}),
      Math.max(0, options.quotaDelayMs ?? 2_000),
    );
    timer.unref?.();
  };
  const recordCodex = (
    ctx: ExtensionContext,
    eventType: string,
    input: Record<string, unknown> = {},
  ) => record(ctx, eventType, input, configuredAgentDir);
  const flushCodex = (ctx: ExtensionContext) => flush(ctx, configuredAgentDir);
  pi.on("session_start", async (event, ctx) => {
    const state = stateFor(ctx);
    state.provider = text(ctx.model?.provider);
    state.model = text(ctx.model?.id);
    recordCodex(ctx, "session_start", {
      metadata: {
        reason: event.reason,
        previousSessionFile: event.previousSessionFile,
      },
    });
    captureQuota(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    const state = stateFor(ctx);
    state.provider = text(event.model?.provider);
    state.model = text(event.model?.id);
    recordCodex(ctx, "model_select", {
      provider: state.provider,
      model: state.model,
      metadata: {
        source: event.source,
        previousProvider: text(event.previousModel?.provider),
        previousModel: text(event.previousModel?.id),
      },
    });
  });

  pi.on("turn_start", async (event, ctx) => {
    const state = stateFor(ctx);
    state.turnIndex = event.turnIndex;
    recordCodex(ctx, "turn_start", {
      turnIndex: event.turnIndex,
      phase: "turn",
      metadata: { timestamp: event.timestamp },
    });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    recordCodex(ctx, "tool_execution_start", {
      id: `${sessionKey(ctx)}:tool_execution_start:${event.toolCallId}`,
      phase: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      capabilityKind: "tool_execution",
      capabilityKey: `tool:${event.toolName || "(unknown)"}`,
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    recordCodex(ctx, "tool_execution_end", {
      id: `${sessionKey(ctx)}:tool_execution_end:${event.toolCallId}`,
      phase: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      capabilityKind: "tool_execution",
      capabilityKey: `tool:${event.toolName || "(unknown)"}`,
      isError: event.isError,
    });
  });

  pi.on("message_end", async (event, ctx) => {
    const message: any = event.message;
    const provider = text(message?.provider) || stateFor(ctx).provider;
    if (!isCodex(provider)) return;
    const usage = calculateActualTokenUsage(message?.usage);
    const names = toolNames(message?.content);
    const role = text(message?.role);
    const capabilityKind =
      role === "assistant"
        ? names.length
          ? names.length === 1
            ? "assistant_tool_call"
            : "assistant_multi_tool_call"
          : "assistant_text"
        : role === "toolResult"
          ? "tool_result"
          : role === "user"
            ? "user_input"
            : "runtime";
    recordCodex(ctx, "message_end", {
      id: text(message?.id)
        ? `${sessionKey(ctx)}:message_end:${text(message.id)}`
        : "",
      phase: "message",
      provider,
      model: text(message?.model),
      messageId: text(message?.id),
      messageRole: role,
      stopReason: text(message?.stopReason),
      toolCallId: text(message?.toolCallId),
      toolName: text(message?.toolName),
      toolCallCount: names.length,
      toolNames: names,
      capabilityKind,
      capabilityKey:
        capabilityKind === "assistant_text"
          ? "assistant:text"
          : names.length
            ? `tools:${names.sort().join("+")}`
            : role,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.total,
      costInput: usage.costInput,
      costOutput: usage.costOutput,
      costCacheRead: usage.costCacheRead,
      costCacheWrite: usage.costCacheWrite,
      costTotal: usage.costTotal,
      contextTokens: usage.total,
      isError:
        text(message?.stopReason) === "error" ||
        Boolean(text(message?.errorMessage)),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    recordCodex(ctx, "agent_end", {
      phase: "agent",
      metadata: { messageCount: event.messages.length },
    });
    flushCodex(ctx);
    captureQuota(ctx, true);
  });

  pi.on("session_compact", async (event, ctx) => {
    recordCodex(ctx, "session_compact", {
      metadata: {
        fromExtension: event.fromExtension,
        compactionEntryId: text(event.compactionEntry?.id),
      },
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      recordCodex(ctx, "session_shutdown");
      flushCodex(ctx);
    } finally {
      stateBySession.delete(sessionKey(ctx));
    }
  });
}
