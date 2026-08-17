import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type TestSandboxState = {
  root: string;
  originalHome: string;
};

const stateKey = "__rinExtensionsTestSandboxV1" as const;
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: TestSandboxState;
};

function assertInside(root: string, name: string, value: string | undefined) {
  if (!value) throw new Error(`test_sandbox_path_missing:${name}`);
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`test_sandbox_path_escape:${name}:${resolved}`);
  }
}

if (!globalState[stateKey]) {
  const originalHome = path.resolve(process.env.HOME || os.homedir());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-extensions-test-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const runtimeDir = path.join(root, "runtime");
  const tempDir = path.join(root, "tmp");
  const cacheDir = path.join(root, "cache");
  const configDir = path.join(root, "config");
  for (const directory of [
    home,
    agentDir,
    runtimeDir,
    tempDir,
    cacheDir,
    configDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.chmodSync(runtimeDir, 0o700);
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_RUNTIME_DIR: runtimeDir,
    RIN_DIR: agentDir,
    RIN_AGENT_DIR: agentDir,
    RIN_DAEMON_SOCKET_PATH: path.join(runtimeDir, "rin-daemon", "daemon.sock"),
    RIN_TEST_SANDBOX_ROOT: root,
    RIN_OFFLINE: "1",
    RIN_SKIP_VERSION_CHECK: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
  });
  globalState[stateKey] = { root, originalHome };
  process.once("exit", () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

export const testSandboxState = globalState[stateKey]!;
for (const name of [
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "RIN_DIR",
  "RIN_AGENT_DIR",
  "RIN_DAEMON_SOCKET_PATH",
]) {
  assertInside(testSandboxState.root, name, process.env[name]);
}
if (path.resolve(process.env.HOME!) === testSandboxState.originalHome) {
  throw new Error("test_sandbox_reused_live_home");
}
if (process.env.RIN_OFFLINE !== "1" || process.env.NO_PROXY !== "") {
  throw new Error("test_network_isolation_missing");
}
