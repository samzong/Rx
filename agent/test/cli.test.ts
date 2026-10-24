import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { foreignSession, tempDir } from "./helpers.ts";

test("CLI failures preserve persistence, --continue recovers, and resume survives a deleted cwd", { timeout: 30_000 }, async (t) => {
  const home = tempDir();
  const rxHome = tempDir();
  const cwd = realpathSync(tempDir());
  const requests: { messages: { content?: unknown }[] }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "plain", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "recovered" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    RX_HOME: rxHome,
    RX_MODEL: "local/plain",
    RX_TEST_API_KEY: "test-key",
    RX_AGENT_PROVIDER: JSON.stringify({
      id: "local", name: "Local", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, env: "RX_TEST_API_KEY",
      models: [{ id: "plain", contextWindow: 64000, reasoning: false }],
      defaultModel: "plain",
    }),
  };
  const run = (args: string[], directory = cwd) => promisify(execFile)(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...args], { cwd: directory, env, timeout: 10_000 });
  writeFileSync(join(rxHome, "AGENTS.md"), "@./missing.md");
  await assert.rejects(run(["-p", "new task"]), (error: Error & { code?: number; stderr?: string }) => error.code === 1 && !!error.stderr?.includes("missing.md"));
  assert.equal(existsSync(join(rxHome, "sessions")), false);
  const { id, path, lock } = foreignSession(cwd, [["cli", { role: "user", content: "last real task", timestamp: Date.now() }]], rxHome);
  const before = readFileSync(path);
  for (const args of [["-p", "new task"], ["--continue", "-p", "continue task"], ["--resume", id, "-p", "resume task"]]) {
    await assert.rejects(run(args));
    assert.deepEqual(readdirSync(join(rxHome, "sessions")), [`${id}.jsonl`]);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(lock), false);
  }
  assert.equal(requests.length, 0);
  writeFileSync(join(rxHome, "missing.md"), "recovered instructions");
  writeFileSync(join(cwd, "AGENTS.md"), "@./missing-project.md");
  await assert.rejects(run(["--resume", id, "-p", "resume elsewhere"], tempDir()));
  assert.deepEqual(readdirSync(join(rxHome, "sessions")), [`${id}.jsonl`]);
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(lock), false);
  const literal = "@types/node\n@1.4.0\n@app.route";
  writeFileSync(join(cwd, "AGENTS.md"), literal);
  const result = await run(["--continue", "-p", "continue task"]);
  assert.match(result.stdout, /recovered/);
  assert.equal(requests.length, 1);
  assert.ok(JSON.stringify(requests[0]!.messages).includes("last real task"));
  assert.ok(requests[0]!.messages.some((message) => typeof message.content === "string" && message.content.includes(literal)));
  assert.deepEqual(readdirSync(join(rxHome, "sessions")), [`${id}.jsonl`]);
  const entries = readFileSync(path, "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
  assert.deepEqual(entries.slice(1).map((entry) => entry.origin), ["cli", "cli", "model"]);
  const globalSkill = join(home, ".agents", "skills", "global-helper", "SKILL.md");
  mkdirSync(join(globalSkill, ".."), { recursive: true });
  writeFileSync(globalSkill, "---\nname: global-helper\ndescription: Global recovery helper\n---\nUse when recovering history.\n");
  rmSync(cwd, { recursive: true });
  const resumed = await run(["-r", id, "-p", "resume after removal"], tempDir());
  assert.match(resumed.stdout, /recovered/);
  assert.ok(resumed.stderr.includes(`note: session ${id} was started in ${cwd}; tools run there`));
  const resumedPrompt = JSON.stringify(requests.at(-1)!.messages);
  assert.ok(resumedPrompt.includes("recovered instructions"));
  assert.ok(resumedPrompt.includes("global-helper"));
  assert.ok(resumedPrompt.includes("last real task"));
  assert.ok(!resumedPrompt.includes(literal));
  assert.deepEqual(readdirSync(join(rxHome, "sessions")), [`${id}.jsonl`]);
});
