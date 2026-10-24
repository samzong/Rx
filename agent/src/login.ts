import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Models, Provider } from "@earendil-works/pi-ai";

export interface TerminalInteraction extends AuthInteraction {
  close(): void;
}

export interface InteractionOptions {
  input?: Readable;
  output?: NodeJS.WritableStream;
  openUrl?: (url: string) => void;
}

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export function terminalInteraction(options: InteractionOptions = {}): TerminalInteraction {
  const input = options.input ?? process.stdin;
  const out = options.output ?? process.stderr;
  const openUrl = options.openUrl ?? openBrowser;
  const tty = Boolean((input as NodeJS.ReadStream).isTTY);
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) out.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: echo, terminal: tty });
  const lines: string[] = [];
  const waiters: { resolve(line: string): void; reject(error: unknown): void }[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("login cancelled: input closed"));
  });
  rl.on("SIGINT", () => process.exit(130));

  const nextLine = (signal?: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      if (lines.length) return resolve(lines.shift()!);
      if (closed) return reject(new Error("login cancelled: input closed"));
      const waiter = {
        resolve: (line: string) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(line);
        },
        reject,
      };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal!.reason);
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  const ask = async (question: string, secret: boolean, signal?: AbortSignal): Promise<string> => {
    for (;;) {
      signal?.throwIfAborted();
      out.write(question);
      muted = secret && tty;
      let answer: string;
      try {
        answer = (await nextLine(signal)).trim();
      } finally {
        if (muted) out.write("\n");
        muted = false;
      }
      if (answer) return answer;
    }
  };

  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type !== "select") {
        return ask(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `, prompt.type === "secret", prompt.signal);
      }
      out.write(`${prompt.message}\n`);
      prompt.options.forEach((option, index) => out.write(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}\n`));
      const answer = await ask(`Enter number (1-${prompt.options.length}): `, false, prompt.signal);
      const selected = /^\d+$/.test(answer) ? prompt.options[Number(answer) - 1] : undefined;
      if (!selected) throw new Error(`invalid selection "${answer}"`);
      return selected.id;
    },
    notify(event: AuthEvent): void {
      switch (event.type) {
        case "auth_url":
          out.write(`Open this URL in your browser:\n${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
          openUrl(event.url);
          break;
        case "device_code":
          out.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
          openUrl(event.verificationUri);
          break;
        case "info":
          out.write(`${event.message}\n`);
          for (const link of event.links ?? []) out.write(`  ${link.label ? `${link.label}: ` : ""}${link.url}\n`);
          break;
        case "progress":
          out.write(`${event.message}\n`);
          break;
      }
    },
    close: () => rl.close(),
  };
}

function loginTypes(provider: Provider): AuthType[] {
  return [...(provider.auth.oauth ? (["oauth"] as const) : []), ...(provider.auth.apiKey?.login ? (["api_key"] as const) : [])];
}

export async function login(
  models: Models,
  providerId: string | undefined,
  interaction: AuthInteraction,
  getDeviceId: () => string,
): Promise<{ provider: Provider; type: AuthType }> {
  let provider = providerId === undefined ? undefined : models.getProvider(providerId);
  if (providerId !== undefined && !provider) throw new Error(`unknown provider "${providerId}"`);
  if (!provider) {
    const choices = models.getProviders().filter((entry) => loginTypes(entry).length);
    const id = await interaction.prompt({ type: "select", message: "Log in to", options: choices.map((entry) => ({ id: entry.id, label: `${entry.name} (${entry.id})` })) });
    provider = models.getProvider(id)!;
  }
  const types = loginTypes(provider);
  if (!types.length) throw new Error(`${provider.name} has no login; it reads credentials from its environment`);
  const type =
    types.length === 1
      ? types[0]!
      : ((await interaction.prompt({
          type: "select",
          message: `Sign in to ${provider.name} with`,
          options: [
            { id: "oauth", label: provider.auth.oauth!.loginLabel ?? provider.auth.oauth!.name },
            { id: "api_key", label: provider.auth.apiKey!.name },
          ],
        })) as AuthType);
  await models.login(provider.id, type, interaction, { getDeviceId });
  return { provider, type };
}
