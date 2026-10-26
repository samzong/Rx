import { isAbsolute, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { isHookContext } from "./hooks.ts";
import type { Origin } from "./session-log.ts";

type Update = acp.SessionUpdate;

const TOOL_KINDS: Record<string, acp.ToolKind> = { read: "read", write: "edit", edit: "edit", bash: "execute" };

function toolTitle(name: string, args: unknown): string {
  const input = (args ?? {}) as Record<string, unknown>;
  const detail = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : "";
  const line = detail.split("\n")[0] ?? "";
  return line ? `${name}: ${line.length > 120 ? `${line.slice(0, 117)}...` : line}` : name;
}

function toolLocations(cwd: string, args: unknown): acp.ToolCallLocation[] | undefined {
  const path = (args as Record<string, unknown> | undefined)?.path;
  if (typeof path !== "string") return undefined;
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }];
}

function resultContent(content: unknown): acp.ToolCallContent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): acp.ToolCallContent[] => {
    if (block?.type === "text") return [{ type: "content", content: { type: "text", text: block.text } }];
    if (block?.type === "image") return [{ type: "content", content: { type: "image", data: block.data, mimeType: block.mimeType } }];
    return [];
  });
}

function toolCallStart(cwd: string, id: string, name: string, args: unknown, status: acp.ToolCallStatus): Update {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: toolTitle(name, args),
    kind: TOOL_KINDS[name] ?? "other",
    status,
    rawInput: args,
    locations: toolLocations(cwd, args),
  };
}

export function toolInputUpdate(cwd: string, id: string, name: string, args: Record<string, unknown>): Update {
  return { sessionUpdate: "tool_call_update", toolCallId: id, title: toolTitle(name, args), rawInput: args, locations: toolLocations(cwd, args) };
}

function toolCallEnd(id: string, isError: boolean, content: unknown): Update {
  return { sessionUpdate: "tool_call_update", toolCallId: id, status: isError ? "failed" : "completed", content: resultContent(content) };
}

export function historyUpdates(cwd: string, messages: AgentMessage[], origins?: Origin[], inputs?: ReadonlyMap<string, Record<string, unknown>>): Update[] {
  const updates: Update[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      for (const block of blocks) {
        updates.push({
          sessionUpdate: origins?.[index] === "rx" ? "agent_message_chunk" : "user_message_chunk",
          content: block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType },
        });
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text) updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
        else if (block.type === "thinking" && block.thinking) updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
        else if (block.type === "toolCall") {
          updates.push(toolCallStart(cwd, block.id, block.name, inputs?.get(block.id) ?? block.arguments, message.stopReason === "toolUse" ? "pending" : "failed"));
        }
      }
      if (message.stopReason === "error" && message.errorMessage) {
        updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n[model error: ${message.errorMessage}]` } });
      }
    } else if (message.role === "toolResult") {
      updates.push(toolCallEnd(message.toolCallId, message.isError, message.content));
    }
  }
  return updates;
}

export function eventUpdates(cwd: string, event: AgentEvent): Update[] {
  if (event.type === "message_end" && isHookContext(event.message)) return historyUpdates(cwd, [event.message], ["rx"]);
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner.type === "text_delta") return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } }];
    if (inner.type === "thinking_delta") return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.delta } }];
    return [];
  }
  if (event.type === "tool_execution_start") return [toolCallStart(cwd, event.toolCallId, event.toolName, event.args, "in_progress")];
  if (event.type === "tool_execution_end") return [toolCallEnd(event.toolCallId, event.isError, event.result?.content)];
  if (event.type === "tool_execution_update") return [{ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: "in_progress", content: resultContent(event.partialResult.content) }];
  return [];
}

export function promptInput(blocks: acp.ContentBlock[]): { text: string; images: ImageContent[] } {
  const parts: string[] = [];
  const images: ImageContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.type === "resource_link") parts.push(`[${block.name}](${block.uri})`);
    else if (block.type === "resource") {
      const resource = block.resource;
      if ("text" in resource) parts.push(`<resource uri="${resource.uri}">\n${resource.text}\n</resource>`);
      else parts.push(`[binary resource ${resource.uri} omitted]`);
    } else throw acp.RequestError.invalidParams(undefined, `unsupported prompt content: ${block.type}`);
  }
  return { text: parts.join("\n\n"), images };
}
