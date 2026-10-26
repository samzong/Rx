import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { hookControl, isHookContext } from "./hooks.ts";
import { formatModel } from "./models.ts";
import { contextControl, type CompactionEvent } from "./context-control.ts";

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
  if (event.type === "message_end" && isHookContext(event.message) && event.message.role === "user") {
    stderr.write(`${typeof event.message.content === "string" ? event.message.content : JSON.stringify(event.message.content)}\n`);
    return;
  }
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

function renderCompaction(event: CompactionEvent): void {
  const message = event.status === "in_progress" ? "Compacting context..." : event.status === "completed" ? "Context compacted." : `Context compaction failed${event.message ? `: ${firstLine(event.message)}` : "."}`;
  stderr.write(dim(`${message}\n`));
}

export async function runPrint(agent: Agent, prompt: string): Promise<number> {
  const control = contextControl(agent);
  const unsubscribe = agent.subscribe((event) => render(event, false));
  const unsubscribeCompaction = control.subscribe(renderCompaction);
  const unsubscribeHooks = hookControl(agent)?.subscribe((notice) => {
    if ("text" in notice) stderr.write(`${notice.text}\n`);
  });
  const onSigint = () => {
    agent.abort();
    control.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    await agent.prompt(prompt);
  } finally {
    await Promise.all([agent.waitForIdle(), control.waitForIdle()]);
    process.off("SIGINT", onSigint);
    unsubscribe();
    unsubscribeCompaction();
    unsubscribeHooks?.();
  }
  const stop = lastStop(agent.state.messages);
  if (!stdout.isTTY) stdout.write("\n");
  return hookControl(agent)?.rejected || stop === "error" || stop === "aborted" ? 1 : 0;
}

export async function runRepl(agent: Agent, banner: string, initialPrompt?: string): Promise<void> {
  stderr.write(dim(`${banner}\nmodel ${formatModel(agent.state.model)} · thinking ${agent.state.thinkingLevel} · Ctrl-C aborts a turn, Ctrl-D exits\n`));
  const control = contextControl(agent);
  const rl = createInterface({ input: stdin, output: stdout });
  let running = false;
  let closed = false;
  let manual = false;
  const abort = () => {
    agent.abort();
    control.abort();
  };
  rl.on("SIGINT", () => {
    if (running) abort();
    else rl.close();
  });
  rl.on("close", () => {
    closed = true;
    if (running) abort();
  });
  const unsubscribe = agent.subscribe((event) => render(event, true));
  const unsubscribeHooks = hookControl(agent)?.subscribe((notice) => {
    if ("text" in notice) stderr.write(`${notice.text}\n`);
  });
  const unsubscribeCompaction = control.subscribe((event) => {
    if (!manual) renderCompaction(event);
  });
  try {
    if (initialPrompt !== undefined) {
      running = true;
      try {
        await agent.prompt(initialPrompt);
      } finally {
        running = false;
      }
    }
    for (;;) {
      let line: string;
      try {
        line = await rl.question("› ");
      } catch {
        break;
      }
      if (closed) break;
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      running = true;
      try {
        if (input === "/compact") {
          manual = true;
          renderCompaction({ id: "manual", status: "in_progress" });
          try {
            await control.compact();
            renderCompaction({ id: "manual", status: "completed" });
          } catch (error) {
            renderCompaction({ id: "manual", status: "failed", message: error instanceof Error ? error.message : String(error) });
          } finally {
            manual = false;
          }
        } else await agent.prompt(input);
      } finally {
        running = false;
      }
    }
  } finally {
    abort();
    await Promise.all([agent.waitForIdle(), control.waitForIdle()]);
    unsubscribe();
    unsubscribeCompaction();
    unsubscribeHooks?.();
    rl.close();
  }
}
