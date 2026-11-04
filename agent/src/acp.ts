import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { createRxAgent, systemPrompt } from "./agent.ts";
import { formatModel, type ModelChoice } from "./models.ts";
import { configurationSnapshot, changeSessionConfig } from "./acp-config.ts";
import { supportsFast } from "./acp-fast.ts";
import type { AcpSelection } from "./acp-state.ts";
import { latestUsageUpdate } from "./acp-usage.ts";
import { SessionUsage } from "./acp-session-usage.ts";
import { listSessions, readSessionHeader, SessionLog, unlockSession, type Origin } from "./session-log.ts";
import { VERSION } from "./version.ts";
import { connectMcp } from "./mcp.ts";
import { loadHooks } from "./hook-config.ts";
import { hookControl } from "./hooks.ts";
import type { SkillCommand } from "./skills.ts";
import { historyUpdates } from "./acp-messages.ts";
import { contextControl } from "./context-control.ts";
import { forkTurnId, initialSessionConfig, LODY_CAPABILITIES, lodyMeta, object, SESSION_CAPABILITIES, sessionSteering, steerRequest, worktreeProject } from "./acp-lody.ts";
import { LODY_EXTENSION_METHODS, type LodySessionMeta, type RateLimitsSnapshot } from "acp-extension-core";
import { sessionActivityStream } from "./acp-activity.ts";
import { codexRateLimitEvent, codexRateLimits, codexSubscription } from "./acp-rate-limits.ts";
import { z } from "zod";
import type { SessionTurn } from "./session-turns.ts";
import { promptSession, type LiveSession } from "./acp-prompt.ts";
import { askUserTool } from "./acp-elicitation.ts";

export interface AcpOptions {
  home: string;
  models: Models;
  choose: () => Promise<ModelChoice>;
}


type Update = acp.SessionUpdate;

function availableCommands(skills: readonly SkillCommand[]): Update {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact the conversation context" }, ...skills.map(({ name, description }) => ({ name, description }))],
  };
}


export function createAcpApp(options: AcpOptions, sessions = new Map<string, LiveSession>()): acp.AgentApp {
  let booleanSupported = false;
  let compactionSupported = false;
  let elicitationSupported = false;
  let answerNotes = false;
  let rateLimits: RateLimitsSnapshot | undefined;
  const opening = new Set<string>();

  const snapshot = (selection: AcpSelection) => configurationSnapshot(options.models, selection, booleanSupported);

  const sessionOpenError = (error: unknown, sessionId?: string) => {
    const detail = error instanceof Error ? error.message : String(error);
    const io = error as NodeJS.ErrnoException | null;
    if (sessionId && io?.code === "ENOENT" && io.path === join(options.home, "sessions", `${sessionId}.jsonl`)) return acp.RequestError.resourceNotFound(sessionId);
    return io?.code ? acp.RequestError.internalError(undefined, detail) : acp.RequestError.invalidParams(undefined, detail);
  };

  const open = async (cwd: string, start: () => { log: SessionLog; lockAcquired?: boolean; messages: AgentMessage[]; history?: AgentMessage[]; usageMessages?: AgentMessage[]; origins?: Origin[]; inputs?: ReadonlyMap<string, Record<string, unknown>>; turns?: SessionTurn[] }, servers: acp.McpServer[], signal: AbortSignal, client: acp.AgentContext, settings?: { requireCwd?: boolean; newLog?: boolean; selection?: AcpSelection; meta?: acp.NewSessionRequest["_meta"] }) => {
    const originProjectPath = worktreeProject(settings?.meta);
    let choice: ModelChoice;
    let prompt: ReturnType<typeof systemPrompt>;
    try {
      choice = settings?.selection ?? await options.choose();
      if (settings?.requireCwd) realpathSync(cwd);
      prompt = systemPrompt(cwd);
    } catch (error) {
      throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    }
    const hooks = loadHooks(options.home);
    const { selection, normalizedThinking } = await initialSessionConfig(options.models, { ...choice, fast: settings?.selection?.fast ?? false }, settings?.meta, booleanSupported);
    const configuration = await snapshot(selection);
    const mcp = await connectMcp({ home: options.home, cwd, servers, signal });
    let openedLog: SessionLog | undefined;
    let lockAcquired = false;
    try {
      signal.throwIfAborted();
      const opened = start();
      const { log, messages, history = messages, usageMessages = messages, origins, inputs, turns } = opened;
      openedLog = log;
      lockAcquired = opened.lockAcquired ?? settings?.newLog ?? false;
      log.recordOriginProject(originProjectPath);
      const tools = [...mcp.tools, ...(elicitationSupported ? [askUserTool(log.id, client, answerNotes, async (waiting) => { await live.reportActivity?.(waiting ? "requires_action" : "running"); })] : [])];
      const reportRateLimits = async (limits: RateLimitsSnapshot | undefined) => {
        if (!limits) return;
        rateLimits = limits;
        await live.reportRateLimits?.(limits);
      };
      const agent = createRxAgent({ ...selection, models: options.models, cwd: log.cwd, systemPrompt: prompt.prompt, log, origin: "acp", messages, fast: () => live.selection.fast, tools, hooks, onUsage: (message) => live.reportUsage?.(message),
        onResponse: (response, model) => reportRateLimits(codexRateLimits(response, model)),
        onProviderStreamEvent: (event, model) => reportRateLimits(codexRateLimitEvent(event, model)),
      });
      await hookControl(agent)?.start(origins ? "resume" : "startup", signal);
      const live: LiveSession = { agent, log, selection, mcp, commands: prompt.commands, steering: sessionSteering(agent), usage: new SessionUsage(), running: false, manual: false, cancelled: false, configuring: false };
      if (normalizedThinking) await client.notify(acp.methods.client.session.update, { sessionId: log.id, update: { sessionUpdate: "config_option_update", configOptions: configuration.configOptions } });
      sessions.set(log.id, live);
      return { live, history, usageMessages, origins, inputs, turns, configuration };
    } catch (error) {
      try {
        if (openedLog) {
          if (settings?.newLog) rmSync(openedLog.path, { force: true });
          if (lockAcquired) unlockSession(options.home, openedLog.id);
        }
      } catch {} finally {
        await mcp.close();
      }
      throw error;
    }
  };

  const get = (sessionId: string): LiveSession => {
    const live = sessions.get(sessionId);
    if (!live) throw acp.RequestError.resourceNotFound(sessionId);
    return live;
  };

  return acp
    .agent({ name: "rx" })
    .onConnect((connection) => {
      connection.signal.addEventListener("abort", () => {
        for (const live of sessions.values()) {
          live.steering.clear();
          live.agent.abort();
          const control = contextControl(live.agent);
          control.abort();
          void Promise.allSettled([live.agent.waitForIdle(), control.waitForIdle()]).then(() => live.mcp.close());
        }
      }, { once: true });
    })
    .onRequest(acp.methods.agent.initialize, async ({ params }) => {
      booleanSupported = params.clientCapabilities?.session?.configOptions?.boolean != null;
      compactionSupported = params.clientCapabilities?.session?.compaction != null;
      elicitationSupported = params.clientCapabilities?.elicitation?.form != null;
      const elicitation = object(object(params.clientCapabilities?._meta?.lody)?.elicitation);
      answerNotes = elicitation?.version === 1 && elicitation.answerNotes === true;
      const available = await options.models.getAvailable();
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: available.some((model) => model.input.includes("image")), audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: SESSION_CAPABILITIES,
          _meta: lodyMeta(LODY_CAPABILITIES),
        },
        authMethods: [],
        agentInfo: { name: "rx", title: "Rx", version: VERSION },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params, client, signal }) => {
      const { live, configuration } = await open(params.cwd, () => ({ log: SessionLog.create(options.home, params.cwd), messages: [] }), params.mcpServers, signal, client, { requireCwd: true, newLog: true, meta: params._meta });
      await client.notify(acp.methods.client.session.update, { sessionId: live.log.id, update: availableCommands(live.commands) });
      return { sessionId: live.log.id, ...configuration };
    })
    .onRequest(acp.methods.agent.session.fork, async ({ params, client, signal }) => {
      const turnId = forkTurnId(params._meta);
      try {
        readSessionHeader(options.home, params.sessionId);
      } catch (error) {
        throw sessionOpenError(error, params.sessionId);
      }
      const { live, configuration } = await open(params.cwd, () => {
        try {
          const loaded = SessionLog.fork(options.home, params.sessionId, params.cwd, turnId);
          return { ...loaded, origins: loaded.entries.filter((entry) => entry.purpose !== "compaction").map((entry) => entry.origin) };
        } catch (error) {
          throw sessionOpenError(error, params.sessionId);
        }
      }, params.mcpServers ?? [], signal, client, { requireCwd: true, newLog: true, selection: sessions.get(params.sessionId)?.selection, meta: params._meta });
      await client.notify(acp.methods.client.session.update, { sessionId: live.log.id, update: availableCommands(live.commands) });
      return { sessionId: live.log.id, ...configuration };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client, signal }) => {
      const previous = sessions.get(params.sessionId);
      if (opening.has(params.sessionId) || previous?.running || previous?.configuring) throw acp.RequestError.invalidRequest(undefined, "session is running or changing configuration");
      let cwd: string;
      try {
        ({ cwd } = readSessionHeader(options.home, params.sessionId));
      } catch (error) {
        throw sessionOpenError(error);
      }
      if (cwd !== params.cwd) throw acp.RequestError.invalidParams(undefined, `session ${params.sessionId} belongs to ${cwd}, not ${params.cwd}`);
      opening.add(params.sessionId);
      if (previous) previous.configuring = true;
      try {
        const { live, history, usageMessages, origins, inputs, turns, configuration } = await open(cwd, () => {
          try {
            const loaded = SessionLog.open(options.home, params.sessionId);
            return { ...loaded, origins: loaded.entries.filter((entry) => entry.purpose !== "compaction").map((entry) => entry.origin) };
          } catch (error) {
            throw sessionOpenError(error);
          }
        }, params.mcpServers, signal, client, { meta: params._meta });
        live.configuring = true;
        try {
          await previous?.mcp.close();
          for (const update of historyUpdates(cwd, history, origins, inputs, turns)) {
            await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
          }
          const usage = latestUsageUpdate(usageMessages, live.selection.model);
          if (usage) await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: usage });
          await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: availableCommands(live.commands) });
          return configuration;
        } finally {
          live.configuring = false;
        }
      } finally {
        opening.delete(params.sessionId);
        if (previous) previous.configuring = false;
      }
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params, client }) => {
      const live = get(params.sessionId);
      if (live.running || live.configuring) throw acp.RequestError.invalidRequest(undefined, "session is running or changing configuration");
      if (params.configId === "fast" && !booleanSupported) throw acp.RequestError.invalidParams(undefined, "client does not support boolean configuration options");
      live.configuring = true;
      try {
        const selection = await changeSessionConfig(options.models, live.selection, supportsFast, params.configId, params.value);
        const response = await snapshot(selection);
        live.selection = selection;
        live.agent.state.model = selection.model;
        live.agent.state.thinkingLevel = selection.thinking;
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: response.configOptions } });
        return response;
      } finally {
        live.configuring = false;
      }
    })
    .onRequest(acp.methods.agent.session.list, ({ params }) => ({
      sessions: listSessions(options.home, params.cwd ?? undefined).map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
        ...(s.originProjectPath ? { _meta: lodyMeta({ worktreeProject: { version: 1, originProjectPath: s.originProjectPath } } satisfies LodySessionMeta) } : {}),
      })),
    }))
    .onRequest(LODY_EXTENSION_METHODS.sessionSteer, steerRequest, ({ params, client }) => {
      const live = sessions.get(params.sessionId);
      if (!live?.running || live.manual || live.cancelled) throw acp.RequestError.invalidRequest(undefined, "session has no running prompt");
      return live.steering.inject(params, client);
    })
    .onRequest(LODY_EXTENSION_METHODS.rateLimitsGet, z.object({ sessionId: z.string().optional(), accountId: z.string().optional(), modelId: z.string().optional() }), ({ params }) => {
      if (params.accountId) return { rateLimits: [] };
      const live = params.sessionId ? sessions.get(params.sessionId) : undefined;
      const supported = live && codexSubscription(live.selection.model)
        && (!params.modelId || params.modelId === live.selection.model.id || params.modelId === formatModel(live.selection.model));
      return supported && rateLimits ? rateLimits : { rateLimits: [] };
    })
    .onRequest(acp.methods.agent.session.prompt, ({ params, client, signal }) => promptSession(get(params.sessionId), params, client, signal, compactionSupported))
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const live = sessions.get(params.sessionId);
      if (!live?.running) return;
      live.cancelled = true;
      live.steering.clear();
      live.agent.abort();
      contextControl(live.agent).abort();
    });
}

export function serveAcp(options: AcpOptions): { closed: Promise<void>; stop: () => Promise<void> } {
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const sessions = new Map<string, LiveSession>();
  const connection = createAcpApp(options, sessions).connect(sessionActivityStream(acp.ndJsonStream(output, input)));
  const closed = connection.closed.then(async () => {
    await Promise.all([...sessions.values()].map(async (live) => {
      const control = contextControl(live.agent);
      live.steering.clear();
      live.agent.abort();
      control.abort();
      await Promise.allSettled([live.agent.waitForIdle(), control.waitForIdle()]);
      await live.mcp.close();
    }));
  });
  return {
    closed,
    stop: () => {
      connection.close();
      return closed;
    },
  };
}
