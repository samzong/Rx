import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ImageContent, type Models } from "@earendil-works/pi-ai";
import { createRxAgent, systemPrompt } from "./agent.ts";
import { formatModel, type ModelChoice } from "./models.ts";
import { sessionConfigOptions, changeSessionConfig } from "./acp-config.ts";
import { supportsFast } from "./acp-fast.ts";
import type { AcpSelection } from "./acp-state.ts";
import { latestUsageUpdate, usageUpdate } from "./acp-usage.ts";
import { listSessions, readSessionHeader, SessionLog } from "./session-log.ts";
import { VERSION } from "./version.ts";
import { contextControl, type CompactionEvent } from "./context-control.ts";

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
  configuring: boolean;
  selection: AcpSelection;
}

type Update = acp.SessionUpdate;

const COMMANDS: acp.AvailableCommand[] = [{ name: "compact", description: "Compact the conversation context" }];

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

function compactionUpdate(event: CompactionEvent, supported: boolean, cancelled: boolean): Update {
  if (supported) {
    return {
      sessionUpdate: "compaction_update",
      compactionId: event.id,
      status: event.status === "failed" && cancelled ? "cancelled" : event.status,
      ...(event.status === "failed" && event.message ? { error: event.message } : {}),
    };
  }
  return {
    sessionUpdate: event.status === "in_progress" ? "tool_call" : "tool_call_update",
    toolCallId: event.id,
    title: event.status === "in_progress" ? "Compacting context" : event.status === "completed" ? "Context compacted" : "Context compaction failed",
    kind: "other",
    status: event.status,
    ...(event.message ? { content: [{ type: "content", content: { type: "text", text: event.message } }] } : {}),
    _meta: { lody: { activity: { version: 1, kind: "context_compaction" } } },
  };
}

export function createAcpApp(options: AcpOptions, sessions = new Map<string, LiveSession>()): acp.AgentApp {
  let booleanSupported = false;
  let compactionSupported = false;

  const snapshot = async (selection: AcpSelection) => {
    const configOptions = await sessionConfigOptions(options.models, selection, supportsFast, booleanSupported);
    const modelOption = configOptions.find((option) => option.category === "model");
    const entries = modelOption?.type === "select" ? modelOption.options.flatMap((option) => "value" in option ? [option] : option.options) : [];
    const models = Object.fromEntries(entries.flatMap(({ value }) => {
      const slash = value.indexOf("/");
      const model = value === formatModel(selection.model) ? selection.model : options.models.getModel(value.slice(0, slash), value.slice(slash + 1));
      return model ? [[value, { effortValues: getSupportedThinkingLevels(model), fastMode: supportsFast(model) }]] : [];
    }));
    return { configOptions, _meta: { lody: { modelCapabilities: { version: 1, sourceVersion: "pi-ai/1.4.0;codex/0.163.0", models } } } };
  };

  const reportUnsupportedMcp = (servers: acp.McpServer[]) => {
    if (servers.length) process.stderr.write("rx-agent: MCP servers are not supported and will not be connected\n");
  };

  const open = async (cwd: string, start: () => { log: SessionLog; messages: AgentMessage[]; history?: AgentMessage[]; usageMessages?: AgentMessage[] }, requireCwd = false): Promise<{ live: LiveSession; history: AgentMessage[]; usageMessages: AgentMessage[]; configuration: Awaited<ReturnType<typeof snapshot>> }> => {
    let choice: ModelChoice;
    let prompt: string;
    try {
      choice = await options.choose();
      if (requireCwd) realpathSync(cwd);
      prompt = systemPrompt(cwd);
    } catch (error) {
      throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    }
    const selection: AcpSelection = { ...choice, fast: false };
    const supported = getSupportedThinkingLevels(selection.model);
    if (!supported.length) throw acp.RequestError.invalidParams(undefined, "model has no supported thinking levels");
    if (!supported.includes(selection.thinking)) selection.thinking = supported[0]!;
    const configuration = await snapshot(selection);
    const { log, messages, history = messages, usageMessages = messages } = start();
    const agent = createRxAgent({ ...selection, models: options.models, cwd: log.cwd, systemPrompt: prompt, log, origin: "acp", messages, fast: () => live.selection.fast });
    const live: LiveSession = { agent, log, selection, running: false, cancelled: false, configuring: false };
    sessions.set(log.id, live);
    return { live, history, usageMessages, configuration };
  };

  const get = (sessionId: string): LiveSession => {
    const live = sessions.get(sessionId);
    if (!live) throw acp.RequestError.resourceNotFound(sessionId);
    return live;
  };

  return acp
    .agent({ name: "rx" })
    .onRequest(acp.methods.agent.initialize, async ({ params }) => {
      booleanSupported = params.clientCapabilities?.session?.configOptions?.boolean != null;
      compactionSupported = params.clientCapabilities?.session?.compaction != null;
      const available = await options.models.getAvailable();
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: available.some((model) => model.input.includes("image")), audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
        agentInfo: { name: "rx", title: "Rx", version: VERSION },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
      reportUnsupportedMcp(params.mcpServers);
      const { live, configuration } = await open(params.cwd, () => ({ log: SessionLog.create(options.home, params.cwd), messages: [] }), true);
      await client.notify(acp.methods.client.session.update, { sessionId: live.log.id, update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS } });
      return { sessionId: live.log.id, ...configuration };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      reportUnsupportedMcp(params.mcpServers);
      const previous = sessions.get(params.sessionId);
      if (previous?.running || previous?.configuring) throw acp.RequestError.invalidRequest(undefined, "session is running or changing configuration");
      const { cwd } = readSessionHeader(options.home, params.sessionId);
      if (cwd !== params.cwd) throw acp.RequestError.invalidParams(undefined, `session ${params.sessionId} belongs to ${cwd}, not ${params.cwd}`);
      const { live, history, usageMessages, configuration } = await open(cwd, () => {
        if (sessions.get(params.sessionId)?.running || sessions.get(params.sessionId)?.configuring) throw acp.RequestError.invalidRequest(undefined, "session is running");
        return SessionLog.open(options.home, params.sessionId);
      });
      live.configuring = true;
      try {
        for (const update of historyUpdates(cwd, history)) {
          await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
        }
        const usage = latestUsageUpdate(usageMessages, live.selection.model);
        if (usage) await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: usage });
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS } });
        return configuration;
      } finally {
        live.configuring = false;
      }
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params, client }) => {
      const live = get(params.sessionId);
      if (live.running || live.configuring) throw acp.RequestError.invalidRequest(undefined, "session is running or changing configuration");
      if (params.configId === "fast" && !booleanSupported) throw acp.RequestError.invalidParams(undefined, "client does not support boolean configuration options");
      live.configuring = true;
      try {
        const selection = await changeSessionConfig(options.models, live.selection, supportsFast, params.configId, params.value);
        const response = await snapshot(selection);
        live.selection = selection;
        live.agent.state.model = selection.model;
        live.agent.state.thinkingLevel = selection.thinking;
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: response.configOptions } });
        return response;
      } finally {
        live.configuring = false;
      }
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
      if (live.running || live.configuring) throw acp.RequestError.invalidRequest(undefined, "session is already running a prompt or changing configuration");
      const { text, images } = promptInput(params.prompt);
      if (images.length && !live.selection.model.input.includes("image")) throw acp.RequestError.invalidParams(undefined, `model ${formatModel(live.selection.model)} does not support image input`);
      const control = contextControl(live.agent);
      const manual = params.prompt.every((block) => block.type === "text") && text.trim() === "/compact";
      let pending = Promise.resolve();
      const abort = () => {
        live.agent.abort();
        control.abort();
      };
      const notify = (update: Update) => {
        pending = pending
          .then(() => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }))
          .catch(abort);
      };
      const unsubscribe = live.agent.subscribe((event) => {
        const updates = eventUpdates(live.log.cwd, event);
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = usageUpdate(event.message, live.selection.model);
          if (usage) updates.push(usage);
        }
        for (const update of updates) notify(update);
        return pending;
      });
      const unsubscribeCompaction = control.subscribe((event) => notify(compactionUpdate(event, compactionSupported, live.cancelled)));
      const onClose = () => {
        live.cancelled = true;
        abort();
      };
      live.running = true;
      live.cancelled = false;
      signal.addEventListener("abort", onClose, { once: true });
      if (signal.aborted) onClose();
      try {
        if (!live.cancelled) {
          if (manual) await control.compact();
          else await live.agent.prompt(text, images);
        }
      } catch (error) {
        if (!live.cancelled) throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
      } finally {
        try {
          await Promise.all([live.agent.waitForIdle(), control.waitForIdle()]);
          unsubscribe();
          unsubscribeCompaction();
          await pending;
        } finally {
          signal.removeEventListener("abort", onClose);
          live.running = false;
        }
      }
      return { stopReason: manual ? (live.cancelled ? "cancelled" : "end_turn") : stopReason(live.agent.state.messages, live.cancelled) };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const live = sessions.get(params.sessionId);
      if (!live?.running) return;
      live.cancelled = true;
      live.agent.abort();
      contextControl(live.agent).abort();
    });
}

export function serveAcp(options: AcpOptions): { closed: Promise<void>; stop: () => Promise<void> } {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const sessions = new Map<string, LiveSession>();
  const connection = createAcpApp(options, sessions).connect(acp.ndJsonStream(output, input));
  const closed = connection.closed.then(async () => {
    await Promise.all([...sessions.values()].map(async (live) => {
      const control = contextControl(live.agent);
      live.agent.abort();
      control.abort();
      await Promise.all([live.agent.waitForIdle(), control.waitForIdle()]);
    }));
  });
  return {
    closed,
    stop: () => {
      connection.close();
      return closed;
    },
  };
}
