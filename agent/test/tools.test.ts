import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BASH_HEAD_CHARS, BASH_TAIL_CHARS, bashTool, editTool, READ_IMAGE_MAX_BYTES, READ_IMAGE_MAX_DIMENSION, READ_MAX_BYTES, READ_MAX_LINES, readTool, writeTool } from "../src/tools.ts";
import { fauxModels, tempDir } from "./helpers.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((b) => b.text ?? "").join("");

function imageHeaders(width: number, height: number): [string, Buffer][] {
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 2;
  const gif = Buffer.alloc(13);
  gif.write("GIF89a");
  gif.writeUInt16LE(width, 6);
  gif.writeUInt16LE(height, 8);
  const sof = Buffer.alloc(13);
  sof.set([0xff, 0xc0, 0, 11, 8]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([1, 1, 0x11, 0], 9);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  const webp = (kind: string, data: Buffer) => {
    const header = Buffer.alloc(20);
    header.write("RIFF");
    header.writeUInt32LE(12 + data.length + (data.length % 2), 4);
    header.write("WEBP", 8);
    header.write(kind, 12);
    header.writeUInt32LE(data.length, 16);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
  };
  const vp8 = Buffer.alloc(10);
  vp8.set([0x9d, 0x01, 0x2a], 3);
  vp8.writeUInt16LE(width, 6);
  vp8.writeUInt16LE(height, 8);
  const vp8l = Buffer.alloc(5);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((width - 1) + ((height - 1) * 0x4000), 1);
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  return [["image/png", png], ["image/gif", gif], ["image/jpeg", jpeg], ["image/webp", webp("VP8 ", vp8)], ["image/webp", webp("VP8L", vp8l)], ["image/webp", webp("VP8X", vp8x)]];
}

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

test("read identifies image contents without relying on file extensions or text pagination", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  for (const [mimeType, bytes] of imageHeaders(320, 240)) {
    writeFileSync(join(cwd, "no-extension"), bytes);
    const result = await readTool(cwd, () => model).execute("r", { path: "no-extension", offset: 999, limit: 1 });
    assert.deepEqual(result.content[1], { type: "image", mimeType, data: bytes.toString("base64") });
  }
  writeFileSync(join(cwd, "text.png"), "still text\n");
  assert.equal(textOf(await readTool(cwd).execute("r", { path: "text.png" })), "1\tstill text");
  writeFileSync(join(cwd, "binary.jpg"), Buffer.from([1, 0, 3]));
  await assert.rejects(readTool(cwd, () => model).execute("r", { path: "binary.jpg" }), /binary/);
});

test("read bounds both image dimensions across all supported image headers", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const tool = readTool(cwd, () => model);
  for (const [width, height] of [[8000, 8000], [8001, 1], [1, 8001]] as const) {
    for (const [, bytes] of imageHeaders(width, height)) {
      writeFileSync(join(cwd, "image"), bytes);
      if (Math.max(width, height) <= READ_IMAGE_MAX_DIMENSION) {
        const result = await tool.execute("r", { path: "image" });
        assert.equal(result.content[1]?.type, "image");
      } else {
        await assert.rejects(tool.execute("r", { path: "image" }), (error: Error) => {
          assert.match(error.message, new RegExp(`${width}x${height} px.*8000 px.*Resize.*read.*copy.*sips -Z 2000`));
          return true;
        });
      }
    }
  }
});

test("read rejects image signatures without parseable nonzero dimensions", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const tool = readTool(cwd, () => model);
  const malformed = imageHeaders(1, 1).flatMap(([, bytes], index) => [bytes.subarray(0, 12), bytes.subarray(0, bytes.length - (index === 2 ? 3 : 1))]);
  for (const [index, offset] of [[0, 16], [1, 6], [2, 7]] as const) {
    const bytes = imageHeaders(1, 1)[index]![1];
    bytes.fill(0, offset, offset + (index === 0 ? 4 : 2));
    malformed.push(bytes);
  }
  const invalidPng = imageHeaders(1, 1)[0]![1];
  invalidPng.write("IDAT", 12);
  malformed.push(invalidPng);
  const invalidWebp = imageHeaders(1, 1)[3]![1];
  invalidWebp[23] = 0;
  malformed.push(invalidWebp);
  for (const bytes of malformed) {
    writeFileSync(join(cwd, "image"), bytes);
    await assert.rejects(tool.execute("r", { path: "image" }), /malformed.*header.*Re-export.*read the new copy/);
  }
});

test("read walks padded WebP chunks and respects packed dimension fields", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const path = join(cwd, "image");
  const tool = readTool(cwd, () => model);
  for (const [, image] of imageHeaders(320, 240).slice(3)) {
    const chunk = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 0, 0]);
    const bytes = Buffer.concat([image.subarray(0, 12), chunk, image.subarray(12)]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    writeFileSync(path, bytes);
    assert.equal((await tool.execute("r", { path })).content[1]?.type, "image");
    bytes.writeUInt32LE(0xffffffff, 16);
    writeFileSync(path, bytes);
    await assert.rejects(tool.execute("r", { path }), /malformed.*Re-export/);
  }
  const vp8 = imageHeaders(320, 240)[3]![1];
  vp8.writeUInt16LE(320 | 0xc000, 26);
  vp8.writeUInt16LE(240 | 0xc000, 28);
  writeFileSync(path, vp8);
  assert.equal((await tool.execute("r", { path })).content[1]?.type, "image");
  const vp8l = imageHeaders(320, 240)[4]![1];
  vp8l[24] = vp8l[24]! | 0x10;
  writeFileSync(path, vp8l);
  assert.equal((await tool.execute("r", { path })).content[1]?.type, "image");
  vp8l[24] = vp8l[24]! | 0x20;
  writeFileSync(path, vp8l);
  await assert.rejects(tool.execute("r", { path }), /malformed.*Re-export/);
});

test("read rejects VP8X heights that require all three dimension bytes", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const bytes = imageHeaders(1, 1)[5]![1];
  bytes.writeUIntLE(65536, 27, 3);
  writeFileSync(join(cwd, "image"), bytes);
  await assert.rejects(readTool(cwd, () => model).execute("r", { path: "image" }), /1x65537 px.*8000 px/);
});

test("read rejects VP8 interframes despite a keyframe start code", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const bytes = imageHeaders(320, 240)[3]![1];
  bytes[20] = bytes[20]! | 1;
  writeFileSync(join(cwd, "image"), bytes);
  await assert.rejects(readTool(cwd, () => model).execute("r", { path: "image" }), /malformed.*Re-export/);
});

test("read rejects a JPEG SOF segment too short to contain its dimensions and components", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const bytes = imageHeaders(320, 240)[2]![1];
  bytes.writeUInt16BE(7, 4);
  writeFileSync(join(cwd, "image"), bytes);
  await assert.rejects(readTool(cwd, () => model).execute("r", { path: "image" }), /malformed.*Re-export/);
});

test("read walks JPEG segments, fill bytes, and standalone markers to the first SOFn", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  const path = join(cwd, "image");
  const tool = readTool(cwd, () => model);
  const prefix = Buffer.from([0xff, 0xd8, 0xff, 0xff, 0x01, 0xff, 0xd0, 0xff, 0xe1, 0, 5, 0xff, 0xc0, 0, 0xff, 0xc4, 0, 2, 0xff, 0xc8, 0, 2, 0xff, 0xcc, 0, 2]);
  for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    for (const width of [320, 8001]) {
      const jpeg = imageHeaders(width, 240)[2]![1];
      jpeg[3] = marker;
      const bytes = Buffer.concat([prefix, Buffer.from([0xff]), jpeg.subarray(2)]);
      writeFileSync(path, bytes);
      if (width === 320) assert.equal((await tool.execute("r", { path })).content[1]?.type, "image");
      else await assert.rejects(tool.execute("r", { path }), /8001x240 px.*8000 px/);
    }
  }
  for (const suffix of [[0xff], [0xff, 0xe1, 0], [0xff, 0xe1, 0, 1], [0xff, 0xe1, 0xff, 0xff], [0xff, 0xda, 0, 2], [0xff, 0xd9], [0xff, 0x00]]) {
    writeFileSync(path, Buffer.concat([prefix, Buffer.from(suffix)]));
    await assert.rejects(tool.execute("r", { path }), /malformed.*Re-export/);
  }
});

test("read checks the model at execution time and bounds image data before returning it", async () => {
  const cwd = tempDir();
  const { model } = fauxModels();
  let selected = { ...model, input: ["text"] as typeof model.input };
  const tool = readTool(cwd, () => selected);
  const bytes = Buffer.alloc(READ_IMAGE_MAX_BYTES);
  imageHeaders(1, 1)[1]![1].copy(bytes);
  writeFileSync(join(cwd, "image"), bytes);
  await assert.rejects(tool.execute("r", { path: "image" }), /does not support image input.*Select a model/);
  selected = model;
  const result = await tool.execute("r", { path: "image" });
  const image = result.content.find((block) => block.type === "image");
  assert.ok(image?.type === "image");
  assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
  writeFileSync(join(cwd, "image"), Buffer.concat([bytes, Buffer.from([0])]));
  await assert.rejects(tool.execute("r", { path: "image" }), /3 MiB.*Resize or crop/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(tool.execute("r", { path: "image" }, abort.signal), { name: "AbortError" });
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
