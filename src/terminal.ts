import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { formatModel } from "./models.ts";

const dim = (value: string) => (stderr.isTTY ? `\x1b[2m${value}\x1b[22m` : value);

function firstLine(value: string, max = 160): string {
  const line = value.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function argsSummary(args: unknown): string {
  const input = (args ?? {}) as Record<string, unknown>;
  if (typeof input.command === "string") return firstLine(input.command);
  if (typeof input.path === "string") return input.path;
  return "";
}

export function render(event: AgentEvent, showThinking: boolean): void {
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner.type === "text_delta") stdout.write(inner.delta);
    else if (inner.type === "thinking_delta" && showThinking) stderr.write(dim(inner.delta));
    else if (inner.type === "thinking_end" && showThinking) stderr.write("\n");
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    const message = event.message;
    if (message.content.some((b) => b.type === "text" && b.text) && stdout.isTTY) stdout.write("\n");
    if (message.stopReason === "error") stderr.write(`error: ${message.errorMessage ?? "model request failed"}\n`);
    if (message.stopReason === "aborted") stderr.write("[aborted]\n");
  } else if (event.type === "tool_execution_start") {
    stderr.write(dim(`• ${event.toolName} ${argsSummary(event.args)}\n`));
  } else if (event.type === "tool_execution_end" && event.isError) {
    const text = (event.result?.content ?? []).find((b: { type: string }) => b.type === "text")?.text ?? "";
    stderr.write(dim(`  ✗ ${firstLine(text)}\n`));
  }
}

export function lastStop(messages: AgentMessage[]): string | undefined {
  const last = messages.findLast((m) => m.role === "assistant");
  return last?.role === "assistant" ? last.stopReason : undefined;
}

export async function runPrint(agent: Agent, prompt: string): Promise<number> {
  const unsubscribe = agent.subscribe((event) => render(event, false));
  const onSigint = () => agent.abort();
  process.on("SIGINT", onSigint);
  try {
    await agent.prompt(prompt);
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
  }
  const stop = lastStop(agent.state.messages);
  if (!stdout.isTTY) stdout.write("\n");
  return stop === "error" || stop === "aborted" ? 1 : 0;
}

export async function runRepl(agent: Agent, banner: string): Promise<void> {
  stderr.write(dim(`${banner}\nmodel ${formatModel(agent.state.model)} · thinking ${agent.state.thinkingLevel} · Ctrl-C aborts a turn, Ctrl-D exits\n`));
  const rl = createInterface({ input: stdin, output: stdout });
  let running = false;
  rl.on("SIGINT", () => {
    if (running) agent.abort();
    else rl.close();
  });
  const unsubscribe = agent.subscribe((event) => render(event, true));
  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question("› ");
      } catch {
        break;
      }
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      running = true;
      try {
        await agent.prompt(input);
      } finally {
        running = false;
      }
    }
  } finally {
    unsubscribe();
    rl.close();
  }
}
