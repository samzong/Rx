import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runHookCommand } from "../src/hook-runner.ts";
import type { HookInput } from "../src/hook-types.ts";
import { assertProcessExited, tempDir } from "./helpers.ts";

function fixture(t: { after: (fn: () => void) => void }, script: string): { cwd: string; input: HookInput; command: string } {
  const cwd = tempDir("rx-hook-runner-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "hook.sh"), script);
  return {
    cwd,
    command: "/bin/bash ./hook.sh",
    input: {
      hook_event_name: "PreToolUse",
      session_id: "fixture-session",
      cwd,
      transcript_path: join(cwd, "session.jsonl"),
      transcript_format: "rx-jsonl-v1",
      tool_input: { command: "input-private-marker\nsecond line", unicode: "雪" },
    },
  };
}

async function pids(cwd: string): Promise<number[]> {
  const path = join(cwd, "pids");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (content) {
      const result = content.split(" ").map(Number);
      assert.ok(result.every((pid) => Number.isInteger(pid) && pid > 0));
      return result;
    }
    await delay(10);
  }
  assert.fail("Hook fixture did not record its PIDs");
}

test("hook receives one JSON line, the working directory, and the inherited environment", async (t) => {
  const f = fixture(t, `'${process.execPath.replaceAll("'", "'\\''")}' ./receive.mjs`);
  writeFileSync(join(f.cwd, "receive.mjs"), `
    import { writeFileSync } from "node:fs";
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    writeFileSync("stdin.json", raw);
    process.stdout.write(JSON.stringify({ cwd: process.cwd(), inherited: !!process.env.PATH }));
    process.stderr.write("separate stderr");
  `);
  const controller = new AbortController();
  const result = await runHookCommand({ command: f.command, timeout: 5 }, f.input, controller.signal);
  assert.deepEqual(result, {
    code: 0,
    stdout: JSON.stringify({ cwd: realpathSync(f.cwd), inherited: true }),
    stderr: "separate stderr",
  });
  assert.equal(readFileSync(join(f.cwd, "stdin.json"), "utf8"), `${JSON.stringify(f.input)}\n`);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("hook returns the original nonzero exit code and complete output", async (t) => {
  const f = fixture(t, "printf 'complete stdout'; printf 'complete stderr' >&2; exit 2");
  assert.deepEqual(await runHookCommand({ command: f.command, timeout: 5 }, f.input), {
    code: 2,
    stdout: "complete stdout",
    stderr: "complete stderr",
  });
});

test("hook allows 64 KiB on each output stream", async (t) => {
  const f = fixture(t, "head -c 65536 /dev/zero; head -c 65536 /dev/zero >&2");
  const result = await runHookCommand({ command: f.command, timeout: 5 }, f.input);
  assert.equal(result.code, 0);
  assert.equal(Buffer.byteLength(result.stdout), 65536);
  assert.equal(Buffer.byteLength(result.stderr), 65536);
});

test("hook rejects stdout byte overflow and stops its process group", async (t) => {
  const f = fixture(t, `sleep 30 & printf '%s %s' "$$" "$!" > pids\nhead -c 65537 /dev/zero`);
  await assert.rejects(runHookCommand({ command: f.command, timeout: 5 }, f.input));
  for (const pid of await pids(f.cwd)) await assertProcessExited(pid);
});

test("hook timeout kills the shell and its descendants", async (t) => {
  const f = fixture(t, "sleep 30 & printf '%s %s' \"$$\" \"$!\" > pids; wait");
  const started = Date.now();
  await assert.rejects(runHookCommand({ command: f.command, timeout: 0.2 }, f.input), /timed out/);
  assert.ok(Date.now() - started < 2_000);
  for (const pid of await pids(f.cwd)) await assertProcessExited(pid);
});

test("hook abort kills the shell and its descendants and removes its abort listener", async (t) => {
  const f = fixture(t, "sleep 30 & printf '%s %s' \"$$\" \"$!\" > pids; wait");
  const controller = new AbortController();
  const pending = runHookCommand({ command: f.command, timeout: 5 }, f.input, controller.signal);
  const rejection = assert.rejects(pending, /aborted/);
  const recorded = await pids(f.cwd);
  const started = Date.now();
  controller.abort(new Error("private abort reason"));
  await rejection;
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  for (const pid of recorded) await assertProcessExited(pid);
});

for (const redirect of ["", " >/dev/null 2>&1"]) {
  test(`hook cleans up background descendants after shell exit with redirect=${!!redirect}`, async (t) => {
    const f = fixture(t, `sleep 30${redirect} & printf '%s' "$!" > pids; printf '{"decision":"block"}'`);
    const started = Date.now();
    assert.deepEqual(await runHookCommand({ command: f.command, timeout: 5 }, f.input), {
      code: 0,
      stdout: '{"decision":"block"}',
      stderr: "",
    });
    assert.ok(Date.now() - started < 2_000);
    for (const pid of await pids(f.cwd)) await assertProcessExited(pid);
  });
}

test("hook rejects incomplete output if a descendant leaves the process group", async (t) => {
  const f = fixture(t, "set -m; sleep 30 & printf '%s' \"$!\" > pids; printf '{'");
  const started = Date.now();
  try {
    await assert.rejects(runHookCommand({ command: f.command, timeout: 5 }, f.input), /output did not close/);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    for (const pid of await pids(f.cwd)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await assertProcessExited(pid);
    }
  }
});

test("hook rejects a signal that was aborted before execution without starting the script", async (t) => {
  const f = fixture(t, "touch started");
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  await assert.rejects(runHookCommand({ command: f.command, timeout: 5 }, f.input, controller.signal), /aborted/);
  assert.equal(existsSync(join(f.cwd, "started")), false);
});
