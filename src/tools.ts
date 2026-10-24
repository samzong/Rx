import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50_000;
export const BASH_HEAD_CHARS = 5_000;
export const BASH_TAIL_CHARS = 25_000;
export const BASH_DEFAULT_TIMEOUT_S = 120;
export const BASH_MAX_TIMEOUT_S = 600;
const BASH_PIPE_GRACE_MS = 100;

function text(value: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: value }], details: undefined };
}

function truncateBytes(value: string, max: number): string {
  return Buffer.from(value).subarray(0, max).toString("utf8").replace(/\uFFFD$/, "");
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function readText(path: string): string {
  const buffer = readFileSync(path);
  if (buffer.subarray(0, 8192).includes(0)) throw new Error(`${path} looks like a binary file`);
  return buffer.toString("utf8");
}

const readParams = Type.Object({
  path: Type.String({ description: "File path, absolute or relative to the working directory" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to start from" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to return" })),
});

const writeParams = Type.Object({
  path: Type.String({ description: "File path, absolute or relative to the working directory" }),
  content: Type.String({ description: "Complete new file content" }),
});

const editParams = Type.Object({
  path: Type.String({ description: "File path, absolute or relative to the working directory" }),
  old_text: Type.String({ description: "Exact text to replace; must match once unless replace_all is true" }),
  new_text: Type.String({ description: "Replacement text" }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
});

const bashParams = Type.Object({
  command: Type.String({ description: "Command line run with bash -c in the working directory" }),
  timeout: Type.Optional(
    Type.Integer({ minimum: 1, maximum: BASH_MAX_TIMEOUT_S, description: `Timeout in seconds, default ${BASH_DEFAULT_TIMEOUT_S}` }),
  ),
});

export function readTool(cwd: string): AgentTool<typeof readParams, undefined> {
  return {
    name: "read",
    label: "Read",
    description: `Read a text file with line numbers. Returns at most ${READ_MAX_LINES} lines or ${READ_MAX_BYTES} bytes; use offset and limit for more.`,
    parameters: readParams,
    async execute(_id, { path, offset, limit }) {
      const lines = readText(resolvePath(cwd, path)).split("\n");
      if (lines.length > 1 && lines.at(-1) === "") lines.pop();
      const start = (offset ?? 1) - 1;
      if (start >= lines.length && lines.length > 0) throw new Error(`offset ${offset} is past the end of the file (${lines.length} lines)`);
      const end = Math.min(lines.length, start + Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES));
      const out: string[] = [];
      let bytes = 0;
      let line = start;
      for (; line < end; line++) {
        const entry = `${line + 1}\t${lines[line]}`;
        const size = Buffer.byteLength(entry) + 1;
        if (bytes + size > READ_MAX_BYTES) {
          if (out.length === 0) {
            out.push(truncateBytes(entry, READ_MAX_BYTES), `[line ${line + 1} truncated at ${READ_MAX_BYTES} bytes; use bash with cut or head -c to see the rest]`);
            line++;
          }
          break;
        }
        bytes += size;
        out.push(entry);
      }
      if (line < lines.length) out.push(`[showing lines ${start + 1}-${line} of ${lines.length}; continue with offset ${line + 1}]`);
      return text(out.join("\n"));
    },
  };
}

export function writeTool(cwd: string): AgentTool<typeof writeParams, undefined> {
  return {
    name: "write",
    label: "Write",
    description: "Create or overwrite a file with the given content, creating parent directories as needed.",
    parameters: writeParams,
    async execute(_id, { path, content }) {
      const target = resolvePath(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return text(`wrote ${Buffer.byteLength(content)} bytes to ${target}`);
    },
  };
}

export function editTool(cwd: string): AgentTool<typeof editParams, undefined> {
  return {
    name: "edit",
    label: "Edit",
    description: "Replace exact text in a file. old_text must match exactly once unless replace_all is true.",
    parameters: editParams,
    async execute(_id, { path, old_text, new_text, replace_all }) {
      if (old_text === "") throw new Error("old_text must not be empty");
      if (old_text === new_text) throw new Error("old_text and new_text are identical");
      const target = resolvePath(cwd, path);
      const content = readText(target);
      const parts = content.split(old_text);
      const count = parts.length - 1;
      if (count === 0) throw new Error(`old_text not found in ${target}`);
      if (count > 1 && !replace_all) throw new Error(`old_text matches ${count} times in ${target}; add context or set replace_all`);
      writeFileSync(target, parts.join(new_text));
      return text(`replaced ${count} occurrence${count === 1 ? "" : "s"} in ${target}`);
    },
  };
}

class HeadTail {
  private head = "";
  private tail = "";
  private dropped = 0;

  push(chunk: string): void {
    if (this.head.length < BASH_HEAD_CHARS) {
      const room = BASH_HEAD_CHARS - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    this.tail += chunk;
    if (this.tail.length > BASH_TAIL_CHARS) {
      this.dropped += this.tail.length - BASH_TAIL_CHARS;
      this.tail = this.tail.slice(-BASH_TAIL_CHARS);
    }
  }

  toString(): string {
    return this.dropped ? `${this.head}\n[... ${this.dropped} characters omitted ...]\n${this.tail}` : this.head + this.tail;
  }
}

export function bashTool(cwd: string): AgentTool<typeof bashParams, undefined> {
  return {
    name: "bash",
    label: "Bash",
    description: `Run a shell command with bash -c in the working directory. Output combines stdout and stderr and keeps the first ${BASH_HEAD_CHARS} and last ${BASH_TAIL_CHARS} characters. A non-zero exit is reported as an error. The tool returns when the command exits; redirect the output of background processes to a file.`,
    parameters: bashParams,
    execute(_id, { command, timeout }, signal) {
      return new Promise((resolvePromise, reject) => {
        if (signal?.aborted) return reject(new Error("command aborted before start"));
        const seconds = Math.min(timeout ?? BASH_DEFAULT_TIMEOUT_S, BASH_MAX_TIMEOUT_S);
        const child = spawn("/bin/bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const output = new HeadTail();
        let stopped: string | undefined;
        const kill = (reason: string) => {
          stopped ??= reason;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
        };
        const timer = setTimeout(() => kill(`timed out after ${seconds}s`), seconds * 1000);
        const onAbort = () => kill("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
        let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        let done = false;
        const settle = () => {
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = () => {
          if (done || !exit) return;
          settle();
          child.stdout.destroy();
          child.stderr.destroy();
          const body = output.toString();
          const status = stopped ?? (exit.code === 0 ? "exit code 0" : exit.code === null ? `killed by ${exit.signal}` : `exit code ${exit.code}`);
          const result = `${body}${body && !body.endsWith("\n") ? "\n" : ""}[${status}]`;
          if (stopped || exit.code !== 0) reject(new Error(result));
          else resolvePromise(text(result));
        };
        child.on("error", (error) => {
          if (done) return;
          settle();
          reject(error);
        });
        child.on("exit", (code, killSignal) => {
          exit = { code, signal: killSignal };
          setTimeout(finish, BASH_PIPE_GRACE_MS);
        });
        child.on("close", finish);
      });
    },
  };
}

export function codingTools(cwd: string): AgentTool<any, undefined>[] {
  return [readTool(cwd), writeTool(cwd), editTool(cwd), bashTool(cwd)];
}
