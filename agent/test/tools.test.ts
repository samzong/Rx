import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BASH_HEAD_CHARS, BASH_TAIL_CHARS, bashTool, editTool, READ_MAX_BYTES, READ_MAX_LINES, readTool, writeTool } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((b) => b.text ?? "").join("");

test("read numbers lines and pages with offset and limit", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
  assert.equal(textOf(await readTool(cwd).execute("1", { path: "a.txt" })), "1\tone\n2\ttwo\n3\tthree");
  assert.equal(
    textOf(await readTool(cwd).execute("1", { path: "a.txt", offset: 2, limit: 1 })),
    "2\ttwo\n[showing lines 2-2 of 3; continue with offset 3]",
  );
  await assert.rejects(readTool(cwd).execute("1", { path: "a.txt", offset: 9 }), /past the end/);
});

test("read caps output at the line limit and rejects binary files", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "big.txt"), Array.from({ length: READ_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n"));
  const out = textOf(await readTool(cwd).execute("1", { path: "big.txt" }));
  assert.match(out, new RegExp(`\\[showing lines 1-${READ_MAX_LINES} of ${READ_MAX_LINES + 10}; continue with offset ${READ_MAX_LINES + 1}\\]$`));
  writeFileSync(join(cwd, "bin"), Buffer.from([0x50, 0, 0x51]));
  await assert.rejects(readTool(cwd).execute("1", { path: "bin" }), /binary/);
});

test("read truncates a single line longer than the byte limit", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "min.js"), `${"x".repeat(READ_MAX_BYTES * 3)}\nnext\n`);
  const out = textOf(await readTool(cwd).execute("1", { path: "min.js" }));
  assert.ok(Buffer.byteLength(out) < READ_MAX_BYTES + 200);
  assert.match(out, new RegExp(`\\[line 1 truncated at ${READ_MAX_BYTES} bytes; .*\\]\\n\\[showing lines 1-1 of 2; continue with offset 2\\]$`));
});

test("write creates parent directories", async () => {
  const cwd = tempDir();
  await writeTool(cwd).execute("1", { path: "x/y/z.txt", content: "hi" });
  assert.equal(readFileSync(join(cwd, "x/y/z.txt"), "utf8"), "hi");
});

test("edit requires a unique exact match unless replace_all", async () => {
  const cwd = tempDir();
  const file = join(cwd, "f.ts");
  writeFileSync(file, "a = 1\nb = 1\n$& here\n");
  await assert.rejects(editTool(cwd).execute("1", { path: "f.ts", old_text: "missing", new_text: "x" }), /not found/);
  await assert.rejects(editTool(cwd).execute("1", { path: "f.ts", old_text: "= 1", new_text: "= 2" }), /matches 2 times/);
  await editTool(cwd).execute("1", { path: "f.ts", old_text: "$& here", new_text: "$1 there" });
  await editTool(cwd).execute("1", { path: "f.ts", old_text: "= 1", new_text: "= 2", replace_all: true });
  assert.equal(readFileSync(file, "utf8"), "a = 2\nb = 2\n$1 there\n");
});

test("bash returns output and exit status from the working directory", async () => {
  const cwd = tempDir();
  assert.equal(textOf(await bashTool(cwd).execute("1", { command: "pwd -P; echo err >&2" })), `${realpathSync(cwd)}\nerr\n[exit code 0]`);
  await assert.rejects(bashTool(cwd).execute("1", { command: "echo no; exit 3" }), /no\n\[exit code 3\]/);
});

test("bash keeps the head and tail of long output", async () => {
  const cwd = tempDir();
  const total = BASH_HEAD_CHARS + BASH_TAIL_CHARS + 997;
  const out = textOf(await bashTool(cwd).execute("1", { command: `head -c ${total} /dev/zero | tr '\\0' a; printf END` }));
  assert.match(out, /\[\.\.\. 1000 characters omitted \.\.\.\]/);
  assert.match(out, /aEND\n\[exit code 0\]$/);
});

test("bash timeout and abort kill the whole process group", async () => {
  const cwd = tempDir();
  await assert.rejects(bashTool(cwd).execute("1", { command: "sleep 5", timeout: 1 }), /timed out after 1s/);
  const controller = new AbortController();
  const pending = bashTool(cwd).execute("1", { command: "sleep 30 & echo $! > child.pid; wait" }, controller.signal);
  while (!existsSync(join(cwd, "child.pid")) || !readFileSync(join(cwd, "child.pid"), "utf8").trim()) await delay(20);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
  await delay(100);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("bash returns when the shell exits even if a background process keeps its output open", async () => {
  const cwd = tempDir();
  const started = Date.now();
  const out = textOf(await bashTool(cwd).execute("1", { command: "sleep 30 & echo $! > bg.pid; echo hi", timeout: 10 }));
  assert.equal(out, "hi\n[exit code 0]");
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
  await assert.rejects(pending, /aborted/);
  assert.ok(Date.now() - started < 2_000);
  process.kill(Number(readFileSync(join(cwd, "escaped.pid"), "utf8")), "SIGKILL");
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
