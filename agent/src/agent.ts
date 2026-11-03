import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Model, type Models, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fastStreamOptions } from "./acp-fast.ts";
import { installContextControl } from "./context.ts";
import { loadInstructions, projectDirectories } from "./instructions.ts";
import type { Origin, SessionLog } from "./session-log.ts";
import { type SkillCommand, skillCatalog } from "./skills.ts";
import { sessionHistoryTool } from "./session-history.ts";
import { codingTools } from "./tools.ts";
import { installHooks, isHookContext } from "./hooks.ts";
import type { HookConfiguration } from "./hook-types.ts";
import { transportDiagnostics } from "./transport-errors.ts";
import { retryControl, retryStream } from "./retry.ts";

export function systemPrompt(cwd: string, now: Date = new Date()): { prompt: string; commands: SkillCommand[] } {
  const sections = [
    [
      "You are Rx, a coding agent working directly in the user's local environment.",
      "Use the tools to inspect files, change them, and run commands. Read a file before editing it.",
      "Keep changes focused on the request, verify them with the project's own checks, and report what you verified and what you did not.",
      "Tool calls run with the user's permissions. Do not run destructive commands unless the user asked for them.",
      "Use todo to track multi-step work. Replace the complete list when work starts, finishes, or changes.",
      "If ask_user is available, use it when you need a user decision instead of guessing. Otherwise, ask in your response.",
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
  return { prompt: sections.join("\n\n"), commands: skills.commands };
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
  onUsage?: (message: AssistantMessage) => void;
  onResponse?: SimpleStreamOptions["onResponse"];
  onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
}

const ROLE_ORIGIN: Record<string, Origin | undefined> = { assistant: "model", toolResult: "tool", system: "rx" };

export function createRxAgent(options: RxAgentOptions): Agent {
  const transport = transportDiagnostics();
  const agent = new Agent({
    streamFn: (model, context, streamOptions) => retryStream(
      model, context, streamOptions,
      (selected, input, requestOptions) => options.models.streamSimple(selected, input, transport.streamOptions(selected.api, fastStreamOptions(selected, { ...requestOptions, onResponse: options.onResponse, onProviderStreamEvent: options.onProviderStreamEvent }, options.fast?.() === true))),
      transport.takeFailure,
      (message) => { options.log.append("model", message); agent.state.messages.push(message); options.onUsage?.(message); },
      (event) => retryControl(agent).emit(event),
    ),
    sessionId: options.log.id,
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinking,
      tools: [...codingTools(options.cwd, () => agent.state.model), sessionHistoryTool(options.log, () => agent.state.model), ...options.tools ?? []],
      messages: options.messages ?? [],
    },
  });
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    options.log.append(isHookContext(event.message) ? "rx" : ROLE_ORIGIN[event.message.role] ?? options.origin, event.message);
    if (event.message.role === "assistant") options.onUsage?.(event.message);
  });
  installContextControl(agent, options.models, options.log, options.onUsage, options.onResponse, options.onProviderStreamEvent);
  if (options.hooks) installHooks(agent, options.log, options.hooks);
  if (options.origin === "cli") {
    const prompt = agent.prompt.bind(agent);
    agent.prompt = ((...args: Parameters<Agent["prompt"]>) => {
      options.log.beginTurn();
      return prompt(...args);
    }) as Agent["prompt"];
  }
  return agent;
}
