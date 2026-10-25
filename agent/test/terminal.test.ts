import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";

function terminal(t: TestContext, mode: "print" | "repl", behavior = "success") {
  const script = `
    import { runPrint, runRepl } from "./src/terminal.ts";
    import { registerContextControl } from "./src/context-control.ts";
    const listeners = new Set();
    const prompts = [];
    let calls = 0;
    let controller;
    let job = Promise.resolve();
    let cleaned = false;
    let idleWaits = 0;
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const control = {
      compact() {
        const id = "compact-" + ++calls;
        controller = new AbortController();
        emit({id, status: "in_progress"});
        job = (async () => {
          try {
            if (${JSON.stringify(behavior)} === "failure") throw new Error("summary unavailable");
            if (${JSON.stringify(behavior)} === "wait") {
              process.stdout.write("SUMMARY_STARTED\\n");
              await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, {once: true}));
              await new Promise((resolve) => setTimeout(resolve, 25));
              cleaned = true;
              throw new Error("summary cancelled");
            }
            emit({id, status: "completed"});
          } catch (error) {
            emit({id, status: "failed", message: error.message});
            throw error;
          }
        })();
        return job;
      },
      abort() { controller?.abort(); },
      async waitForIdle() { idleWaits++; await job.catch(() => {}); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const agent = {
      state: {model: {provider: "fixture", id: "fixture"}, thinkingLevel: "off", messages: []},
      subscribe() { return () => {}; },
      async prompt(input) {
        prompts.push(input);
        process.stdout.write("PROMPT " + JSON.stringify(input) + "\\n");
        if (${JSON.stringify(behavior)} === "automatic") await control.compact();
      },
      abort() {},
      async waitForIdle() {},
    };
    registerContextControl(agent, control);
    if (${JSON.stringify(mode)} === "print") await runPrint(agent, "/compact");
    else await runRepl(agent, "fixture");
    process.stdout.write("RESULT " + JSON.stringify({prompts, calls, cleaned, idleWaits, listeners: listeners.size}) + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const waitFor = async (predicate: (stdout: string, stderr: string) => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate(stdout, stderr)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `terminal output: ${stdout}\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const result = async () => {
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    const match = stdout.match(/RESULT (.*)/);
    assert.ok(match?.[1], stdout);
    return { ...JSON.parse(match[1]) as { prompts: string[]; calls: number; cleaned: boolean; idleWaits: number; listeners: number }, stdout, stderr };
  };
  const question = (count: number) => waitFor((out) => out.split("› ").length - 1 >= count);
  return { child, waitFor, question, result };
}

test("REPL compact bypasses the main agent and reports progress before accepting another task", async (t) => {
  const h = terminal(t, "repl");
  await h.question(1);
  h.child.stdin.write("  /compact  \n");
  await h.question(2);
  h.child.stdin.write("continue\n");
  await h.question(3);
  h.child.stdin.write("/exit\n");
  const result = await h.result();
  assert.deepEqual(result.prompts, ["continue"]);
  assert.equal(result.calls, 1);
  assert.match(result.stderr, /Compacting context\.\.\.\nContext compacted\./);
  assert.equal(result.listeners, 0);
});

test("a failed REPL summary preserves the REPL for the next task", async (t) => {
  const h = terminal(t, "repl", "failure");
  await h.question(1);
  h.child.stdin.write("/compact\n");
  await h.question(2);
  h.child.stdin.write("continue after failure\n");
  await h.question(3);
  h.child.stdin.write("/quit\n");
  const result = await h.result();
  assert.deepEqual(result.prompts, ["continue after failure"]);
  assert.match(result.stderr, /Context compaction failed: summary unavailable/);
  assert.equal(result.listeners, 0);
});

test("REPL command arguments stay ordinary text", async (t) => {
  const h = terminal(t, "repl");
  await h.question(1);
  h.child.stdin.write("/compact focus\n");
  await h.question(2);
  h.child.stdin.write("/exit\n");
  const result = await h.result();
  assert.deepEqual(result.prompts, ["/compact focus"]);
  assert.equal(result.calls, 0);
});

test("EOF aborts a running REPL summary and waits for cleanup", async (t) => {
  const h = terminal(t, "repl", "wait");
  await h.question(1);
  h.child.stdin.write("/compact\n");
  await h.waitFor((out) => out.includes("SUMMARY_STARTED"));
  h.child.stdin.end();
  const result = await h.result();
  assert.equal(result.cleaned, true);
  assert.ok(result.idleWaits > 0);
  assert.equal(result.listeners, 0);
  assert.match(result.stderr, /Context compaction failed: summary cancelled/);
});

test("print mode sends slash commands to the main agent", async (t) => {
  const h = terminal(t, "print");
  const result = await h.result();
  assert.deepEqual(result.prompts, ["/compact"]);
  assert.equal(result.calls, 0);
  assert.equal(result.listeners, 0);
});

test("print mode reports automatic compaction through the shared control", async (t) => {
  const h = terminal(t, "print", "automatic");
  const result = await h.result();
  assert.deepEqual(result.prompts, ["/compact"]);
  assert.equal(result.calls, 1);
  assert.match(result.stderr, /Compacting context\.\.\.\nContext compacted\./);
  assert.ok(result.idleWaits > 0);
});
