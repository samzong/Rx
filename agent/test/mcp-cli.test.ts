import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertProcessExited, mcpPid, tempDir } from "./helpers.ts";

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  test(`CLI ${signal} during MCP startup closes its child`, { timeout: 15_000 }, async (t) => {
    const home = tempDir();
    const cwd = tempDir();
    const trace = join(home, "startup.jsonl");
    const fixture = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { hanging: { command: process.execPath, args: [fixture, "--hang", `--trace=${trace}`] } } }));
    const child = spawn(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "-p", "startup cancellation"], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: tempDir(),
        RX_HOME: home,
        RX_MODEL: "local/plain",
        RX_TEST_API_KEY: "test-key",
        RX_AGENT_PROVIDER: JSON.stringify({ id: "local", name: "Local", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", env: "RX_TEST_API_KEY", models: [{ id: "plain", contextWindow: 64000, reasoning: false }], defaultModel: "plain" }),
      },
      stdio: "ignore",
    });
    let pid: number | undefined;
    t.after(() => { child.kill("SIGKILL"); if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    pid = await mcpPid(trace);
    child.kill(signal);
    const result = await exited;
    await assertProcessExited(pid);
    assert.equal(result.signal, null);
    assert.equal(result.code, signal === "SIGTERM" ? 143 : 129);
    assert.equal(existsSync(join(home, "sessions")), false);
  });
}
