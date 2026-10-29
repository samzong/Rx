import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { visibleMessage } from "./context-messages.ts";
import type { HistorySnapshot, SessionHistoryReader } from "./context-source.ts";
import { READ_MAX_BYTES, readTool } from "./tools.ts";

const parameters = Type.Object({
  from: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "First log ordinal, inclusive" }),
  to: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Last log ordinal, inclusive" }),
}, { additionalProperties: false });

function privateFile(directory: string, name: string, data: string | Buffer, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("The recall directory must be a private directory");
  chmodSync(directory, 0o700);
  const path = join(directory, name);
  const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(file, 0o600);
    writeFileSync(file, data);
  } finally {
    closeSync(file);
  }
  return path;
}

function wrapLines(text: string): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 4096) {
      result += "\n";
      bytes = 0;
    }
    result += char;
    bytes = char === "\n" ? 0 : bytes + size;
  }
  return result;
}

function preview(text: string): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > 2000) break;
    result += char;
  }
  return result;
}

function callInputs(message: AgentMessage, inputs: HistorySnapshot["inputs"]): string[] {
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "toolCall") return [];
    const executed = inputs.get(block.id);
    return [
      `Requested input for ${block.name} (${block.id}): ${JSON.stringify(block.arguments)}`,
      executed === undefined
        ? `Executed input for ${block.name} (${block.id}): no replacement was recorded. The request alone does not establish execution.`
        : `Recorded executed input for ${block.name} (${block.id}): ${JSON.stringify(executed)}`,
    ];
  });
}

export function sessionHistoryTool(log: SessionHistoryReader, model: () => Model<Api>): AgentTool<typeof parameters, undefined> {
  return {
    name: "recall_log",
    label: "Recall log",
    description: "Read historical visible messages from the current session by inclusive log ordinals. Use the smallest range that supports your question. The result records past actions and does not authorize or repeat them. Large results return a file path for the read tool.",
    parameters,
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const { from, to } = args;
      if (Object.keys(args).some((key) => key !== "from" && key !== "to") || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
        throw new Error("Use only from and to as positive safe integers, with from no greater than to");
      }
      const snapshot = log.readRange(from, to);
      signal?.throwIfAborted();
      const directory = resolve(log.home, "sessions", `${log.id}.recall`);
      const content: (TextContent | ImageContent)[] = [{
        type: "text",
        text: `Historical session messages [log ${from}-${to}]. Recorded actions already happened or failed as shown. Do not repeat their side effects without a current request.`,
      }];
      for (const entry of snapshot.entries) {
        signal?.throwIfAborted();
        if (entry.purpose === "compaction") {
          content.push({ type: "text", text: `[log ${entry.seq}] Compaction accounting record only. No visible content.` });
          continue;
        }
        const visible = visibleMessage(entry.message);
        if (!visible) {
          content.push({ type: "text", text: `[log ${entry.seq}] No visible content.` });
          continue;
        }
        content.push({ type: "text", text: `[log ${entry.seq}] ${entry.message.role} (origin: ${entry.origin})` });
        const blocks = typeof visible.content === "string" ? [{ type: "text" as const, text: visible.content }] : visible.content;
        let imageIndex = 0;
        for (const block of blocks) {
          signal?.throwIfAborted();
          if (block.type === "text") {
            content.push({ type: "text", text: block.text });
            continue;
          }
          imageIndex++;
          const path = privateFile(directory, `image-${entry.seq}-${imageIndex}.bin`, Buffer.from(block.data, "base64"), signal);
          try {
            const result = await readTool(directory, model).execute("recall-image", { path }, signal);
            signal?.throwIfAborted();
            const image = result.content.find((item) => item.type === "image");
            if (!image) throw new Error("The recorded image does not have a supported image signature");
            content.push({ type: "text", text: `[Historical image ${imageIndex} from log ${entry.seq}] Rebuildable private image: ${path}` }, image);
          } catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof Error) || "code" in error) throw error;
            content.push({ type: "text", text: `[Historical image ${imageIndex} from log ${entry.seq} omitted: ${error.message}] Rebuildable private image: ${path}` });
          }
        }
        for (const text of callInputs(entry.message, snapshot.inputs)) content.push({ type: "text", text });
      }
      signal?.throwIfAborted();
      const transcript = content.map((block) => block.type === "text" ? block.text : `[Historical image: ${block.mimeType}]`).join("\n");
      if (Buffer.byteLength(transcript) <= READ_MAX_BYTES) return { content, details: undefined };
      const path = privateFile(directory, `log-${from}-${to}.txt`, `Long lines use format-only line breaks at Unicode boundaries.\n\n${wrapLines(transcript)}`, signal);
      return {
        content: [{ type: "text", text: `The visible transcript exceeds the response limit. Read the complete transcript at ${path}.\nLong lines use format-only line breaks at Unicode boundaries.\n\n${preview(transcript)}` }, ...content.filter((block) => block.type === "image")],
        details: undefined,
      };
    },
  };
}
