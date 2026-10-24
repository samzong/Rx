import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, type Models } from "@earendil-works/pi-ai";
import type { Origin, SessionLog } from "./session-log.ts";
import { codingTools } from "./tools.ts";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export function projectInstructions(cwd: string): { file: string; text: string } | undefined {
  for (const name of INSTRUCTION_FILES) {
    const file = join(cwd, name);
    if (existsSync(file)) return { file, text: readFileSync(file, "utf8").trim() };
  }
  return undefined;
}

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
  const instructions = projectInstructions(cwd);
  if (instructions) sections.push(`Project instructions from ${instructions.file}:\n\n${instructions.text}`);
  return sections.join("\n\n");
}

export interface RxAgentOptions {
  models: Models;
  model: Model<Api>;
  thinking: ThinkingLevel;
  cwd: string;
  log: SessionLog;
  origin: Origin;
  messages?: AgentMessage[];
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
  const agent = new Agent({
    streamFn: (model, context, streamOptions) =>
      streamOptions?.signal?.aborted ? abortedStream(model) : options.models.streamSimple(model, context, streamOptions),
    sessionId: options.log.id,
    initialState: {
      systemPrompt: systemPrompt(options.cwd),
      model: options.model,
      thinkingLevel: options.thinking,
      tools: codingTools(options.cwd),
      messages: options.messages ?? [],
    },
  });
  agent.subscribe((event) => {
    if (event.type === "message_end") options.log.append(ROLE_ORIGIN[event.message.role] ?? options.origin, event.message);
  });
  return agent;
}
