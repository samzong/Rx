import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bashTool, editTool } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((b) => b.text ?? "").join("");

test("edit requires a unique exact match unless replace_all", async () => {
  const cwd = tempDir();
  const file = join(cwd, "f.ts");
  writeFileSync(file, "a = 1\nb = 1\n$& here\n");
  await assert.rejects(editTool(cwd).execute("1", { path: "f.ts", old_text: "missing", new_text: "x" }));
  await assert.rejects(editTool(cwd).execute("1", { path: "f.ts", old_text: "= 1", new_text: "= 2" }));
  await editTool(cwd).execute("1", { path: "f.ts", old_text: "$& here", new_text: "$1 there" });
  await editTool(cwd).execute("1", { path: "f.ts", old_text: "= 1", new_text: "= 2", replace_all: true });
  assert.equal(readFileSync(file, "utf8"), "a = 2\nb = 2\n$1 there\n");
});

test("bash timeout and abort kill the whole process group", async () => {
  const cwd = tempDir();
  await assert.rejects(bashTool(cwd).execute("1", { command: "sleep 5", timeout: 1 }));
  const controller = new AbortController();
  const pending = bashTool(cwd).execute("1", { command: "sleep 30 & echo $! > child.pid; wait" }, controller.signal);
  while (!existsSync(join(cwd, "child.pid")) || !readFileSync(join(cwd, "child.pid"), "utf8").trim()) await delay(20);
  controller.abort();
  await assert.rejects(pending);
  const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
  await delay(100);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("bash returns when the shell exits even if a background process keeps its output open", async () => {
  const cwd = tempDir();
  const started = Date.now();
  const out = textOf(await bashTool(cwd).execute("1", { command: "sleep 30 & echo $! > bg.pid; echo hi", timeout: 10 }));
  assert.match(out, /^hi\n/);
  assert.ok(Date.now() - started < 2_000);
  process.kill(Number(readFileSync(join(cwd, "bg.pid"), "utf8")), "SIGKILL");
});

test("abort returns even if a child left the process group", async () => {
  const cwd = tempDir();
  const controller = new AbortController();
  const pending = bashTool(cwd).execute("1", { command: "set -m; sleep 30 & echo $! > escaped.pid; wait" }, controller.signal);
  while (!existsSync(join(cwd, "escaped.pid")) || !readFileSync(join(cwd, "escaped.pid"), "utf8").trim()) await delay(20);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending);
  assert.ok(Date.now() - started < 2_000);
  process.kill(Number(readFileSync(join(cwd, "escaped.pid"), "utf8")), "SIGKILL");
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
