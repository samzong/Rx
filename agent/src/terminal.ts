import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { hookControl, isHookContext } from "./hooks.ts";
import { formatModel } from "./models.ts";
import { contextControl, type CompactionEvent } from "./context-control.ts";
import { expandSkillCommand, type SkillCommand } from "./skills.ts";
import { retryControl } from "./retry.ts";

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
  } else if (event.type === "tool_execution_end" && event.toolName === "todo" && !event.isError) {
    for (const block of event.result.content) if (block.type === "text") stderr.write(`${block.text}\n`);
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
  const unsubscribeRetry = retryControl(agent).subscribe((event) => {
    if (event.status === "in_progress") stderr.write(dim(`Retrying model request (${event.attempt}/${event.maxAttempts}) in ${event.delayMs / 1000}s\n`));
  });
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
    unsubscribeRetry();
    unsubscribeCompaction();
    unsubscribeHooks?.();
  }
  const stop = lastStop(agent.state.messages);
  if (!stdout.isTTY) stdout.write("\n");
  return hookControl(agent)?.rejected || stop === "error" || stop === "aborted" ? 1 : 0;
}

const EXIT = { name: "exit", description: "Exit rx-agent" };
const QUIT = { name: "quit", description: "Exit rx-agent" };
const COMPACT = { name: "compact", description: "Compact the conversation context" };

function findExecutable(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return null;
}

const accent = (value: string) => `\x1b[36m${value}\x1b[39m`;
const faint = (value: string) => `\x1b[2m${value}\x1b[22m`;
const editorTheme = {
  borderColor: faint,
  selectList: { selectedPrefix: accent, selectedText: accent, description: faint, scrollInfo: faint, noMatch: faint },
};

async function readEditor(commands: readonly SkillCommand[], history: readonly string[], cwd: string, fdPath: string | null): Promise<string | undefined> {
  const { CombinedAutocompleteProvider, Editor, matchesKey, ProcessTerminal, TuiMainScreen } = await import("@earendil-works/pi-tui");
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const editor = new Editor(tui, editorTheme, { paddingX: 0 });
  const items = [EXIT, QUIT, COMPACT, ...commands.map(({ name, description }) => ({ name, description }))];
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(items, cwd, fdPath));
  for (const entry of history) editor.addToHistory(entry);
  tui.addChild(editor);
  tui.setFocus(editor);
  const input = await new Promise<string | undefined>((resolve) => {
    editor.onSubmit = (text) => {
      if (text.trim()) resolve(text);
    };
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c") && !editor.isShowingAutocomplete()) {
        if (!editor.getText()) resolve(undefined);
        else {
          editor.setText("");
          tui.requestRender();
        }
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !editor.getText()) {
        resolve(undefined);
        return { consume: true };
      }
      return undefined;
    });
    tui.start();
  });
  tui.removeChild(editor);
  tui.renderNow();
  await terminal.drainInput();
  tui.stop();
  if (input !== undefined) stdout.write(`› ${input}\n`);
  return input;
}

export async function runRepl(agent: Agent, banner: string, commands: readonly SkillCommand[], cwd: string, initialPrompt?: string, beginTurn?: () => void): Promise<void> {
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const fdPath = interactive ? findExecutable(["fd", "fdfind"]) : null;
  const hint = interactive ? ` · / commands and skills, @ files${fdPath ? "" : " (needs fd)"}` : "";
  stderr.write(dim(`${banner}\nmodel ${formatModel(agent.state.model)} · thinking ${agent.state.thinkingLevel} · Ctrl-C aborts a turn, Ctrl-D exits${hint}\n`));
  const control = contextControl(agent);
  const rl = interactive ? undefined : createInterface({ input: stdin, output: stdout });
  const history: string[] = [];
  let running = false;
  let closed = false;
  let manual = false;
  const abort = () => {
    agent.abort();
    control.abort();
  };
  const onSigint = () => {
    if (running) abort();
    else rl?.close();
  };
  if (rl) rl.on("SIGINT", onSigint);
  else process.on("SIGINT", onSigint);
  rl?.on("close", () => {
    closed = true;
    if (running) abort();
  });
  const unsubscribeRetry = retryControl(agent).subscribe((event) => {
    if (event.status === "in_progress") stderr.write(dim(`Retrying model request (${event.attempt}/${event.maxAttempts}) in ${event.delayMs / 1000}s\n`));
  });
  const unsubscribe = agent.subscribe((event) => render(event, true));
  const unsubscribeHooks = hookControl(agent)?.subscribe((notice) => {
    if ("text" in notice) stderr.write(`${notice.text}\n`);
  });
  const unsubscribeCompaction = control.subscribe((event) => {
    if (!manual) renderCompaction(event);
  });
  const read = async (): Promise<string | undefined> => {
    if (!rl) return readEditor(commands, history, cwd, fdPath);
    try {
      const line = await rl.question("› ");
      return closed ? undefined : line;
    } catch {
      return undefined;
    }
  };
  const run = async (input: string) => {
    if (input === "/compact") {
      beginTurn?.();
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
      return;
    }
    let text: string;
    try {
      text = expandSkillCommand(input, commands);
    } catch (error) {
      stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    await agent.prompt(text);
  };
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
      const line = await read();
      if (line === undefined) break;
      const input = line.trim();
      if (!input) continue;
      history.push(input);
      if (input === "/exit" || input === "/quit") break;
      running = true;
      try {
        await run(input);
      } finally {
        running = false;
      }
    }
  } finally {
    abort();
    await Promise.all([agent.waitForIdle(), control.waitForIdle()]);
    process.off("SIGINT", onSigint);
    unsubscribe();
    unsubscribeRetry();
    unsubscribeCompaction();
    unsubscribeHooks?.();
    rl?.close();
  }
}
