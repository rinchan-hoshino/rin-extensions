import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ChatPresentation = {
  commandResponses?: Record<string, string>;
  workingFrames?: string[];
};

type RinPresentationContext = ExtensionContext & {
  rin?: { agentDir?: string };
  ui: ExtensionContext["ui"] & {
    rinChatPresentation?: (presentation: ChatPresentation) => void;
  };
};

const COMMAND_RESPONSE_PATHS: Record<string, string[]> = {
  abort: ["chat", "commandResponses", "abort"],
  new: ["chat", "commandResponses", "new"],
  newCancelled: ["chat", "commandResponses", "newCancelled"],
  reload: ["chat", "commandResponses", "reload"],
  compactionStart: ["chat", "compaction", "start"],
  compactionSummaryLine: ["chat", "compaction", "summaryLine"],
  compactionSummaryText: ["chat", "compaction", "summaryText"],
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function valueAtPath(source: unknown, keys: string[]): unknown {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const direct = (source as Record<string, unknown>)[keys.join(".")];
    if (direct !== undefined) return direct;
  }
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function resolveI18nPath(agentDir = ""): string {
  const root =
    text(agentDir) ||
    text(process.env.PI_CODING_AGENT_DIR) ||
    path.join(os.homedir(), ".rin");
  return path.join(root, "i18n.json");
}

export function readChatPresentation(agentDir = ""): ChatPresentation {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(resolveI18nPath(agentDir), "utf8"));
  } catch {}
  const commandResponses = Object.fromEntries(
    Object.entries(COMMAND_RESPONSE_PATHS)
      .map(([key, keys]) => [key, text(valueAtPath(raw, keys))])
      .filter(([, value]) => value),
  );
  const framesValue = valueAtPath(raw, [
    "chat",
    "runtime",
    "working",
    "frames",
  ]);
  const workingFrames = (
    Array.isArray(framesValue) ? framesValue : [framesValue]
  )
    .map(text)
    .filter(Boolean);
  return { commandResponses, workingFrames };
}

function publishPresentation(ctx: ExtensionContext): void {
  const typed = ctx as RinPresentationContext;
  typed.ui.rinChatPresentation?.(
    readChatPresentation(text(typed.rin?.agentDir)),
  );
}

export default function i18nExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => publishPresentation(ctx));
  pi.on("resources_discover", (_event, ctx) => publishPresentation(ctx));
}
