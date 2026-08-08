import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createCodexUsageExtension,
  credentialFromAccessToken,
  loadCodexUsage,
  parseCodexUsageResponse,
  renderCodexUsage,
} from "../extensions/codex-usage.ts";

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

test("renders a compact text report with no chart", () => {
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

test("registers chat-capable /usage and reports success or failure through ui.notify", async () => {
  let command: any;
  const pi = {
    registerCommand(name: string, options: unknown) {
      assert.equal(name, "usage");
      command = options;
    },
  } as unknown as ExtensionAPI;
  const notices: Array<[string, string]> = [];
  createCodexUsageExtension({
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
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("", ctx);
  assert.match(notices[0]?.[0] || "", /weekly: 52% left/);
  assert.equal(notices[0]?.[1], "info");

  notices.length = 0;
  ctx.modelRegistry.getProviderAuth = async () => undefined;
  await command.handler("", ctx);
  assert.match(notices[0]?.[0] || "", /sign in to openai-codex first/);
  assert.equal(notices[0]?.[1], "error");
});
