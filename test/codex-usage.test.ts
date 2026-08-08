import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createCodexUsageExtension,
  credentialFromAccessToken,
  loadCodexUsage,
  loadCodexUsageFromAccessToken,
  parseCodexUsageResponse,
  renderCodexUsage,
} from "../extensions/codex-usage.ts";
import {
  renderCodexUsageCardPng,
  writeCodexUsageCard,
} from "../extensions/codex-usage-card.ts";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const accessToken = jwt({
  "https://api.openai.com/auth": {
    chatgpt_account_id: "acct-owner",
    chatgpt_plan_type: "pro",
  },
  "https://api.openai.com/profile": { email: "owner@example.com" },
});

test("extracts the Codex account from Pi's resolved OAuth access token", () => {
  assert.deepEqual(credentialFromAccessToken(accessToken), {
    accessToken,
    accountId: "acct-owner",
    accountName: "owner@example.com",
    plan: "pro",
  });
  assert.throws(
    () => credentialFromAccessToken("not-a-jwt"),
    /OAuth account id missing/,
  );
});

test("parses the current Codex quota response without other providers", () => {
  const credential = credentialFromAccessToken(accessToken);
  assert.deepEqual(
    parseCodexUsageResponse(
      {
        email: "fresh@example.com",
        account_id: "acct-fresh",
        plan_type: "team",
        rate_limit: {
          primary_window: {
            used_percent: 12.5,
            reset_at: 1_800_000_000,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            remaining_percent: 63,
            reset_time_ms: 1_900_000_000_000,
            limit_window_seconds: 604_800,
          },
        },
        credits: { balance: 17 },
      },
      credential,
    ),
    {
      accountId: "acct-fresh",
      accountName: "fresh@example.com",
      plan: "team",
      windows: [
        {
          name: "five_hour",
          percentLeft: 87.5,
          resetAt: "2027-01-15T08:00:00.000Z",
          windowSeconds: 18_000,
        },
        {
          name: "weekly",
          percentLeft: 63,
          resetAt: "2030-03-17T17:46:40.000Z",
          windowSeconds: 604_800,
        },
      ],
      credits: "17",
    },
  );
});

test("loads Codex quota directly for standalone extension consumers", async () => {
  const status = await loadCodexUsageFromAccessToken(accessToken, (async (
    _url,
    init,
  ) => {
    assert.equal(
      new Headers(init?.headers).get("ChatGPT-Account-Id"),
      "acct-owner",
    );
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${accessToken}`,
    );
    return new Response(
      JSON.stringify({
        rate_limit: { weekly: { percent_left: 64, reset_at: 1_900_000_000 } },
      }),
      { status: 200 },
    );
  }) as typeof fetch);
  assert.equal(status.accountId, "acct-owner");
  assert.equal(status.windows[0]?.name, "weekly");
  assert.equal(status.windows[0]?.percentLeft, 64);
});

test("loads Codex quota through the extension model registry auth facade", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchMock = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({
        rate_limit: {
          five_hour: { percent_left: 91, reset_at: 1_800_000_000 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const context = {
    modelRegistry: {
      getProviderAuth: async (provider: string) => {
        assert.equal(provider, "openai-codex");
        return { auth: { apiKey: accessToken }, source: "OAuth" };
      },
    },
  } as unknown as Pick<ExtensionCommandContext, "modelRegistry">;

  const status = await loadCodexUsage(context, fetchMock);
  assert.equal(status.accountId, "acct-owner");
  assert.equal(status.windows[0]?.percentLeft, 91);
  assert.equal(
    new Headers(request?.init?.headers).get("ChatGPT-Account-Id"),
    "acct-owner",
  );
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    `Bearer ${accessToken}`,
  );
});

test("renders a compact text fallback without token history", () => {
  const output = renderCodexUsage({
    accountId: "acct-owner",
    accountName: "owner@example.com",
    plan: "pro",
    windows: [{ name: "five_hour", percentLeft: 75 }],
    credits: "9",
  });
  assert.match(output, /^ChatGPT Codex usage/m);
  assert.match(output, /5-hour: 75% left, reset unknown/);
  assert.doesNotMatch(output, /[█░]/);
  assert.doesNotMatch(output, /Anthropic|Gemini|Copilot/);
});

test("renders a standalone Codex-only PNG card", async () => {
  const status = {
    accountId: "acct-owner",
    accountName: "owner@example.com",
    plan: "pro",
    windows: [
      { name: "five_hour", percentLeft: 75 },
      { name: "weekly", percentLeft: 42 },
    ],
    credits: "9",
  };
  const png = renderCodexUsageCardPng(status);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1000);
  assert.ok(png.readUInt32BE(20) >= 400);

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "codex-usage-card-"));
  try {
    const filePath = await writeCodexUsageCard(status, {
      outputDir,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.equal(path.dirname(filePath), outputDir);
    assert.deepEqual(
      [...(await readFile(filePath)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("registers chat-capable /usage with rich image output and a native Pi text fallback", async () => {
  let command: any;
  const pi = {
    registerCommand(name: string, options: unknown) {
      assert.equal(name, "usage");
      command = options;
    },
  } as unknown as ExtensionAPI;
  const notices: Array<[string, string]> = [];
  const richResults: any[] = [];
  const outputDir = await mkdtemp(
    path.join(os.tmpdir(), "codex-usage-command-"),
  );
  createCodexUsageExtension({
    outputDir,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    fetch: (async () =>
      new Response(
        JSON.stringify({ rate_limit: { weekly: { percent_left: 52 } } }),
        { status: 200 },
      )) as typeof fetch,
  })(pi);
  assert.equal(command.chat, true);
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: accessToken } }),
    },
    ui: {
      notify(message: string, level: string) {
        notices.push([message, level]);
      },
      rinCommandResult(result: unknown) {
        richResults.push(result);
      },
    },
  } as unknown as ExtensionCommandContext;
  try {
    await command.handler("", ctx);
    assert.equal(notices.length, 0);
    assert.match(richResults[0]?.fallbackText || "", /weekly: 52% left/);
    assert.equal(richResults[0]?.parts?.[0]?.type, "image");
    assert.deepEqual(
      [...(await readFile(richResults[0].parts[0].path)).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );

    richResults.length = 0;
    delete (ctx.ui as any).rinCommandResult;
    await command.handler("", ctx);
    assert.match(notices[0]?.[0] || "", /weekly: 52% left/);
    assert.equal(notices[0]?.[1], "info");

    notices.length = 0;
    ctx.modelRegistry.getProviderAuth = async () => undefined;
    await command.handler("", ctx);
    assert.match(notices[0]?.[0] || "", /sign in to openai-codex first/);
    assert.equal(notices[0]?.[1], "error");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
