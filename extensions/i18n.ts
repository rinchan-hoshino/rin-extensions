import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type RinMessageKey =
  | "command.abort.completed"
  | "session.new.completed"
  | "session.new.cancelled"
  | "session.compaction.completed"
  | "extensions.reload.completed"
  | "session.compaction.busy"
  | "session.compaction.started"
  | "session.compaction.summary";

type I18nCatalog = {
  messages: Partial<Record<RinMessageKey, string>>;
  workingFrames: string[];
};

type RinPresentationContext = ExtensionContext & {
  rin?: { agentDir?: string };
  ui: ExtensionContext["ui"] & {
    setMessageCatalog?: (
      catalog: Partial<Record<RinMessageKey, string>>,
    ) => void;
  };
};

const MESSAGE_PATHS: Record<RinMessageKey, string[]> = {
  "command.abort.completed": ["chat", "commandResponses", "abort"],
  "session.new.completed": ["chat", "commandResponses", "new"],
  "session.new.cancelled": ["chat", "commandResponses", "newCancelled"],
  "session.compaction.completed": ["chat", "commandResponses", "compact"],
  "extensions.reload.completed": ["chat", "commandResponses", "reload"],
  "session.compaction.busy": ["chat", "compaction", "busy"],
  "session.compaction.started": ["chat", "compaction", "start"],
  "session.compaction.summary": ["chat", "compaction", "summaryLine"],
};

export const WORKING_ANIMATION_INTERVAL_MS = 30_000;

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

export function readI18nCatalog(agentDir = ""): I18nCatalog {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(resolveI18nPath(agentDir), "utf8"));
  } catch {}
  const messages = Object.fromEntries(
    Object.entries(MESSAGE_PATHS)
      .map(([key, keys]) => [key, text(valueAtPath(raw, keys))])
      .filter(([, value]) => value),
  ) as Partial<Record<RinMessageKey, string>>;
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
  return { messages, workingFrames };
}

function publishWorkingFrame(
  ctx: ExtensionContext,
  catalog: I18nCatalog,
  frameIndex: number,
): void {
  ctx.ui.setWorkingMessage(catalog.workingFrames[frameIndex]);
}

export default function i18nExtension(pi: ExtensionAPI): void {
  let catalog: I18nCatalog = { messages: {}, workingFrames: [] };
  let activeContext: ExtensionContext | null = null;
  let frameIndex = 0;
  let animationTimer: ReturnType<typeof setInterval> | null = null;

  const stopAnimation = () => {
    if (!animationTimer) return;
    clearInterval(animationTimer);
    animationTimer = null;
  };
  const publishCurrentFrame = (ctx: ExtensionContext) => {
    activeContext = ctx;
    publishWorkingFrame(ctx, catalog, frameIndex);
  };
  const publishPresentation = (ctx: ExtensionContext) => {
    const typed = ctx as RinPresentationContext;
    typed.ui.setMessageCatalog?.(catalog.messages);
    publishCurrentFrame(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    stopAnimation();
    frameIndex = 0;
    const typed = ctx as RinPresentationContext;
    catalog = readI18nCatalog(text(typed.rin?.agentDir));
    publishPresentation(ctx);
  });
  pi.on("resources_discover", (_event, ctx) => publishPresentation(ctx));
  pi.on("input", (_event, ctx) => publishPresentation(ctx));

  pi.on("agent_start", (_event, ctx) => {
    stopAnimation();
    frameIndex = 0;
    publishCurrentFrame(ctx);
    if (catalog.workingFrames.length <= 1) return;
    animationTimer = setInterval(() => {
      if (!activeContext) return;
      frameIndex = (frameIndex + 1) % catalog.workingFrames.length;
      publishWorkingFrame(activeContext, catalog, frameIndex);
    }, WORKING_ANIMATION_INTERVAL_MS);
  });

  pi.on("agent_settled", () => stopAnimation());
  pi.on("session_shutdown", () => {
    stopAnimation();
    activeContext = null;
  });
}
