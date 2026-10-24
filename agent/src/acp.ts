import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Models } from "@earendil-works/pi-ai";
import { createRxAgent, systemPrompt } from "./agent.ts";
import type { ModelChoice } from "./models.ts";
import { listSessions, readSessionHeader, SessionLog } from "./session-log.ts";
import { VERSION } from "./version.ts";

export interface AcpOptions {
  home: string;
  models: Models;
  choose: () => Promise<ModelChoice>;
}

interface LiveSession {
  agent: Agent;
  log: SessionLog;
  running: boolean;
  cancelled: boolean;
}

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

function toolCallEnd(id: string, isError: boolean, content: unknown): Update {
  return { sessionUpdate: "tool_call_update", toolCallId: id, status: isError ? "failed" : "completed", content: resultContent(content) };
}

export function historyUpdates(cwd: string, messages: AgentMessage[]): Update[] {
  const updates: Update[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      for (const block of blocks) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          content: block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType },
        });
      }
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text) updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
        else if (block.type === "thinking" && block.thinking) updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
        else if (block.type === "toolCall") {
          updates.push(toolCallStart(cwd, block.id, block.name, block.arguments, message.stopReason === "toolUse" ? "pending" : "failed"));
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
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner.type === "text_delta") return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } }];
    if (inner.type === "thinking_delta") return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: inner.delta } }];
    return [];
  }
  if (event.type === "tool_execution_start") return [toolCallStart(cwd, event.toolCallId, event.toolName, event.args, "in_progress")];
  if (event.type === "tool_execution_end") return [toolCallEnd(event.toolCallId, event.isError, event.result?.content)];
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

function stopReason(messages: AgentMessage[], cancelled: boolean): acp.StopReason {
  if (cancelled) return "cancelled";
  const last = messages.findLast((m) => m.role === "assistant");
  if (last?.role !== "assistant") return "end_turn";
  if (last.stopReason === "aborted") return "cancelled";
  if (last.stopReason === "length") return "max_tokens";
  if (last.stopReason === "error") throw acp.RequestError.internalError(undefined, last.errorMessage ?? "model request failed");
  return "end_turn";
}

export function createAcpApp(options: AcpOptions, sessions = new Map<string, LiveSession>()): acp.AgentApp {

  const open = async (cwd: string, start: () => { log: SessionLog; messages: AgentMessage[] }, requireCwd = false): Promise<{ live: LiveSession; messages: AgentMessage[] }> => {
    let choice: ModelChoice;
    let prompt: string;
    try {
      choice = await options.choose();
      if (requireCwd) realpathSync(cwd);
      prompt = systemPrompt(cwd);
    } catch (error) {
      throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    }
    const { log, messages } = start();
    const agent = createRxAgent({ ...choice, models: options.models, cwd: log.cwd, systemPrompt: prompt, log, origin: "acp", messages });
    const live = { agent, log, running: false, cancelled: false };
    sessions.set(log.id, live);
    return { live, messages };
  };

  const get = (sessionId: string): LiveSession => {
    const live = sessions.get(sessionId);
    if (!live) throw acp.RequestError.resourceNotFound(sessionId);
    return live;
  };

  return acp
    .agent({ name: "rx" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {} },
      },
      authMethods: [],
      agentInfo: { name: "rx", title: "Rx", version: VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const { live } = await open(params.cwd, () => ({ log: SessionLog.create(options.home, params.cwd), messages: [] }), true);
      return { sessionId: live.log.id };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      const { cwd } = readSessionHeader(options.home, params.sessionId);
      if (cwd !== params.cwd) throw acp.RequestError.invalidParams(undefined, `session ${params.sessionId} belongs to ${cwd}, not ${params.cwd}`);
      const { messages } = await open(cwd, () => {
        if (sessions.get(params.sessionId)?.running) throw acp.RequestError.invalidRequest(undefined, "session is running");
        return SessionLog.open(options.home, params.sessionId);
      });
      for (const update of historyUpdates(cwd, messages)) {
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
      }
      return {};
    })
    .onRequest(acp.methods.agent.session.list, ({ params }) => ({
      sessions: listSessions(options.home, params.cwd ?? undefined).map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
      const live = get(params.sessionId);
      if (live.running) throw acp.RequestError.invalidRequest(undefined, "session is already running a prompt");
      const { text, images } = promptInput(params.prompt);
      let pending = Promise.resolve();
      const unsubscribe = live.agent.subscribe((event) => {
        for (const update of eventUpdates(live.log.cwd, event)) {
          pending = pending
            .then(() => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }))
            .catch(() => live.agent.abort());
        }
        return pending;
      });
      const onClose = () => live.agent.abort();
      signal.addEventListener("abort", onClose, { once: true });
      live.running = true;
      live.cancelled = false;
      try {
        await live.agent.prompt(text, images);
      } finally {
        live.running = false;
        signal.removeEventListener("abort", onClose);
        unsubscribe();
        await pending;
      }
      return { stopReason: stopReason(live.agent.state.messages, live.cancelled) };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const live = sessions.get(params.sessionId);
      if (!live?.running) return;
      live.cancelled = true;
      live.agent.abort();
    });
}

export function serveAcp(options: AcpOptions): { closed: Promise<void>; stop: () => Promise<void> } {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const sessions = new Map<string, LiveSession>();
  const connection = createAcpApp(options, sessions).connect(acp.ndJsonStream(output, input));
  const closed = connection.closed.then(async () => {
    await Promise.all([...sessions.values()].map((live) => live.agent.waitForIdle()));
  });
  return {
    closed,
    stop: () => {
      connection.close();
      return closed;
    },
  };
}
