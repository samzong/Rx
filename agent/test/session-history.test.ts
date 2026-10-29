import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { HistoryRecord, SessionHistoryReader } from "../src/context-source.ts";
import { sessionHistoryTool } from "../src/session-history.ts";
import { READ_IMAGE_MAX_BYTES, READ_MAX_BYTES, readTool } from "../src/tools.ts";
import { fauxModels, tempDir } from "./helpers.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-responses", provider: "fixture", model: "fixture",
  usage: { input: 123, output: 321, cacheRead: 456, cacheWrite: 654, totalTokens: 1564, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 2,
});

function fixture(messages: AgentMessage[], inputs = new Map<string, Record<string, unknown>>()) {
  const home = tempDir("rx-history-");
  const entries: HistoryRecord[] = messages.map((message, index) => ({ seq: index + 1, origin: message.role === "user" ? "acp" : message.role === "toolResult" ? "tool" : "model", message }));
  const ranges: number[][] = [];
  const reader: SessionHistoryReader = {
    home, id: "current-session",
    readRange(from, to) {
      ranges.push([from, to]);
      if (to > entries.length) throw new Error("fixture range exceeds committed message count");
      return { entries: entries.slice(from - 1, to), inputs };
    },
  };
  const { model } = fauxModels();
  return { home, entries, ranges, reader, model, tool: sessionHistoryTool(reader, () => model), directory: join(home, "sessions", `${reader.id}.recall`) };
}

function png(width = 320, height = 240): ImageContent {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
}

test("recall reads inclusive current-session ordinals without writing small text", async () => {
  const f = fixture([user("first"), user("  原文\r\n😀\tlast  "), user("third")]);
  const result = await f.tool.execute("recall", { from: 2, to: 2 });
  assert.deepEqual(f.ranges, [[2, 2]]);
  assert.match(textOf(result), /\[log 2\] user \(origin: acp\)/);
  assert.ok(result.content.some((block) => block.type === "text" && block.text === "  原文\r\n😀\tlast  "));
  assert.doesNotMatch(textOf(result), /first|third/);
  assert.equal(existsSync(f.directory), false);
  await f.tool.execute("recall", { from: 1, to: 3 });
  assert.deepEqual(f.ranges.at(-1), [1, 3]);
});

test("recall rejects invalid bounds and extra selectors before consulting the reader", async () => {
  const f = fixture([user("original")]);
  const invalid = [
    { from: 0, to: 1 }, { from: 2, to: 1 }, { from: 1.5, to: 2 },
    { from: 1, to: Infinity }, { from: 1, to: Number.MAX_SAFE_INTEGER + 1 },
    { from: 1, to: 1, sessionId: "other" }, { from: 1, to: 1, path: "/other" },
  ];
  for (const args of invalid) await assert.rejects(f.tool.execute("recall", args), /positive safe integers/);
  assert.equal(f.ranges.length, 0);
  await assert.rejects(f.tool.execute("recall", { from: 1, to: 2 }), /fixture range exceeds committed message count/);
  const failure = new Error("corrupt terminated record");
  const broken = sessionHistoryTool({ ...f.reader, readRange() { throw failure; } }, () => f.model);
  await assert.rejects(broken.execute("recall", { from: 1, to: 1 }), (error) => error === failure);
});

test("recall exposes visible evidence, tool identity, errors, and separate requested and executed inputs", async () => {
  const request = assistant([
    { type: "thinking", thinking: "hidden reasoning", thinkingSignature: "hidden-thinking-signature" },
    { type: "text", text: "visible answer", textSignature: "hidden-text-signature" },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "requested command" } },
    { type: "toolCall", id: "call-2", name: "read", arguments: { path: "requested path" } },
  ]);
  request.stopReason = "error";
  request.errorMessage = "recorded failure";
  const f = fixture([
    { role: "system", content: "hidden system", timestamp: 0 },
    request,
    { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "original tool error" }], timestamp: 3 },
    assistant([{ type: "text", text: "hidden accounting content" }]),
  ], new Map([["call-1", { command: "executed command" }]]));
  f.entries[3]!.purpose = "compaction";
  const result = await f.tool.execute("recall", { from: 1, to: 4 });
  const text = textOf(result);
  assert.match(text, /visible answer/);
  assert.match(text, /Recorded error: recorded failure/);
  assert.match(text, /Recorded tool result bash \(call-1\), error/);
  assert.match(text, /original tool error/);
  assert.match(text, /Requested input for bash \(call-1\): \{"command":"requested command"\}/);
  assert.match(text, /Recorded executed input for bash \(call-1\): \{"command":"executed command"\}/);
  assert.match(text, /Executed input for read \(call-2\): no replacement was recorded/);
  assert.match(text, /\[log 4\] Compaction accounting record only. No visible content/);
  assert.doesNotMatch(text, /hidden|cacheRead|totalTokens|"input":123/);
  assert.ok(result.content.every((block) => block.type === "text" || block.type === "image"));
});

test("long Unicode messages remain complete through actual read pagination and regenerate private attachments", async () => {
  const original = "始😀é𠮷abc终".repeat(12000);
  const f = fixture([user(original)]);
  const result = await f.tool.execute("recall", { from: 1, to: 1 });
  const path = join(f.directory, "log-1-1.txt");
  assert.match(textOf(result), /format-only line breaks at Unicode boundaries/);
  assert.ok(textOf(result).includes(path));
  assert.ok(Buffer.byteLength(textOf(result)) < READ_MAX_BYTES);
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /�/);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const read = readTool(f.home);
  const recovered: string[] = [];
  let offset = 1;
  for (;;) {
    const page = textOf(await read.execute("page", { path, offset, limit: 5 }));
    for (const line of page.split("\n")) {
      if (/^\d+\t/.test(line)) recovered.push(line.replace(/^\d+\t/, ""));
    }
    const next = /continue with offset (\d+)/.exec(page);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.equal(recovered.join("\n"), raw);
  assert.equal(recovered.slice(4).join(""), original);
  rmSync(path);
  await f.tool.execute("recall", { from: 1, to: 1 });
  assert.equal(readFileSync(path, "utf8"), raw);
});

test("recall returns logged images after their original source disappears", async () => {
  const image = png();
  const f = fixture([{ role: "toolResult", toolName: "read", toolCallId: "image-call", isError: false, content: [image], timestamp: 1 }]);
  const original = join(f.home, "original.png");
  writeFileSync(original, Buffer.from(image.data, "base64"));
  rmSync(original);
  const result = await f.tool.execute("recall", { from: 1, to: 1 });
  assert.deepEqual(result.content.find((block) => block.type === "image"), image);
  assert.match(textOf(result), /Recorded tool result read \(image-call\), success/);
  rmSync(f.directory, { recursive: true });
  assert.deepEqual((await f.tool.execute("recall", { from: 1, to: 1 })).content.find((block) => block.type === "image"), image);
});

test("recall preserves unsupported, oversized, and malformed images as private rebuildable files", async () => {
  const large = png();
  large.data = Buffer.concat([Buffer.from(large.data, "base64"), Buffer.alloc(READ_IMAGE_MAX_BYTES)]).toString("base64");
  const f = fixture([{ role: "user", content: [png(), png(8001, 1), large, { type: "image", mimeType: "image/png", data: Buffer.from("bad signature").toString("base64") }], timestamp: 1 }]);
  const textOnly = { ...f.model, input: ["text" as const] };
  const unsupported = sessionHistoryTool(f.reader, () => textOnly);
  const result = await unsupported.execute("recall", { from: 1, to: 1 });
  assert.equal(result.content.some((block) => block.type === "image"), false);
  assert.match(textOf(result), /does not support image input/);
  for (const file of readdirSync(f.directory)) assert.equal(statSync(join(f.directory, file)).mode & 0o777, 0o600);
  const path = join(f.directory, "image-1-1.bin");
  assert.deepEqual(readFileSync(path), Buffer.from(png().data, "base64"));
  rmSync(path);
  await unsupported.execute("recall", { from: 1, to: 1 });
  assert.deepEqual(readFileSync(path), Buffer.from(png().data, "base64"));
  const supported = await f.tool.execute("recall", { from: 1, to: 1 });
  assert.equal(supported.content.filter((block) => block.type === "image").length, 1);
  assert.match(textOf(supported), /8001x1 px/);
  assert.match(textOf(supported), /3 MiB limit/);
  assert.match(textOf(supported), /supported image signature/);
});

test("cancellation before execution or after snapshot reads creates no attachments", async () => {
  const f = fixture([{ role: "user", content: [{ type: "text", text: "long".repeat(20000) }, png()], timestamp: 1 }]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.tool.execute("recall", { from: 1, to: 1 }, abort.signal), { name: "AbortError" });
  assert.equal(f.ranges.length, 0);
  assert.equal(existsSync(f.directory), false);
  const during = new AbortController();
  const tool = sessionHistoryTool({ ...f.reader, readRange(from, to) { const snapshot = f.reader.readRange(from, to); during.abort(); return snapshot; } }, () => f.model);
  await assert.rejects(tool.execute("recall", { from: 1, to: 1 }, during.signal), { name: "AbortError" });
  assert.equal(existsSync(f.directory), false);
});

test("attachment overwrites restore private modes and reject symlinks without changing their targets", async () => {
  const f = fixture([user("large".repeat(20000))]);
  await f.tool.execute("recall", { from: 1, to: 1 });
  const path = join(f.directory, "log-1-1.txt");
  chmodSync(f.directory, 0o755);
  chmodSync(path, 0o644);
  await f.tool.execute("recall", { from: 1, to: 1 });
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const target = join(f.home, "authoritative-source");
  writeFileSync(target, "preserve source");
  rmSync(path);
  symlinkSync(target, path);
  await assert.rejects(f.tool.execute("recall", { from: 1, to: 1 }), { code: "ELOOP" });
  assert.equal(readFileSync(target, "utf8"), "preserve source");
  rmSync(f.directory, { recursive: true });
  const other = tempDir();
  symlinkSync(other, f.directory);
  await assert.rejects(f.tool.execute("recall", { from: 1, to: 1 }), /private directory/);
  assert.deepEqual(readdirSync(other), []);
});
