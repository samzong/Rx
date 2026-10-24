#!/usr/bin/env node
import { constants } from "node:os";
import { parseArgs } from "node:util";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRxAgent } from "./agent.ts";
import { serveAcp } from "./acp.ts";
import { configPath, loadConfig, rxHome } from "./config.ts";
import { deviceId, FileCredentialStore } from "./credentials.ts";
import { login, terminalInteraction } from "./login.ts";
import { formatModel, parseThinking, resolveModel, type ModelChoice } from "./models.ts";
import { applyHandoff, parseHandoff, PROVIDER_ENV } from "./rx-provider.ts";
import { listSessions, SessionLog } from "./session-log.ts";
import { runPrint, runRepl } from "./terminal.ts";
import { VERSION } from "./version.ts";

const HELP = `rx-agent ${VERSION} - the Rx coding agent

Usage:
  rx-agent [options]               start an interactive session in the current directory
  rx-agent -p <prompt> [options]   run one prompt and exit
  rx-agent acp                     serve the Agent Client Protocol on stdio
  rx-agent models                  list models that have credentials
  rx-agent sessions [--all]        list saved sessions for this directory
  rx-agent login [provider]        sign in with a subscription or store an API key
  rx-agent logout <provider>       remove stored credentials for a provider

\`rx agent\` and \`rxa\` start rx-agent with the selected rx provider.

Options:
  -m, --model <provider/id>  model to use (default: RX_MODEL, then "model" in config.json,
                             then the default model of the rx launch)
      --thinking <level>     off, minimal, low, medium, high, xhigh, max (default: medium)
  -r, --resume <id>          resume a saved session
  -c, --continue             resume the latest session in this directory
  -h, --help                 show this help
  -v, --version              show the version

Files:
  $RX_HOME (default ~/.rx)/config.json   {"model": "provider/id", "thinking": "medium"}
  $RX_HOME/sessions/<id>.jsonl           append-only session logs
  $RX_HOME/auth.json                     credentials stored by rx-agent login
  $RX_HOME/device-id                     installation id sent to providers that require one
`;

const SHUTDOWN_GRACE_MS = 5_000;

function onTerminate(stop: () => Promise<unknown>): void {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      setTimeout(() => process.exit(128 + constants.signals[signal]), SHUTDOWN_GRACE_MS).unref();
      void stop().finally(() => process.exit(128 + constants.signals[signal]));
    });
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      thinking: { type: "string" },
      resume: { type: "string", short: "r" },
      continue: { type: "boolean", short: "c" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${VERSION}\n`);
    return 0;
  }

  const home = rxHome();
  const config = loadConfig(home);
  const command = positionals[0];
  const auth = command === "login" || command === "logout";
  if (
    positionals.length > (auth ? 2 : 1) ||
    (command && !auth && !["acp", "models", "sessions"].includes(command)) ||
    (command === "logout" && positionals.length < 2)
  ) {
    throw new Error(command === "logout" && positionals.length < 2 ? "logout needs a provider; see rx-agent --help" : `unexpected argument "${positionals.at(-1)}"; see rx-agent --help`);
  }

  registerBunOAuthFlows();
  const handoff = auth ? undefined : process.env[PROVIDER_ENV];
  const launch = handoff ? parseHandoff(handoff) : undefined;
  const credentials = new FileCredentialStore(home, launch?.id);
  const models = builtinModels({ credentials });
  if (launch) applyHandoff(models, launch);

  if (command === "login") {
    const interaction = terminalInteraction();
    try {
      const { provider } = await login(models, positionals[1], interaction, () => deviceId(home));
      process.stderr.write(`logged in to ${provider.name}; credentials saved in ${credentials.path}\n`);
    } finally {
      interaction.close();
    }
    return 0;
  }
  if (command === "logout") {
    const providerId = positionals[1]!;
    if (!(await credentials.read(providerId))) throw new Error(`no stored credentials for "${providerId}" in ${credentials.path}`);
    await models.logout(providerId);
    process.stderr.write(`removed stored credentials for ${providerId}\n`);
    return 0;
  }

  const choose = async (): Promise<ModelChoice> => {
    const thinking = values.thinking ?? config.thinking;
    parseThinking(thinking);
    const explicit = values.model ?? (process.env.RX_MODEL || undefined);
    if (explicit || !launch) return resolveModel(models, explicit ?? config.model, thinking);
    const fallback = `${launch.id}/${launch.defaultModel}`;
    if (!config.model) {
      process.stderr.write(`rx-agent: using ${fallback} (rx launch default; set "model" in ${configPath(home)} or pass --model)\n`);
    } else if (config.model.includes("/") && !config.model.startsWith(`${launch.id}/`)) {
      process.stderr.write(`rx-agent: "model" ${config.model} in ${configPath(home)} belongs to another provider and this rx launch uses ${launch.id}; using ${fallback} (pass --model, or --provider none to use it)\n`);
    } else {
      try {
        return await resolveModel(models, config.model, thinking);
      } catch (error) {
        process.stderr.write(`rx-agent: "model" ${config.model} in ${configPath(home)} is unavailable in this launch (${(error as Error).message}); using ${fallback}\n`);
      }
    }
    return resolveModel(models, fallback, thinking);
  };

  if (command === "acp") {
    const server = serveAcp({ home, models, choose });
    onTerminate(server.stop);
    await server.closed;
    setTimeout(() => process.exit(), SHUTDOWN_GRACE_MS).unref();
    return 0;
  }
  if (command === "models") {
    const available = await models.getAvailable();
    if (!available.length) process.stderr.write("no provider credentials found; run rx-agent login or set a provider API key environment variable\n");
    for (const model of available) process.stdout.write(`${formatModel(model)}${model.reasoning ? "\treasoning" : ""}\n`);
    return 0;
  }
  if (command === "sessions") {
    for (const s of listSessions(home, values.all ? undefined : process.cwd())) {
      process.stdout.write(`${s.id}\t${s.updatedAt}\t${values.all ? `${s.cwd}\t` : ""}${s.title}\n`);
    }
    return 0;
  }

  if (values.resume && values.continue) throw new Error("use either --resume or --continue, not both");
  const cwd = process.cwd();
  const resumeId = values.continue ? listSessions(home, cwd)[0]?.id : values.resume;
  if (values.continue && !resumeId) throw new Error(`no saved session for ${cwd}`);
  const choice = await choose();
  const loaded = resumeId ? SessionLog.open(home, resumeId) : undefined;
  const log = loaded?.log ?? SessionLog.create(home, cwd);
  if (log.cwd !== cwd) process.stderr.write(`note: session ${log.id} was started in ${log.cwd}; tools run there\n`);
  const agent = createRxAgent({ ...choice, models, cwd: log.cwd, log, origin: "cli", messages: loaded?.messages });
  onTerminate(() => {
    agent.abort();
    return agent.waitForIdle();
  });

  if (values.print !== undefined) return runPrint(agent, values.print);
  const banner = loaded
    ? `rx ${VERSION} · resumed ${log.id} (${loaded.messages.length} messages${loaded.repaired ? `, ${loaded.repaired} interrupted tool calls marked` : ""})`
    : `rx ${VERSION} · session ${log.id}`;
  await runRepl(agent, banner);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`rx-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
