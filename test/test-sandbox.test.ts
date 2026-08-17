import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { testSandboxState } from "./require-test-sandbox.ts";

test("every extension test starts inside a disposable state root", () => {
  assert.notEqual(
    path.resolve(process.env.HOME!),
    testSandboxState.originalHome,
  );
  for (const name of [
    "HOME",
    "RIN_DIR",
    "RIN_AGENT_DIR",
    "RIN_DAEMON_SOCKET_PATH",
  ]) {
    const resolved = path.resolve(process.env[name]!);
    assert.ok(resolved.startsWith(`${testSandboxState.root}${path.sep}`));
  }
  assert.equal(process.env.RIN_OFFLINE, "1");
  assert.equal(process.env.NO_PROXY, "");
});

test("every extension test loads the sandbox before extension code", () => {
  const required = 'import "./require-test-sandbox.ts";';
  for (const entry of fs.readdirSync(path.resolve("test"), {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const firstLine = fs
      .readFileSync(path.resolve("test", entry.name), "utf8")
      .split(/\r?\n/u, 1)[0];
    assert.equal(firstLine, required, entry.name);
  }
});
