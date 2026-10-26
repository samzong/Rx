import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type Models } from "@earendil-works/pi-ai";
import { fastStreamOptions } from "./acp-fast.ts";
import { installContextControl } from "./context.ts";
import { loadInstructions, projectDirectories } from "./instructions.ts";
import type { Origin, SessionLog } from "./session-log.ts";
import { skillCatalog } from "./skills.ts";
import { codingTools } from "./tools.ts";
import { installHooks, isHookContext } from "./hooks.ts";
import type { HookConfiguration } from "./hook-types.ts";
import { transportDiagnostics } from "./transport-errors.ts";

export function systemPrompt(cwd: string, now: Date = new Date()): string {
  const sections = [
    [
      "You are Rx, a coding agent working directly in the user's local environment.",
      "Use the tools to inspect files, change them, and run commands. Read a file before editing it.",
      "Keep changes focused on the request, verify them with the project's own checks, and report what you verified and what you did not.",
      "Tool calls run with the user's permissions. Do not run destructive commands unless the user asked for them.",
    ].join("\n"),
    [`Working directory: ${cwd}`, `Platform: ${process.platform}`, `Date: ${now.toISOString().slice(0, 10)}`].join("\n"),
  ];
  const directories = projectDirectories(cwd);
  const instructions = loadInstructions(directories);
  if (instructions.length) {
    sections.push("Apply the following instructions in order. If instructions conflict, the later file takes precedence over the earlier file.");
    for (const { file, text } of instructions) sections.push(`Instructions from ${file}:\n\n${text}`);
  }
  const skills = skillCatalog(directories);
  for (const diagnostic of skills.diagnostics) process.stderr.write(`rx-agent: skills: ${diagnostic}\n`);
  if (skills.prompt) sections.push(skills.prompt);
  return sections.join("\n\n");
}

export interface RxAgentOptions {
  models: Models;
  model: Model<Api>;
  thinking: ThinkingLevel;
  cwd: string;
  systemPrompt: string;
  log: SessionLog;
  origin: Origin;
  messages?: AgentMessage[];
  fast?: () => boolean;
  tools?: AgentTool[];
  hooks?: HookConfiguration;
}

const ROLE_ORIGIN: Record<string, Origin | undefined> = { assistant: "model", toolResult: "tool", system: "rx" };

function abortedStream(model: Model<Api>): AssistantMessageEventStream {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "aborted", error: message });
  stream.end(message);
  return stream;
}

export function createRxAgent(options: RxAgentOptions): Agent {
  const transport = transportDiagnostics();
  const agent = new Agent({
    streamFn: (model, context, streamOptions) => {
      const requestOptions = transport.streamOptions(model.api, fastStreamOptions(model, streamOptions, options.fast?.() === true));
      return streamOptions?.signal?.aborted ? abortedStream(model) : options.models.streamSimple(model, context, requestOptions);
    },
    sessionId: options.log.id,
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinking,
      tools: [...codingTools(options.cwd, () => agent.state.model), ...options.tools ?? []],
      messages: options.messages ?? [],
    },
  });
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    if (event.message.role === "assistant") {
      const failure = transport.takeFailure();
      if (event.message.stopReason === "error" && failure) event.message.errorMessage = failure;
    }
    options.log.append(isHookContext(event.message) ? "rx" : ROLE_ORIGIN[event.message.role] ?? options.origin, event.message);
  });
  installContextControl(agent, options.models, options.log);
  if (options.hooks) installHooks(agent, options.log, options.hooks);
  return agent;
}
