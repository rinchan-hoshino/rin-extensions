import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  claimDelivery,
  createSelfImproveReminder,
  resolveSelfImproveReminderConfig,
  extractSelfImproveReport,
  isAuthoritativeSelfImproveRun,
  redactSensitiveText,
} from "../extensions/self-improve-reminder.ts";
import type {
  DeliveryPayload,
  OpenClaimFile,
  SelfImproveReminderOptions,
} from "../extensions/self-improve-reminder.ts";

const TEST_SELF_IMPROVE_CHAT_KEY = "discord/test-bot:test-channel";
const CURRENT_REVIEW_PROMPT =
  "Review this conversation for information that should improve future behavior. Update the appropriate prompt or skill in /home/rin/.rin/self_improve when something durable is missing.";

function createTestReminder(
  options: SelfImproveReminderOptions = {},
): ExtensionFactory {
  return createSelfImproveReminder({
    chatKey: TEST_SELF_IMPROVE_CHAT_KEY,
    ...options,
  });
}

interface TestMessageEntry {
  type: "message";
  id: string;
  message: {
    role: string;
    content: Array<{ type: "text"; text: string }>;
  };
}

interface TestContext {
  source?: string;
  promptContext?: {
    taskContextKind?: string;
    source?: string;
    taskId?: string;
  };
  sessionManager?: {
    getBranch?: () => unknown;
    getSessionFile?: () => string;
  };
}

type SettledHandler = (
  event: AgentSettledEvent,
  ctx: ExtensionContext,
) => Promise<void> | void;

type ExtensionEventHandler = (
  event: any,
  ctx: ExtensionContext,
) => Promise<void> | void;

function textMessage(role: string, text: string): TestMessageEntry {
  return {
    type: "message",
    id: `${role}-${text.length}`,
    message: { role, content: [{ type: "text", text }] },
  };
}

function mockContext(
  branch: unknown[],
  sessionFile = "/tmp/distillation-session.jsonl",
  source = "builtin:self-improve",
): TestContext {
  return {
    source,
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
    },
  };
}

function captureHandlers(
  extension: ExtensionFactory,
): Map<string, ExtensionEventHandler> {
  const handlers = new Map<string, ExtensionEventHandler>();
  const pi = {
    on: (event: string, handler: ExtensionEventHandler): void => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  void extension(pi);
  return handlers;
}

function settledHandler(extension: ExtensionFactory): SettledHandler {
  const handlers = captureHandlers(extension);
  const agentEnd = handlers.get("agent_end");
  const agentSettled = handlers.get("agent_settled");
  assert.ok(agentEnd);
  assert.ok(agentSettled);
  return async (event, ctx) => {
    await agentEnd(event, ctx);
    await agentSettled(event, ctx);
  };
}

function asSettledEvent(value: unknown): AgentSettledEvent {
  return value as AgentSettledEvent;
}

function asExtensionContext(value: unknown): ExtensionContext {
  return value as ExtensionContext;
}

function distillationContext(
  source = "builtin:self-improve",
  prompt = CURRENT_REVIEW_PROMPT,
): TestContext {
  return mockContext(
    [textMessage("user", prompt), textMessage("assistant", "distilled result")],
    "/tmp/distillation-session.jsonl",
    source,
  );
}

test("is inert without local destination config and reads config outside the package", async () => {
  const agentDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reminder-config-"),
  );
  try {
    assert.equal(
      captureHandlers(createSelfImproveReminder({ agentDir })).size,
      0,
    );
    const configPath = path.join(
      agentDir,
      "data",
      "extensions",
      "self-improve-reminder",
      "config.json",
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ chatKey: TEST_SELF_IMPROVE_CHAT_KEY })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(resolveSelfImproveReminderConfig({ agentDir }), {
      agentDir,
      chatKey: TEST_SELF_IMPROVE_CHAT_KEY,
      stateDir: path.join(
        agentDir,
        "self_improve",
        "state",
        "self-improve-reminder",
      ),
    });
    assert.deepEqual(
      [...captureHandlers(createSelfImproveReminder({ agentDir })).keys()],
      ["agent_end", "agent_settled"],
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("requires authoritative built-in or scheduled-task provenance", () => {
  assert.equal(
    isAuthoritativeSelfImproveRun(
      {},
      mockContext([], "x", "builtin:self-improve"),
    ),
    true,
  );
  assert.equal(
    isAuthoritativeSelfImproveRun({}, mockContext([], "x", "chat")),
    false,
  );
  assert.equal(
    isAuthoritativeSelfImproveRun(
      {},
      {
        source: "scheduled-task",
        promptContext: {
          taskContextKind: "scheduled-task",
          taskId: "builtin_self_improve_sleep_consolidation_daily",
        },
      },
    ),
    true,
  );
  assert.equal(
    isAuthoritativeSelfImproveRun(
      {},
      {
        source: "chat-bridge",
        promptContext: {
          taskContextKind: "scheduled-task",
          taskId: "builtin_self_improve_sleep_consolidation_daily",
        },
      },
    ),
    true,
  );
  assert.equal(
    isAuthoritativeSelfImproveRun(
      {},
      {
        source: "scheduled-task",
        promptContext: {
          taskContextKind: "scheduled-task",
          taskId: "spoof",
        },
      },
    ),
    false,
  );
});

test("extracts the settled final independently of producer authentication", () => {
  const branch = [
    textMessage("user", "ordinary request"),
    textMessage("assistant", "ordinary result"),
    textMessage("user", CURRENT_REVIEW_PROMPT),
    textMessage("assistant", "updated two skills"),
  ];
  assert.deepEqual(extractSelfImproveReport(branch), {
    entryId: "assistant-18",
    text: "updated two skills",
  });

  assert.deepEqual(
    extractSelfImproveReport([
      textMessage("user", "ordinary request"),
      textMessage("assistant", "ordinary result"),
    ]),
    {
      entryId: "assistant-15",
      text: "ordinary result",
    },
  );
});

test("redacts likely credentials and standard private-key blocks before delivery", () => {
  const keyTypes = ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "];
  const input = [
    "token=abcdefghijklmnop and Bearer abcdefghijklmnop and sk-abcdefghijklmnop",
    ...keyTypes.map(
      (type) =>
        `-----BEGIN ${type}PRIVATE KEY-----\nsecret-${type}\n-----END ${type}PRIVATE KEY-----`,
    ),
  ].join("\n");
  const result = redactSensitiveText(input);
  assert.equal(result.redactions, 8);
  assert.doesNotMatch(result.text, /abcdefghijklmnop/);
  assert.doesNotMatch(result.text, /sk-/);
  assert.doesNotMatch(result.text, /BEGIN .*PRIVATE KEY/);
});

test("sends one report to the configured chat and persists delivery evidence", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  const sent: DeliveryPayload[] = [];
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async (payload) => {
          sent.push(payload);
          return { delivered: true, messageIds: ["1"] };
        },
      }),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatKey, TEST_SELF_IMPROVE_CHAT_KEY);
    assert.match(sent[0].text, /^🧬 自进化提炼结果\n\n/);
    assert.match(sent[0].text, /distilled result/);

    const ledger = await readFile(
      path.join(stateDir, "deliveries.jsonl"),
      "utf8",
    );
    assert.match(ledger, /"status":"delivered"/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("partial claim creation failure removes the marker for a future attempt", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  const markersDir = path.join(stateDir, "claims");
  const key = "partial-claim";
  try {
    const failingOpen: OpenClaimFile = async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      return {
        writeFile: async () => {
          throw new Error("write failed");
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };
    await assert.rejects(
      claimDelivery(markersDir, key, failingOpen),
      /write failed/,
    );
    await assert.rejects(stat(path.join(markersDir, `${key}.claimed`)), {
      code: "ENOENT",
    });
    assert.equal(typeof (await claimDelivery(markersDir, key)), "string");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("atomic claim prevents simultaneous and cross-instance duplicate sends", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  const send = async (): Promise<{ delivered: true }> => {
    sends += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { delivered: true };
  };
  try {
    const first = settledHandler(createTestReminder({ stateDir, send }));
    const second = settledHandler(createTestReminder({ stateDir, send }));
    const event = asSettledEvent({});
    const context = asExtensionContext(distillationContext());
    await Promise.all([
      first(event, context),
      first(event, context),
      second(event, context),
    ]);
    assert.equal(sends, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a post-send ledger failure cannot cause redelivery", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  const send = async (): Promise<{ delivered: true }> => {
    sends += 1;
    return { delivered: true };
  };
  try {
    const first = settledHandler(
      createTestReminder({
        stateDir,
        send,
        appendRecord: async () => {
          throw new Error("disk full");
        },
      }),
    );
    await first(asSettledEvent({}), asExtensionContext(distillationContext()));

    const afterReload = settledHandler(createTestReminder({ stateDir, send }));
    await afterReload(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    assert.equal(sends, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("unconfirmed responses retain the claim instead of risking duplicate delivery", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async () => {
          sends += 1;
          return {};
        },
      }),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    assert.equal(sends, 1);
    const ledger = await readFile(
      path.join(stateDir, "deliveries.jsonl"),
      "utf8",
    );
    assert.match(ledger, /"status":"failed"/);
    assert.doesNotMatch(ledger, /failed-retryable/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("delivery identifiers count as acceptance evidence even without status flags", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async () => {
          sends += 1;
          return {
            outboxId: "accepted-outbox-id",
            messageIds: ["accepted-message-id"],
          };
        },
      }),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    assert.equal(sends, 1);
    const ledger = await readFile(
      path.join(stateDir, "deliveries.jsonl"),
      "utf8",
    );
    assert.match(ledger, /"status":"pending"/);
    assert.match(ledger, /accepted-outbox-id/);
    assert.match(ledger, /accepted-message-id/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("definite pre-acceptance failure releases the claim and redacts its error", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async () => {
          sends += 1;
          if (sends === 1) {
            const error = new Error(
              "daemon unavailable token=abcdefghijklmnop",
            ) as Error & {
              code?: string;
            };
            error.code = "ECONNREFUSED";
            throw error;
          }
          return { delivered: true };
        },
      }),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext()),
    );
    assert.equal(sends, 2);
    const ledger = await readFile(
      path.join(stateDir, "deliveries.jsonl"),
      "utf8",
    );
    assert.match(ledger, /"status":"failed-retryable"/);
    assert.match(ledger, /"status":"delivered"/);
    assert.match(ledger, /REDACTED_CREDENTIAL/);
    assert.doesNotMatch(ledger, /abcdefghijklmnop/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("does not send a spoofed canonical prompt from an ordinary chat turn", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  let sends = 0;
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async () => {
          sends += 1;
          return { delivered: true };
        },
      }),
    );
    await callback(
      asSettledEvent({}),
      asExtensionContext(distillationContext("chat")),
    );
    assert.equal(sends, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("contains session API failures without breaking the agent lifecycle", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  try {
    const callback = settledHandler(
      createTestReminder({
        stateDir,
        send: async () => ({ delivered: true }),
      }),
    );
    await assert.doesNotReject(
      Promise.resolve(
        callback(
          asSettledEvent({}),
          asExtensionContext({
            source: "builtin:self-improve",
            sessionManager: {
              getBranch: () => {
                throw new Error("broken session");
              },
            },
          }),
        ),
      ),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("delivers from an agent_end snapshot after the settled context becomes stale", async () => {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "rin-self-improve-reporter-"),
  );
  const sent: DeliveryPayload[] = [];
  try {
    const handlers = captureHandlers(
      createTestReminder({
        stateDir,
        send: async (payload) => {
          sent.push(payload);
          return { delivered: true, messageIds: ["snapshot-delivered"] };
        },
      }),
    );
    const agentEnd = handlers.get("agent_end");
    const agentSettled = handlers.get("agent_settled");
    assert.equal(typeof agentEnd, "function");
    assert.equal(typeof agentSettled, "function");

    let stale = false;
    const branch = [
      textMessage("user", CURRENT_REVIEW_PROMPT),
      textMessage("assistant", "snapshot result"),
    ];
    const context = asExtensionContext({
      source: "builtin:self-improve",
      sessionManager: {
        getBranch: () => {
          if (stale) {
            throw new Error(
              "extension ctx is stale after session replacement or reload",
            );
          }
          return branch;
        },
        getSessionFile: () => {
          if (stale) {
            throw new Error(
              "extension ctx is stale after session replacement or reload",
            );
          }
          return "/tmp/distillation-session.jsonl";
        },
      },
    });

    await agentEnd?.({ type: "agent_end", messages: [] }, context);
    stale = true;
    await agentSettled?.(asSettledEvent({}), context);

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /snapshot result/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
