import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RIN_CHAT_PLATFORM_EVENT = "rin.chat.platform.v1";

export type ChatPlatformBot = {
  platform: string;
  selfId: string;
  status: number;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: Record<string, unknown>,
  ): Promise<string[]> | string[];
  [key: string]: unknown;
};

export type ChatInboundRecoveryHead = {
  chatKey: string;
  chatId: string;
  messageId: string;
  platformTimestamp: number;
  providerCursor?: string;
  failureCount?: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
  pausedAt?: string;
  nextAttemptAt?: string;
  recoveryVersion?: number;
};

export type ChatInboundRecoveryResult<T> = {
  recovered: T[];
  failures: string[];
  deferred: string[];
  retired: string[];
  scopeHealthy: boolean;
};

export type ChatPlatformInput = {
  agentDir: string;
  dataDir: string;
  config: Record<string, unknown>;
  logger: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  receive(session: unknown): void;
  updateStatus(bot: ChatPlatformBot, status: number): void;
  composeKey(chatId: string, botId: string): string;
  beginRecovery(chatKey: string): void;
  completeRecovery(chatKey: string): void;
  recoverInbound<T>(
    botId: string,
    recover: (head: ChatInboundRecoveryHead) => Promise<T[]>,
    options?: {
      concurrency?: number;
      onHeads?: (heads: ChatInboundRecoveryHead[]) => void | Promise<void>;
      onHeadSettled?: (outcome: {
        head: ChatInboundRecoveryHead;
        recovered: T[];
        error?: unknown;
      }) => void | Promise<void>;
    },
  ): Promise<ChatInboundRecoveryResult<T>>;
};

export type ChatPlatform = {
  readonly bot: ChatPlatformBot;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  setWorkingText?(text: string): void;
};

export type ChatPlatformContribution = {
  apiVersion: 1;
  platform: string;
  defaults?: Record<string, unknown>;
  create(input: ChatPlatformInput): ChatPlatform | Promise<ChatPlatform>;
};

export function contributeChatPlatform(
  pi: ExtensionAPI,
  contribution: ChatPlatformContribution,
) {
  pi.events.emit(RIN_CHAT_PLATFORM_EVENT, contribution);
}

export function createChatPlatformHost(input: ChatPlatformInput) {
  return {
    agentDir: input.agentDir,
    emit(event: string, value: unknown) {
      if (event === "message") input.receive(value);
      if (event === "bot-status-updated") {
        const bot = value as ChatPlatformBot;
        input.updateStatus(bot, Number(bot?.status) || 0);
      }
    },
    beginInboundRecoveryChat: input.beginRecovery,
    completeInboundRecoveryChat: input.completeRecovery,
    recoverInbound: input.recoverInbound,
    composeKey: input.composeKey,
  };
}

export type ChatPlatformHost = ReturnType<typeof createChatPlatformHost>;
