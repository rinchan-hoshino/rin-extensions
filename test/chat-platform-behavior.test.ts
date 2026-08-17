import "./require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as onebot from "../extensions/onebot-platform.ts";
import * as lark from "../extensions/lark-platform.ts";
import {
  compactObject,
  normalizeNode,
  safeString,
} from "../extensions/chat-platform-common.ts";
import { createChatPlatformHost } from "../extensions/chat-platform-protocol.ts";

function createChatNodes() {
  const h: any = (
    type: string,
    attrs?: Record<string, unknown>,
    ...children: unknown[]
  ) => normalizeNode(type, attrs, children);
  h.text = (content: unknown) =>
    normalizeNode("text", { content: safeString(content) });
  h.quote = (id: unknown) => normalizeNode("quote", { id: safeString(id) });
  h.at = (id: unknown, attrs?: Record<string, unknown>) =>
    normalizeNode(
      "at",
      compactObject({ ...(attrs || {}), id: safeString(id) }),
    );
  h.image = (src: unknown) => normalizeNode("image", { src: safeString(src) });
  h.markdown = (content: unknown) =>
    normalizeNode("markdown", { content: safeString(content) });
  h.html = (content: unknown) =>
    normalizeNode("html", { content: safeString(content) });
  h.file = (
    value: unknown,
    mimeType?: string,
    attrs?: Record<string, unknown>,
  ) =>
    Buffer.isBuffer(value)
      ? normalizeNode("file", { ...(attrs || {}), mimeType, data: value })
      : normalizeNode("file", {
          ...(attrs || {}),
          mimeType,
          src: safeString(value),
        });
  return h;
}

const runtime = Object.assign({}, onebot, lark, { createChatNodes });

function requireReactionIndicator(bot: any) {
  const indicator = bot.workingIndicators.find(
    (item: any) => item?.presentation === "reaction",
  );
  assert.ok(indicator, "expected a reaction working indicator");
  return indicator;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-platform-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createRuntimeApp(agentDir: string, entry: Record<string, any>) {
  const received: unknown[] = [];
  const host = createChatPlatformHost({
    agentDir,
    dataDir: path.join(agentDir, "data"),
    config: entry.config || {},
    logger: {},
    receive: (session) => received.push(session),
    updateStatus() {},
    composeKey: (chatId, botId) => `${entry.key}/${botId}:${chatId}`,
    beginRecovery() {},
    completeRecovery() {},
    recoverInbound: async () => ({
      processed: 0,
      incomplete: 0,
      recovered: [],
      pending: [],
      failures: [],
      deferred: [],
      retired: [],
      scopeHealthy: true,
    }),
  });
  const platform: any =
    entry.key === "onebot"
      ? new onebot.OneBotPlatform(
          host,
          path.join(agentDir, "data"),
          entry.config || {},
          {},
        )
      : new lark.LarkPlatform(
          host,
          path.join(agentDir, "data"),
          entry.config || {},
          {},
        );
  return {
    bots: [platform.bot],
    platforms: new Set([platform]),
    received,
    async stop() {
      await platform.stop();
    },
    setWorkingText(text: string) {
      platform.setWorkingText?.(text);
    },
  };
}

test("lark adapter sends progress as new messages without edit capability", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push({ method: "create", payload });
            return { data: { message_id: `m${calls.length}` } };
          },
          update: async (payload: any) => {
            calls.push({ method: "update", payload });
            return { data: { message_id: payload.path.message_id } };
          },
          delete: async (payload: any) => {
            calls.push({ method: "delete", payload });
            return { ok: true };
          },
        },
      },
    };

    assert.deepEqual(
      app.bots[0].workingIndicators.map((item: any) => item.presentation),
      ["reaction", "typing"],
    );
    const interimResult = await app.bots[0].sendMessage(
      "oc_1",
      [h.text("checking")],
      {
        deliveryKind: "interim",
        coalesceWithWorkingMessage: true,
      },
    );
    const todoResult = await app.bots[0].sendMessage(
      "oc_1",
      [h.text("⬜ first task")],
      {
        deliveryKind: "passive_notice",
        coalesceWithWorkingMessage: true,
      },
    );
    const finalResult = await app.bots[0].sendMessage("oc_1", [h.text("done")]);

    assert.deepEqual(interimResult, ["m1"]);
    assert.deepEqual(todoResult, ["m2"]);
    assert.deepEqual(finalResult, ["m3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["create", "create", "create"],
    );
    assert.match(calls[0].payload.data.content, /checking/);
    assert.match(calls[1].payload.data.content, /first task/);
    assert.match(calls[2].payload.data.content, /done/);
  });
});

test("onebot adapter renders merged-forward records as readable text", async () => {
  const rendered = runtime.renderOneBotForwardContent({
    messages: [
      {
        type: "node",
        data: {
          user_id: "1001",
          nickname: "Alice",
          content: [
            { type: "text", data: { text: "hello " } },
            { type: "image", data: { url: "https://example.com/a.png" } },
          ],
        },
      },
      {
        type: "node",
        data: {
          user_id: "1002",
          nickname: "Bob",
          content: "[CQ:at,qq=1001] received",
        },
      },
    ],
  });

  assert.equal(
    rendered,
    [
      "[merged forward]",
      "Alice(1001): hello",
      "  [image: https://example.com/a.png](https://example.com/a.png)",
      "Bob(1002): [@1001](at:1001) received",
    ].join("\n"),
  );
});

test("onebot inbound merged-forward segments are fetched and stored in session text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    adapter.callAction = async (action: string, params: any) => {
      assert.equal(action, "get_forward_msg");
      assert.deepEqual(params, { id: "forward-1" });
      return {
        messages: [
          {
            type: "node",
            data: {
              user_id: "1001",
              nickname: "Alice",
              content: "first message",
            },
          },
          {
            type: "node",
            data: {
              user_id: "1002",
              nickname: "Bob",
              content: [{ type: "text", data: { text: "second message" } }],
            },
          },
        ],
      };
    };

    const session = await adapter.buildSession({
      post_type: "message",
      message_type: "group",
      self_id: 1,
      group_id: 2000,
      user_id: 1000,
      message_id: 42,
      sender: { nickname: "Sender" },
      message: [
        { type: "text", data: { text: "please read " } },
        { type: "forward", data: { id: "forward-1" } },
      ],
    });

    assert.equal(session.elements[1]?.type, "forward");
    assert.equal(session.elements[1]?.attrs?.id, "forward-1");
    assert.equal(
      session.content,
      [
        "please read [forward: forward-1]",
        "Alice(1001): first message",
        "Bob(1002): second message",
      ].join("\n"),
    );
  });
});

test("onebot adapter degrades markdown formatting instead of exposing raw markdown", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: Array<{ action: string; params: any }> = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };

    const result = await app.bots[0].sendMessage("private:2", [
      h.markdown(
        "**bold** [docs](https://example.com)\n- one\n1. first\n> quoted",
      ),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].action, "send_private_msg");
    assert.deepEqual(calls[0].params.message, [
      {
        type: "text",
        data: { text: "bold docs\n- one\n1. first\n> quoted" },
      },
    ]);
  });
});

test("onebot adapter renders structured at as a native message segment", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: Array<{ action: string; params: any }> = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };

    await app.bots[0].sendMessage("2", [
      h.at("12345", { name: "Alice" }),
      h.text(" hello [CQ:image,file=not-media]"),
    ]);

    assert.equal(calls[0].action, "send_group_msg");
    assert.deepEqual(calls[0].params.message, [
      { type: "at", data: { qq: "12345" } },
      {
        type: "text",
        data: { text: " hello [CQ:image,file=not-media]" },
      },
    ]);
    assert.equal("auto_escape" in calls[0].params, false);
  });
});

test("onebot adapter routes files through native upload with the requested name", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const imagePath = path.join(agentDir, "avatar.png");
    const videoPath = path.join(agentDir, "clip.mp4");
    const filePath = path.join(agentDir, "random-source-name.txt");
    const calls: Array<{ action: string; params: any }> = [];
    await fs.writeFile(imagePath, Buffer.from("png"));
    await fs.writeFile(videoPath, Buffer.from("mp4"));
    await fs.writeFile(filePath, Buffer.from("notes"));
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return action === "upload_private_file"
        ? { file_id: "file-1" }
        : { message_id: "m1" };
    };

    const result = await app.bots[0].sendMessage("private:2", [
      h.image(imagePath),
      h("video", { src: videoPath, name: "clip.mp4", mimeType: "video/mp4" }),
      h.file(filePath, "text/plain", { name: "report final.txt" }),
    ]);

    assert.deepEqual(result, ["m1", "file-1"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, "send_private_msg");
    assert.deepEqual(calls[0].params.message, [
      { type: "image", data: { file: "base64://cG5n" } },
      { type: "video", data: { file: "base64://bXA0" } },
    ]);
    assert.equal(calls[1].action, "upload_private_file");
    assert.equal(calls[1].params.user_id, 2);
    assert.equal(calls[1].params.file, "base64://bm90ZXM=");
    assert.equal(calls[1].params.name, "report final.txt");
    assert.equal(calls[1].params.upload_file, true);
    assert.equal(
      calls[1].params.timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  });
});

test("onebot adapter falls back to a safe rich node during serialization", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: Array<{ action: string; params: any }> = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "m1" };
    };
    const missingPath = path.join(agentDir, "missing.pdf");

    const result = await app.bots[0].sendMessage("2", [
      h.text("before "),
      h("file", { src: missingPath, name: "missing.pdf" }),
      h.text(" after"),
    ]);

    assert.deepEqual(result, ["m1", "m1", "m1"]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].params.message, [
      { type: "text", data: { text: "before " } },
    ]);
    assert.deepEqual(calls[1].params.message, [
      { type: "text", data: { text: "[file: missing.pdf]" } },
    ]);
    assert.deepEqual(calls[2].params.message, [
      { type: "text", data: { text: " after" } },
    ]);
    assert.doesNotMatch(JSON.stringify(calls), /chat_media_file_missing:/);
  });
});

test("onebot adapter falls back to plain text after a confirmed rich send failure", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: Array<{ action: string; params: any }> = [];
    const filePath = path.join(agentDir, "draft.xlsx");
    await fs.writeFile(filePath, Buffer.from("draft"));
    adapter.callAction = (action: string, params: any) => {
      calls.push({ action, params });
      if (action === "upload_group_file") {
        const error: any = runtime.oneBotActionRejectedError({
          wording: "group file upload failed: code=-303 msg=invalid file name",
        });
        assert.equal(error.chatOutboxConfirmedNotDelivered, true);
        const rejected = Promise.reject(error) as Promise<any> & {
          dispatched?: Promise<void>;
        };
        rejected.dispatched = Promise.resolve();
        return rejected;
      }
      return Promise.resolve({
        message_id: calls.length === 1 ? "caption-message" : "fallback-message",
      });
    };

    const result = await app.bots[0].sendMessage("2", [
      h.quote("88"),
      h.text("Resending as plain text:\n"),
      h.file(
        filePath,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        {
          name: "draft.xlsx",
        },
      ),
    ]);

    assert.deepEqual(result, ["caption-message", "fallback-message"]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].action, "send_group_msg");
    assert.deepEqual(calls[0].params.message, [
      { type: "reply", data: { id: "88" } },
      { type: "text", data: { text: "Resending as plain text:\n" } },
    ]);
    assert.doesNotMatch(
      JSON.stringify(calls[0].params.message),
      /CQ:file|base64:/,
    );
    assert.equal(calls[1].action, "upload_group_file");
    assert.equal(calls[1].params.group_id, 2);
    assert.equal(calls[1].params.file, "base64://ZHJhZnQ=");
    assert.equal(calls[1].params.name, "draft.xlsx");
    assert.equal(calls[1].params.upload_file, true);
    assert.equal(calls[2].action, "send_group_msg");
    assert.deepEqual(calls[2].params.message, [
      { type: "text", data: { text: "[file: draft.xlsx]" } },
    ]);
    assert.equal(calls[2].params.timeout, runtime.ONEBOT_ACTION_TIMEOUT_MS);
  });
});

test("onebot adapter exposes media send dispatch before the OneBot echo", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { selfId: "1", url: "ws://127.0.0.1:9" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const filePath = path.join(agentDir, "pack.mrpack");
    await fs.writeFile(filePath, Buffer.from("pack"));
    let resolveAction: (value: any) => void = () => {};
    adapter.callAction = () => {
      const action = new Promise((resolve) => {
        resolveAction = resolve;
      }) as Promise<any> & { dispatched?: Promise<void> };
      action.dispatched = Promise.resolve();
      return action;
    };

    const delivery = app.bots[0].sendMessage("2", [
      h.file(filePath, "application/octet-stream", { name: "pack.mrpack" }),
    ]);

    assert.equal(typeof delivery?.dispatched?.then, "function");
    await delivery.dispatched;
    resolveAction({ message_id: "m1" });
    assert.deepEqual(await delivery, ["m1"]);
  });
});

test("onebot media actions use the extended action timeout", () => {
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", { message: "plain text" }),
    runtime.ONEBOT_ACTION_TIMEOUT_MS,
  );
  assert.equal(
    runtime.oneBotActionTimeoutMs("send_group_msg", {
      message: "[CQ:file,file=base64://cGFjaw==]",
    }),
    runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
  );
  assert.equal(
    runtime.oneBotActionTimeoutMs("upload_group_file", {
      file: "/srv/onebot/cache/pack.mrpack",
    }),
    runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
  );
});

test("onebot send and upload actions pass bounded protocol timeouts", () => {
  assert.equal(
    runtime.withOneBotActionTimeoutParam("send_group_msg", {
      message: "plain text",
    }).timeout,
    runtime.ONEBOT_ACTION_TIMEOUT_MS,
  );
  for (const action of ["send_private_msg", "send_group_msg", "send_msg"]) {
    assert.equal(
      runtime.withOneBotActionTimeoutParam(action, {
        message: "[CQ:image,file=base64://cG5n]",
      }).timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  }
  for (const action of ["upload_private_file", "upload_group_file"]) {
    assert.equal(
      runtime.withOneBotActionTimeoutParam(action, {
        file: "/srv/onebot/cache/card.png",
      }).timeout,
      runtime.ONEBOT_MEDIA_ACTION_TIMEOUT_MS,
    );
  }
  assert.equal(
    runtime.withOneBotActionTimeoutParam("get_msg", { message_id: 1 }).timeout,
    undefined,
  );
  assert.equal(
    runtime.withOneBotActionTimeoutParam("send_group_msg", {
      message: "[CQ:image,file=base64://cG5n]",
      timeout: 42,
    }).timeout,
    42,
  );
});

test("onebot action failures preserve the adapter error without path hints", () => {
  const message = runtime.formatOneBotActionFailureMessage({
    status: "failed",
    retcode: 1200,
    message: "rich media transfer failed",
  });

  assert.equal(message, "rich media transfer failed");
});

test("onebot generic file-word failures preserve the adapter error", () => {
  const message = runtime.formatOneBotActionFailureMessage({
    status: "failed",
    retcode: 1200,
    message: "Timeout while sending file list update",
  });

  assert.equal(message, "Timeout while sending file list update");
});

test("lark adapter sends text and structured at as native post elements", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.at("ou_123", { name: "Alice" }),
      h.text(" hello"),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].data.msg_type, "post");
    assert.deepEqual(JSON.parse(calls[0].data.content), {
      zh_cn: {
        content: [
          [
            { tag: "at", user_id: "ou_123" },
            { tag: "text", text: " hello" },
          ],
        ],
      },
    });
  });
});

test("lark adapter rejects a nonzero API response even when the SDK resolves", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    adapter.client = {
      im: {
        message: {
          create: async () => ({ code: 230001, msg: "invalid message" }),
        },
      },
    };

    await assert.rejects(
      app.bots[0].sendMessage("oc_1", [h.text("hello")]),
      /lark_api_error:230001:invalid message/,
    );
  });
});

test("lark adapter sends quote nodes through the native reply endpoint", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(["create", payload]);
            return { data: { message_id: "created" } };
          },
          reply: async (payload: any) => {
            calls.push(["reply", payload]);
            return { data: { message_id: "reply-1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.quote("om-parent"),
      h.text("follow up"),
    ]);

    assert.deepEqual(result, ["reply-1"]);
    assert.deepEqual(calls, [
      [
        "reply",
        {
          path: { message_id: "om-parent" },
          data: {
            msg_type: "post",
            content: JSON.stringify({
              zh_cn: { content: [[{ tag: "text", text: "follow up" }]] },
            }),
          },
        },
      ],
    ]);
  });
});

test("lark adapter uploads images and preserves surrounding text order", async () => {
  await withTempDir(async (agentDir) => {
    const imagePath = path.join(agentDir, "preview.png");
    await fs.writeFile(imagePath, Buffer.from("test-image"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    let nextMessageId = 1;
    adapter.client = {
      im: {
        image: {
          create: async (payload: any) => {
            calls.push({ method: "uploadImage", payload });
            return { image_key: "img_v2_preview" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push({ method: "createMessage", payload });
            return { data: { message_id: `m${nextMessageId++}` } };
          },
          delete: async (payload: any) => {
            calls.push({ method: "deleteMessage", payload });
            return { ok: true };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h.image(imagePath),
      h.text("after"),
    ]);

    assert.deepEqual(result, ["m1", "m2", "m3"]);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["createMessage", "uploadImage", "createMessage", "createMessage"],
    );
    assert.equal(calls[0].payload.data.msg_type, "post");
    assert.equal(calls[1].payload.data.image_type, "message");
    assert.deepEqual(calls[1].payload.data.image, Buffer.from("test-image"));
    assert.equal(calls[2].payload.data.msg_type, "image");
    assert.deepEqual(JSON.parse(calls[2].payload.data.content), {
      image_key: "img_v2_preview",
    });
    assert.equal(calls[3].payload.data.msg_type, "post");
  });
});

test("lark adapter uploads ordinary files and sends the returned file key", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "notes.txt");
    await fs.writeFile(filePath, Buffer.from("text-content"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        file: {
          create: async (payload: any) => {
            calls.push({ method: "uploadFile", payload });
            return { file_key: "file_v2_spec" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push({ method: "createMessage", payload });
            return { data: { message_id: `m${calls.length}` } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h.file(filePath, "text/plain", { name: "notes.txt" }),
      h.text("after"),
    ]);

    assert.equal(result.length, 3);
    assert.deepEqual(
      calls.map((entry) => entry.method),
      ["createMessage", "uploadFile", "createMessage", "createMessage"],
    );
    assert.deepEqual(calls[1].payload.data, {
      file_type: "stream",
      file_name: "notes.txt",
      file: Buffer.from("text-content"),
    });
    assert.equal(calls[2].payload.data.msg_type, "file");
    assert.deepEqual(JSON.parse(calls[2].payload.data.content), {
      file_key: "file_v2_spec",
    });
  });
});

test("lark adapter falls back from a failed file upload without exposing local paths or SDK errors", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "spec.pdf");
    await fs.writeFile(filePath, Buffer.from("pdf-content"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        file: {
          create: async () => {
            throw new Error("Request failed with status code 400");
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: `m${calls.length}` } };
          },
        },
      },
    };

    const original = `[FILE:   spec.pdf](${filePath})`;
    const result = await app.bots[0].sendMessage("oc_1", [
      h.text("before"),
      h("markdown", { content: original }),
      h.text("after"),
    ]);

    assert.deepEqual(result, ["m1", "m2", "m3"]);
    assert.equal(calls[1].data.msg_type, "text");
    assert.equal(JSON.parse(calls[1].data.content).text, "[file: spec.pdf]");
    assert.doesNotMatch(calls[1].data.content, /status code 400/);
  });
});

test("lark adapter falls back when the file message is rejected after upload", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        file: {
          create: async () => ({ file_key: "file_v2_draft" }),
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            if (payload.data.msg_type === "file") {
              return { code: 230001, msg: "invalid file message" };
            }
            return { data: { message_id: "fallback-message" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.file(Buffer.from("draft"), "application/octet-stream", {
        name: "draft.bin",
      }),
    ]);

    assert.deepEqual(result, ["fallback-message"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].data.msg_type, "file");
    assert.equal(calls[1].data.msg_type, "text");
    assert.equal(JSON.parse(calls[1].data.content).text, "[file: draft.bin]");
  });
});

test("lark adapter reports partial delivery when the original file fallback also fails", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "spec.pdf");
    await fs.writeFile(filePath, Buffer.from("pdf-content"));
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    let delivered = 0;
    adapter.client = {
      im: {
        file: {
          create: async () => {
            throw new Error("Request failed with status code 400");
          },
        },
        message: {
          create: async (payload: any) => {
            if (payload.data.msg_type === "text") {
              throw new Error("fallback unavailable");
            }
            delivered += 1;
            return { data: { message_id: `m${delivered}` } };
          },
        },
      },
    };

    await assert.rejects(
      () =>
        app.bots[0].sendMessage("oc_1", [
          h.text("before"),
          h.file(filePath, "application/pdf", { name: "spec.pdf" }),
          h.text("after"),
        ]),
      (error: any) => {
        assert.match(
          error.message,
          /^chat_delivery_partial:Request failed with status code 400/,
        );
        assert.deepEqual(error.deliveredMessageIds, ["m1", "m2"]);
        return true;
      },
    );
  });
});

test("lark adapter downloads remote images and uses the native reply endpoint", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    try {
      adapter.httpTransport.fetch = async () =>
        new Response(Buffer.from("remote-image"), { status: 200 });
      adapter.client = {
        im: {
          image: {
            create: async (payload: any) => {
              calls.push({ method: "uploadImage", payload });
              return { data: { image_key: "img_v2_remote" } };
            },
          },
          message: {
            reply: async (payload: any) => {
              calls.push({ method: "reply", payload });
              return { data: { message_id: "reply-image" } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.quote("om_parent"),
        h.image("https://example.com/remote.png"),
      ]);

      assert.deepEqual(result, ["reply-image"]);
      assert.deepEqual(
        calls.map((entry) => entry.method),
        ["uploadImage", "reply"],
      );
      assert.deepEqual(
        calls[0].payload.data.image,
        Buffer.from("remote-image"),
      );
      assert.equal(calls[1].payload.path.message_id, "om_parent");
      assert.equal(calls[1].payload.data.msg_type, "image");
      assert.deepEqual(JSON.parse(calls[1].payload.data.content), {
        image_key: "img_v2_remote",
      });
    } finally {
      await app.stop();
    }
  });
});

test("lark adapter sends failed image markers as plain text and continues later text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    const failedResponse = new Response("missing", { status: 404 });
    try {
      adapter.httpTransport.fetch = async () => failedResponse;
      adapter.client = {
        im: {
          image: {
            create: async () => {
              throw new Error("image upload should not run");
            },
          },
          message: {
            create: async (payload: any) => {
              calls.push(payload);
              return { data: { message_id: `m${calls.length}` } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.text("before"),
        h("image", {
          src: "https://example.com/missing.png",
          name: "missing",
        }),
        h.text("after"),
      ]);

      assert.deepEqual(result, ["m1", "m2", "m3"]);
      assert.equal(calls.length, 3);
      assert.equal(
        JSON.parse(calls[0].data.content).zh_cn.content[0][0].text,
        "before",
      );
      assert.equal(calls[1].data.msg_type, "text");
      assert.equal(
        JSON.parse(calls[1].data.content).text,
        "[image: missing](https://example.com/missing.png)",
      );
      assert.doesNotMatch(calls[1].data.content, /Failed to download/);
      assert.equal(
        JSON.parse(calls[2].data.content).zh_cn.content[0][0].text,
        "after",
      );
      assert.equal(failedResponse.bodyUsed, true);
    } finally {
      await app.stop();
    }
  });
});

test("lark adapter falls back from oversized local images before upload", async () => {
  await withTempDir(async (agentDir) => {
    const imagePath = path.join(agentDir, "oversized.png");
    const imageFile = await fs.open(imagePath, "w");
    await imageFile.truncate(10 * 1024 * 1024 + 1);
    await imageFile.close();
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const calls: any[] = [];
    let uploadAttempted = false;
    adapter.client = {
      im: {
        image: {
          create: async () => {
            uploadAttempted = true;
            return { image_key: "unexpected" };
          },
        },
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "limit-error" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      runtime.createChatNodes().image(imagePath),
    ]);

    assert.deepEqual(result, ["limit-error"]);
    assert.equal(uploadAttempted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.msg_type, "text");
    assert.equal(
      JSON.parse(calls[0].data.content).text,
      "[image: oversized.png]",
    );
    assert.doesNotMatch(calls[0].data.content, /upload limit/);
  });
});

test("lark adapter falls back from remote images declared over the upload limit", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    let uploadAttempted = false;
    let fetchSignal: AbortSignal | undefined;
    const oversizedResponse = new Response("small body", {
      status: 200,
      headers: { "content-length": String(10 * 1024 * 1024 + 1) },
    });
    try {
      adapter.httpTransport.fetch = async (_url: any, init: any) => {
        fetchSignal = init?.signal as AbortSignal | undefined;
        return oversizedResponse;
      };
      adapter.client = {
        im: {
          image: {
            create: async () => {
              uploadAttempted = true;
              return { image_key: "unexpected" };
            },
          },
          message: {
            create: async (payload: any) => {
              calls.push(payload);
              return { data: { message_id: "remote-limit-error" } };
            },
          },
        },
      };

      const result = await app.bots[0].sendMessage("oc_1", [
        h.image("https://example.com/oversized.png"),
      ]);

      assert.deepEqual(result, ["remote-limit-error"]);
      assert.equal(fetchSignal?.aborted, true);
      assert.equal(uploadAttempted, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].data.msg_type, "text");
      assert.equal(
        JSON.parse(calls[0].data.content).text,
        "[image: https://example.com/oversized.png](https://example.com/oversized.png)",
      );
      assert.doesNotMatch(calls[0].data.content, /upload limit/);
      assert.equal(oversizedResponse.bodyUsed, true);
    } finally {
      await app.stop();
    }
  });
});

test("onebot group working indicator retries clearing a stale reaction without current message metadata", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    const adapter = [...app.platforms][0];
    const calls: Array<{ action: string; params: any }> = [];
    let failNextClear = true;
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      if (
        action === "set_msg_emoji_like" &&
        params?.set === false &&
        failNextClear
      ) {
        failNextClear = false;
        throw new Error("transient clear failure");
      }
      return {};
    };

    const [indicator] = app.bots[0].getWorkingIndicators({ chatId: "123" });
    await indicator.tick({ chatId: "123", messageId: "101", tick: 0 });
    await indicator.tick({ chatId: "123", messageId: "101", tick: 1 });
    await assert.rejects(
      indicator.end({ chatId: "123", messageId: "101" }),
      /transient clear failure/,
    );
    assert.equal(await indicator.end({ chatId: "123" }), true);

    assert.deepEqual(
      calls
        .filter((entry) => entry.action === "set_msg_emoji_like")
        .map((entry) => entry.params),
      [
        { message_id: 101, emoji_id: "212", set: true },
        { message_id: 101, emoji_id: "212", set: false },
        { message_id: 101, emoji_id: "212", set: false },
      ],
    );
  });
});

test("onebot private working indicator is a one-shot marker", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    const adapter = [...app.platforms][0];
    const calls: any[] = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "notice-1" };
    };

    const [indicator] = app.bots[0].getWorkingIndicators({
      chatId: "private:2",
    });

    assert.equal(indicator.type, "marker");
    assert.equal(typeof indicator.tick, "undefined");
    assert.equal(
      await indicator.start({ chatId: "private:2", messageId: "m1" }),
      true,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "send_private_msg");
    assert.equal(calls[0].params.user_id, 2);
    assert.equal("auto_escape" in calls[0].params, false);
    assert.deepEqual(calls[0].params.message, [
      { type: "reply", data: { id: "m1" } },
      { type: "text", data: { text: "Working..." } },
    ]);
  });
});

test("onebot private marker uses extension presentation working text", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "onebot",
      name: "OneBot",
      config: { endpoint: "ws://127.0.0.1:1" },
    });
    app.setWorkingText(
      "\u5de5\u4f5c\u4e2d... (\u0e51\u2022\u0300\u3142\u2022\u0301)\u0648\u2727",
    );
    const adapter = [...app.platforms][0];
    const calls: any[] = [];
    adapter.callAction = async (action: string, params: any) => {
      calls.push({ action, params });
      return { message_id: "notice-1" };
    };

    const [indicator] = app.bots[0].getWorkingIndicators({
      chatId: "private:2",
    });

    assert.equal(
      await indicator.start({ chatId: "private:2", messageId: "m1" }),
      true,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.message, [
      { type: "reply", data: { id: "m1" } },
      {
        type: "text",
        data: {
          text: "\u5de5\u4f5c\u4e2d... (\u0e51\u2022\u0300\u3142\u2022\u0301)\u0648\u2727",
        },
      },
    ]);
  });
});

test("lark working indicator adds one fixed reaction and removes it on end", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const calls: any[] = [];
    adapter.client = {
      im: {
        messageReaction: {
          create: async (payload: any) => {
            calls.push(["create", payload]);
            return {};
          },
          list: async (payload: any) => {
            calls.push(["list", payload]);
            return {
              data: {
                items: [
                  {
                    reaction_id: "reaction-thinking",
                    reaction_type: { emoji_type: "THINKING" },
                    operator: { operator_type: "app" },
                  },
                ],
              },
            };
          },
          delete: async (payload: any) => {
            calls.push(["delete", payload]);
            return {};
          },
        },
      },
    };

    const indicator = requireReactionIndicator(app.bots[0]);
    await indicator.tick({ chatId: "oc_1", messageId: "om_1", tick: 0 });
    await indicator.tick({ chatId: "oc_1", messageId: "om_1", tick: 1 });
    await indicator.end({ chatId: "oc_1", messageId: "om_1" });

    assert.deepEqual(
      calls.map(([kind]) => kind),
      ["create", "list", "delete"],
    );
    assert.equal(calls[0][1].data.reaction_type.emoji_type, "THINKING");
    assert.equal(calls[2][1].path.reaction_id, "reaction-thinking");
  });
});

test("lark adapter maps manual and waiting reactions to supported emoji types", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const calls: any[] = [];
    adapter.client = {
      im: {
        messageReaction: {
          create: async (payload: any) => {
            calls.push(payload);
            return {};
          },
        },
      },
    };

    assert.equal(await app.bots[0].createReaction("oc_1", "om_1", "🔥"), true);
    assert.equal(await app.bots[0].createReaction("oc_1", "om_2", "⏳"), true);
    assert.equal(calls[0].data.reaction_type.emoji_type, "Fire");
    assert.equal(calls[1].data.reaction_type.emoji_type, "Hourglass");
  });
});

test("lark reaction operations reject resolved Feishu API failures", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    let mode = "create";
    adapter.client = {
      im: {
        messageReaction: {
          create: async () => ({ code: 230001, msg: "create failed" }),
          list: async () =>
            mode === "list"
              ? { code: 230002, msg: "list failed" }
              : {
                  code: 0,
                  data: {
                    items: [
                      {
                        reaction_id: "reaction-1",
                        reaction_type: { emoji_type: "THINKING" },
                        operator: { operator_type: "app" },
                      },
                    ],
                  },
                },
          delete: async () => ({ code: 230003, msg: "delete failed" }),
        },
      },
    };

    await assert.rejects(
      app.bots[0].createReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230001:create failed/,
    );
    mode = "list";
    await assert.rejects(
      app.bots[0].deleteReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230002:list failed/,
    );
    mode = "delete";
    await assert.rejects(
      app.bots[0].deleteReaction("oc_1", "om_1", "🤔"),
      /lark_api_error:230003:delete failed/,
    );
  });
});

test("lark adapter maps markdown inline styles and mentions to native elements", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.markdown("**bold** [docs](https://example.com)"),
      h.text("\n"),
      h.at("ou_123", { name: "Alice" }),
    ]);

    assert.deepEqual(result, ["m1"]);
    assert.equal(calls[0].data.msg_type, "post");
    assert.deepEqual(JSON.parse(calls[0].data.content), {
      zh_cn: {
        content: [
          [
            { tag: "text", text: "bold", style: ["bold"] },
            { tag: "text", text: " " },
            { tag: "a", text: "docs", href: "https://example.com" },
            { tag: "text", text: "\n" },
            { tag: "at", user_id: "ou_123" },
          ],
        ],
      },
    });
  });
});

test("lark adapter falls back when mention markup is not structurally native", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };
    const markdown = '<at user_id="ou_123">Alice **bold**</at>';

    await app.bots[0].sendMessage("oc_1", [h.markdown(markdown)]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "md", text: markdown }],
    ]);
  });
});

test("lark adapter serializes simple markdown as native post paragraphs", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    await app.bots[0].sendMessage("oc_1", [
      h.markdown("intro **bold** [link](https://example.com)\n\noutro"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        { tag: "text", text: "intro " },
        { tag: "text", text: "bold", style: ["bold"] },
        { tag: "text", text: " " },
        { tag: "a", text: "link", href: "https://example.com" },
      ],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "outro" }],
    ]);
  });
});

test("lark adapter preserves unsupported link content by falling back to markdown", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    await app.bots[0].sendMessage("oc_1", [
      h.markdown(
        "[**bold**](https://example.com)\n\n[`code`](https://example.com)",
      ),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        {
          tag: "a",
          text: "bold",
          href: "https://example.com",
          style: ["bold"],
        },
      ],
      [{ tag: "text", text: "\n" }],
      [{ tag: "md", text: "[`code`](https://example.com)" }],
    ]);
  });
});

test("lark adapter emits fenced code through the native code block tag", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };
    await app.bots[0].sendMessage("oc_1", [
      h.markdown("before\n\n```ts\nconst value = 1;\n```\n\nafter"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "text", text: "before" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "code_block", language: "ts", text: "const value = 1;" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "after" }],
    ]);
  });
});

test("lark adapter preserves blockquotes and indented code blocks", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    await app.bots[0].sendMessage("oc_1", [
      h.markdown("> first\n>\n> second\n\n    alpha\n\n    beta\n\noutro"),
    ]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [{ tag: "md", text: "> first\n>\n> second" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "code_block", text: "alpha\n\nbeta" }],
      [{ tag: "text", text: "\n" }],
      [{ tag: "text", text: "outro" }],
    ]);
  });
});

test("lark adapter resolves cross-paragraph reference links into native links", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };
    const markdown =
      "first [docs]\n\nsecond [docs]\n\n[docs]: https://example.com";

    await app.bots[0].sendMessage("oc_1", [h.markdown(markdown)]);

    assert.deepEqual(JSON.parse(calls[0].data.content).zh_cn.content, [
      [
        { tag: "text", text: "first " },
        { tag: "a", text: "docs", href: "https://example.com" },
      ],
      [{ tag: "text", text: "\n" }],
      [
        { tag: "text", text: "second " },
        { tag: "a", text: "docs", href: "https://example.com" },
      ],
    ]);
  });
});

test("lark adapter preserves nested markdown list indentation and links", async () => {
  await withTempDir(async (agentDir) => {
    const app = createRuntimeApp(agentDir, {
      key: "lark",
      name: "Lark",
      config: { appId: "app", appSecret: "secret" },
    });
    const adapter = [...app.platforms][0];
    const h = runtime.createChatNodes();
    const calls: any[] = [];
    adapter.client = {
      im: {
        message: {
          create: async (payload: any) => {
            calls.push(payload);
            return { data: { message_id: "m1" } };
          },
        },
      },
    };

    const result = await app.bots[0].sendMessage("oc_1", [
      h.markdown(
        "- first\n  - child [docs](https://example.com)\n  - second child\n- second",
      ),
    ]);

    assert.deepEqual(result, ["m1"]);
    const content = JSON.parse(calls[0].data.content);
    assert.equal(
      content.zh_cn.content[0][0].text,
      "- first\n  - child [docs](https://example.com)\n  - second child\n- second",
    );
  });
});
