import type { Agent, AgentMessage, AfterToolCallContext, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { parseHookOutput } from "./hook-config.ts";
import { runHookCommand } from "./hook-runner.ts";
import { HOOK_OUTPUT_LIMIT } from "./hook-types.ts";
import type { HookConfiguration, HookEvent, HookInput, HookOutput } from "./hook-types.ts";
import type { SessionLog } from "./session-log.ts";

export type HookNotice =
  | { event: HookEvent; text: string }
  | { event: "PreToolUse"; toolCallId: string; toolName: string; input: Record<string, unknown> };

export interface HookControl {
  readonly rejected: boolean;
  start(source: "startup" | "resume", signal?: AbortSignal): Promise<void>;
  subscribe(listener: (notice: HookNotice) => void): () => void;
}

const controls = new WeakMap<Agent, HookControl>();
const contexts = new WeakSet<AgentMessage>();

export function hookControl(agent: Agent): HookControl | undefined {
  return controls.get(agent);
}

export function isHookContext(message: AgentMessage): boolean {
  return contexts.has(message);
}

function contextMessage(event: HookEvent, text: string): AgentMessage {
  const message: AgentMessage = { role: "user", content: `[Hook-provided context: ${event}]\n${text}`, timestamp: Date.now() };
  contexts.add(message);
  return message;
}

export function installHooks(agent: Agent, log: SessionLog, configuration: HookConfiguration): void {
  if (!Object.values(configuration).some((groups) => groups?.length)) return;
  const listeners = new Set<(notice: HookNotice) => void>();
  const active = new Set<AbortController>();
  let queued: AgentMessage[] = [];
  let work: Promise<void> | undefined;
  let promptAbort: AbortController | undefined;
  let opening: Promise<void> | undefined;
  let opened = false;
  let rejected = false;
  const nativePrompt = agent.prompt.bind(agent);
  const nativeAbort = agent.abort.bind(agent);
  const nativeIdle = agent.waitForIdle.bind(agent);

  const notice = (event: HookEvent, text: string) => {
    for (const listener of listeners) listener({ event, text: `[Hook ${event}] ${text}` });
  };

  const run = async (event: HookEvent, fields: Partial<HookInput>, signal?: AbortSignal, revalidate?: (input: Record<string, unknown>) => Record<string, unknown>): Promise<HookOutput> => {
    const controller = new AbortController();
    active.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const input: HookInput = {
      ...fields, hook_event_name: event, session_id: log.id, cwd: log.cwd,
      transcript_path: log.path, transcript_format: "rx-jsonl-v1",
    };
    const output: HookOutput = { blocked: false };
    const context: string[] = [];
    const diagnostics: string[] = [];
    try {
      for (const group of configuration[event] ?? []) {
        if (group.matcher && !group.matcher.test(event === "SessionStart" ? input.source ?? "" : input.tool_name ?? "")) continue;
        for (const command of group.commands) {
          combined.throwIfAborted();
          let result: HookOutput;
          try {
            result = parseHookOutput(event, await runHookCommand(command, input, combined));
            combined.throwIfAborted();
            if (result.context && Buffer.byteLength([...context, result.context].join("\n")) > HOOK_OUTPUT_LIMIT) throw new Error("Hook context exceeded 64 KiB for this event");
            if (result.updatedInput && revalidate) output.updatedInput = input.tool_input = revalidate(result.updatedInput);
          } catch (error) {
            result = { blocked: true, reason: combined.aborted ? "Hook cancelled" : error instanceof Error ? error.message : "Hook execution failed" };
          }
          if (result.context) context.push(result.context);
          if (result.diagnostic) diagnostics.push(result.diagnostic);
          if (result.blocked) {
            output.blocked = true;
            output.reason = [output.reason, result.reason ?? "Hook check failed"].filter(Boolean).join("\n");
            if (combined.aborted || event === "SessionStart" || event === "UserPromptSubmit" || event === "PreToolUse") return output;
          }
        }
      }
      if (context.length) output.context = context.join("\n");
      if (diagnostics.length) output.diagnostic = diagnostics.join("\n");
      return output;
    } catch (error) {
      return { blocked: true, reason: combined.aborted ? "Hook cancelled" : error instanceof Error ? error.message : "Hook execution failed" };
    } finally {
      active.delete(controller);
    }
  };

  const queue = (event: HookEvent, output: HookOutput) => {
    if (output.context) queued.push(contextMessage(event, output.context));
  };
  const toolFields = ({ toolCall, args }: BeforeToolCallContext) => ({ tool_name: toolCall.name, tool_use_id: toolCall.id, tool_input: structuredClone(args) });

  agent.beforeToolCall = async (call, signal) => {
    const output = await run("PreToolUse", toolFields(call), signal, (input) => {
      const tool = call.context.tools?.find((candidate) => candidate.name === call.toolCall.name);
      if (!tool) throw new Error(`Tool ${call.toolCall.name} not found`);
      return validateToolArguments(tool, { ...call.toolCall, arguments: input as JsonObject });
    });
    queue("PreToolUse", output);
    if (output.diagnostic) notice("PreToolUse", output.diagnostic);
    if (output.blocked) return { block: true, reason: `[Hook PreToolUse] ${output.reason}` };
    if (output.updatedInput) {
      log.appendToolInput(call.toolCall.id, output.updatedInput);
      const args = call.args as Record<string, unknown>;
      for (const key of Object.keys(args)) delete args[key];
      Object.assign(args, output.updatedInput);
      for (const listener of listeners) listener({ event: "PreToolUse", toolCallId: call.toolCall.id, toolName: call.toolCall.name, input: output.updatedInput });
    }
    return undefined;
  };
  agent.afterToolCall = async (call: AfterToolCallContext, signal) => {
    const event = call.isError ? "PostToolUseFailure" : "PostToolUse";
    let output: HookOutput;
    try {
      const fields = {
        ...toolFields(call),
        ...(call.isError ? { error: call.result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") } : {}),
        tool_response: { content: call.result.content, isError: call.isError },
      };
      output = await run(event, fields, signal);
    } catch {
      output = { blocked: true, reason: "Hook result check failed" };
    }
    queue(event, output);
    const feedback = [output.diagnostic, output.blocked ? `Validation failed: ${output.reason}` : undefined].filter(Boolean).join("\n");
    if (!feedback) return undefined;
    return {
      content: [...call.result.content, { type: "text" as const, text: `[Hook ${event}] ${feedback}` }],
      isError: call.isError || output.blocked,
      structuredContent: call.result.structuredContent,
    };
  };
  agent.prepareNextTurn = () => {
    if (!queued.length) return undefined;
    const messages = queued;
    queued = [];
    return { messages };
  };

  agent.prompt = ((input, images) => {
    if (work || opening || agent.state.isStreaming) return Promise.reject(new Error("The agent is already processing a request"));
    const abort = new AbortController();
    rejected = false;
    promptAbort = abort;
    const pending = (async () => {
      const messages: AgentMessage[] = typeof input === "string"
        ? [{ role: "user", content: [{ type: "text", text: input }, ...images ?? []], timestamp: Date.now() }]
        : Array.isArray(input) ? input : [input];
      const text = messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
      const output = await run("UserPromptSubmit", { prompt: text }, abort.signal);
      if (abort.signal.aborted) return;
      if (output.blocked) {
        rejected = true;
        notice("UserPromptSubmit", `Prompt rejected: ${output.reason}`);
        return;
      }
      if (output.diagnostic) notice("UserPromptSubmit", output.diagnostic);
      queue("UserPromptSubmit", output);
      const context = queued;
      queued = [];
      await nativePrompt(context.length ? [...messages, ...context] : messages);
      await nativeIdle();
      const last = agent.state.messages.findLast((message) => message.role === "assistant");
      if (abort.signal.aborted || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") return;
      const stopped = await run("Stop", {}, abort.signal);
      if (!abort.signal.aborted && (stopped.blocked || stopped.diagnostic)) notice("Stop", stopped.blocked ? `Final check failed: ${stopped.reason}` : stopped.diagnostic!);
    })();
    work = pending.finally(() => {
      try {
        const last = agent.state.messages.at(-1);
        if (abort.signal.aborted && !(last?.role === "assistant" && last.stopReason === "aborted")) {
          const model = agent.state.model;
          const message: AssistantMessage = {
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now(),
          };
          log.append("model", message);
          agent.state.messages.push(message);
        }
      } finally {
        work = undefined;
        promptAbort = undefined;
      }
    });
    return work;
  }) as Agent["prompt"];
  agent.abort = () => {
    promptAbort?.abort();
    for (const controller of active) controller.abort();
    nativeAbort();
  };
  agent.waitForIdle = () => work ?? opening ?? nativeIdle();
  controls.set(agent, {
    get rejected() { return rejected; },
    start: (source, signal) => {
      if (opened) return Promise.resolve();
      if (opening) return opening;
      const pending = (async () => {
        const output = await run("SessionStart", { source }, signal);
        signal?.throwIfAborted();
        if (output.blocked) throw new Error(`[Hook SessionStart] Session opening failed: ${output.reason}`);
        queue("SessionStart", output);
        if (output.diagnostic) notice("SessionStart", output.diagnostic);
        opened = true;
      })();
      opening = pending.finally(() => { opening = undefined; });
      return opening;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
