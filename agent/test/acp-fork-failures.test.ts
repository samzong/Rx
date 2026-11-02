import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createAcpApp } from "../src/acp.ts";
import { SessionLog } from "../src/session-log.ts";
import { assertProcessExited, fauxModels, mcpPid, tempDir } from "./helpers.ts";

process.env.HOME = tempDir();
process.env.RX_HOME = tempDir();

test("failed SessionStart removes new and fork logs and locks while preserving load and source logs", async () => {
  const { models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const source = SessionLog.create(home, cwd);
  source.append("acp", { role: "user", content: "source task", timestamp: 1 });
  const original = readFileSync(source.path);
  const files = readdirSync(join(home, "sessions")).sort();
  const hook = join(home, "reject.mjs");
  writeFileSync(hook, "process.exitCode=2;");
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] } }));
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  await acp.client().connectWith(app, async (ctx) => {
    for (const method of [acp.methods.agent.session.new, acp.methods.agent.session.fork, acp.methods.agent.session.load]) {
      await assert.rejects(ctx.request(method, { sessionId: source.id, cwd, mcpServers: [] }), (error: unknown) => error instanceof acp.RequestError && error.code === -32603);
      const listed = await ctx.request(acp.methods.agent.session.list, { cwd });
      assert.deepEqual(listed.sessions.map((session) => session.sessionId), [source.id]);
      assert.deepEqual(readdirSync(join(home, "sessions")).sort(), files);
      assert.deepEqual(readFileSync(source.path), original);
      assert.equal(readFileSync(join(home, "sessions", `${source.id}.lock`), "utf8"), String(process.pid));
    }
  });
});

test("failed cleanup preserves the SessionStart rejection, retained writer lock, and MCP teardown", { timeout: 15_000 }, async (t) => {
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  for (const method of [acp.methods.agent.session.new, acp.methods.agent.session.fork]) {
    const { models, model } = fauxModels();
    const home = tempDir();
    const cwd = tempDir();
    const source = SessionLog.create(home, cwd);
    source.append("acp", { role: "user", content: "source task", timestamp: 1 });
    const original = readFileSync(source.path);
    const sessions = join(home, "sessions");
    const hook = join(home, "readonly.mjs");
    writeFileSync(hook, "import {chmodSync} from 'node:fs'; import {dirname} from 'node:path'; let text=''; for await(const chunk of process.stdin) text+=chunk; chmodSync(dirname(JSON.parse(text).transcript_path),0o500); console.error('N1_SESSION_START_REJECTED'); process.exitCode=2;");
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] } }));
    const trace = join(home, "mcp.jsonl");
    const server: acp.McpServer = { name: "cleanup", command: process.execPath, args: [new URL("./fixtures/mcp-server.ts", import.meta.url).pathname, `--trace=${trace}`], env: [] };
    const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
    try {
      await acp.client().connectWith(app, async (ctx) => {
        const failure = await ctx.request(method, { sessionId: source.id, cwd, mcpServers: [server] }).catch((error: unknown) => error);
        const pid = await mcpPid(trace);
        pids.push(pid);
        await assertProcessExited(pid);
        assert.ok(failure instanceof acp.RequestError);
        assert.equal(failure.code, -32603);
        assert.match((failure.data as { details: string }).details, /Session opening failed: N1_SESSION_START_REJECTED/);
        const residual = readdirSync(sessions).filter((name) => name.endsWith(".jsonl") && name !== `${source.id}.jsonl`);
        assert.equal(residual.length, 1);
        const id = residual[0]!.slice(0, -6);
        assert.equal(readFileSync(join(sessions, `${id}.lock`), "utf8"), String(process.pid));
        assert.doesNotThrow(() => SessionLog.open(home, id));
        assert.deepEqual(readFileSync(source.path), original);
      });
    } finally {
      chmodSync(sessions, 0o700);
    }
  }
});

test("fork distinguishes source absence, log corruption, and source or target I/O errors", async (t) => {
  const { models, model } = fauxModels();
  const home = tempDir();
  const cwd = tempDir();
  const source = SessionLog.create(home, cwd);
  const original = readFileSync(source.path);
  const app = createAcpApp({ home, models, choose: async () => ({ model, thinking: "off" }) });
  await acp.client().connectWith(app, async (ctx) => {
    for (const [code, path, expected] of [
      ["ENOSPC", source.path, -32603],
      ["EACCES", source.path, -32603],
      ["ENOENT", source.path, -32002],
      ["ENOENT", join(home, "sessions", "target.jsonl"), -32603],
    ] as const) {
      const mock = t.mock.method(SessionLog, "fork", () => { throw Object.assign(new Error(code), { code, path }); });
      try {
        await assert.rejects(ctx.request(acp.methods.agent.session.fork, { sessionId: source.id, cwd }), (error: unknown) => error instanceof acp.RequestError && error.code === expected);
      } finally {
        mock.mock.restore();
      }
      assert.deepEqual(readFileSync(source.path), original);
    }
    const directoryId = randomUUID();
    mkdirSync(join(home, "sessions", `${directoryId}.jsonl`));
    await assert.rejects(ctx.request(acp.methods.agent.session.fork, { sessionId: directoryId, cwd }), (error: unknown) => error instanceof acp.RequestError && error.code === -32603);
    appendFileSync(source.path, "{broken\n");
    const corrupt = readFileSync(source.path);
    await assert.rejects(ctx.request(acp.methods.agent.session.fork, { sessionId: source.id, cwd }), (error: unknown) => error instanceof acp.RequestError && error.code === -32602);
    assert.deepEqual(readFileSync(source.path), corrupt);
    assert.equal(readdirSync(join(home, "sessions")).filter((name) => name.endsWith(".lock")).length, 1);
  });
});
