import { spawn } from "node:child_process";
import { HOOK_OUTPUT_LIMIT } from "./hook-types.ts";
import type { HookCommand, HookCommandResult, HookInput } from "./hook-types.ts";

const PIPE_GRACE_MS = 250;

export async function runHookCommand(handler: HookCommand, input: HookInput, signal?: AbortSignal): Promise<HookCommandResult> {
  if (signal?.aborted) throw new Error("Hook command aborted");
  let payload: string;
  try {
    payload = `${JSON.stringify(input)}\n`;
  } catch {
    throw new Error("Hook input could not be encoded");
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/bash", ["-c", handler.command], { cwd: input.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      reject(new Error("Hook process could not start"));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let done = false;
    let pipeTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new Error("Hook process group could not be stopped");
      }
    };
    const fail = (message: string) => {
      if (done) return;
      failure ??= new Error(message);
      killGroup();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const onAbort = () => fail("Hook command aborted");
    const onProcessError = () => fail("Hook process could not start");
    const onInputError = () => fail("Hook input could not be written");
    const onOutputError = () => fail("Hook output could not be read");
    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > HOOK_OUTPUT_LIMIT) fail("Hook stdout exceeded 64 KiB");
      else stdout.push(chunk);
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > HOOK_OUTPUT_LIMIT) fail("Hook stderr exceeded 64 KiB");
      else stderr.push(chunk);
    };
    const onExit = () => {
      killGroup();
      child.stdin?.destroy();
      pipeTimer = setTimeout(() => fail("Hook output did not close after the process exited"), PIPE_GRACE_MS);
    };
    const timer = setTimeout(() => fail("Hook command timed out"), handler.timeout * 1000);
    const onClose = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("error", onProcessError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdin?.removeListener("error", onInputError);
      child.stdout?.removeListener("data", onStdout);
      child.stdout?.removeListener("error", onOutputError);
      child.stderr?.removeListener("data", onStderr);
      child.stderr?.removeListener("error", onOutputError);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };

    child.on("error", onProcessError);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.stdin?.on("error", onInputError);
    child.stdout?.on("data", onStdout).on("error", onOutputError);
    child.stderr?.on("data", onStderr).on("error", onOutputError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (failure) return;
    try {
      child.stdin?.end(payload);
    } catch {
      fail("Hook input could not be written");
    }
  });
}
