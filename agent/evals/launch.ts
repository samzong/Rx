import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";

export function launchProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number>((resolve) => {
    let started = false;
    child.once("spawn", () => { started = true; });
    child.once("error", () => {});
    child.once("close", (code) => resolve(started ? code ?? 1 : 127));
  });
  return { child, closed };
}
