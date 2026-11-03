import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { z } from "zod";
import { LODY_EXTENSION_METHODS, type LodyExtensionCapabilities, type LodySessionMeta, type LodySteerRequest, type LodySteerResponse } from "acp-extension-core";
import { changeSessionConfig } from "./acp-config.ts";
import { supportsFast } from "./acp-fast.ts";
import { promptInput } from "./acp-messages.ts";
import type { AcpSelection } from "./acp-state.ts";

export const LODY_CAPABILITIES = {
  steering: { version: 1, transport: "request", upstreamTurn: "same", configPolicy: "active" },
  worktreeProject: { version: 1 },
  usage: { version: 1 },
  forkAtTurn: { version: 1 },
  sessionActivity: { version: 1 },
  rateLimits: { version: 1 },
} as const satisfies LodyExtensionCapabilities;

export const steerRequest = z.object({
  sessionId: z.string().min(1),
  steerId: z.string().min(1),
  prompt: z.array(z.custom<acp.ContentBlock>()),
}) satisfies z.ZodType<LodySteerRequest<acp.ContentBlock>>;

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function worktreeProject(meta: unknown): string | undefined {
  const value = object(object(meta)?.lody)?.worktreeProject;
  if (value === undefined) return;
  const project = object(value);
  if (project?.version !== 1 || typeof project.originProjectPath !== "string" || !isAbsolute(project.originProjectPath) || project.originProjectPath.includes("\0")) {
    throw acp.RequestError.invalidParams(undefined, "worktreeProject requires version 1 and an absolute originProjectPath");
  }
  return project.originProjectPath;
}

export async function initialSessionConfig(models: Models, selection: AcpSelection, meta: unknown, booleanSupported: boolean): Promise<AcpSelection> {
  const config = object(object(object(meta)?.lody)?.sessionConfig);
  if (config?.version !== 1) return selection;
  const values = object(config.configOptionValues) ?? {};
  const model = typeof config.modelId === "string" && config.modelId ? config.modelId : values.model;
  if (typeof model === "string") selection = await changeSessionConfig(models, selection, supportsFast, "model", model);
  for (const id of ["thinking", "fast"]) {
    const value = values[id];
    if (value === undefined) continue;
    if (id === "fast" && !booleanSupported) throw acp.RequestError.invalidParams(undefined, "client does not support boolean configuration options");
    if (id === "fast" && value === false && !supportsFast(selection.model)) continue;
    selection = await changeSessionConfig(models, selection, supportsFast, id, value as string | boolean);
  }
  return selection;
}

export function sessionSteering(agent: Agent) {
  let lastTimestamp = 0;
  const pending = new Map<string, { message: Extract<AgentMessage, { role: "user" }>; client: acp.AgentContext; resolve: (value: { outcome: "injected" }) => void; reject: (error: unknown) => void }>();
  const stream = agent.streamFunction;
  agent.streamFunction = async (model, context, options) => {
    options?.signal?.throwIfAborted();
    const response = await stream(model, context, options);
    for (const [steerId, entry] of pending) {
      if (!context.messages.some((message) => message.role === "user" && message.timestamp === entry.message.timestamp && isDeepStrictEqual(message.content, entry.message.content))) continue;
      pending.delete(steerId);
      try {
        await entry.client.notify(LODY_EXTENSION_METHODS.sessionSteerApplied, { sessionId: agent.sessionId, steerId });
        entry.resolve({ outcome: "injected" });
      } catch (error) {
        entry.reject(error);
        agent.abort();
        throw error;
      }
    }
    return response;
  };
  return {
    inject(params: z.infer<typeof steerRequest>, client: acp.AgentContext): Promise<LodySteerResponse> {
      if (pending.has(params.steerId)) throw acp.RequestError.invalidRequest(undefined, "steerId is already pending");
      const { text, images } = promptInput(params.prompt);
      if (images.length && !agent.state.model.input.includes("image")) throw acp.RequestError.invalidParams(undefined, "the selected model does not support image input");
      const contextTimestamp = agent.state.messages.reduce((latest, message) => "timestamp" in message ? Math.max(latest, message.timestamp) : latest, lastTimestamp);
      lastTimestamp = Math.max(Date.now(), contextTimestamp + 1);
      const message: AgentMessage = { role: "user", content: [{ type: "text", text }, ...images], timestamp: lastTimestamp };
      return new Promise((resolve, reject) => {
        pending.set(params.steerId, { message, client, resolve, reject });
        agent.steer(message);
      });
    },
    clear(): void {
      agent.clearSteeringQueue();
      for (const entry of pending.values()) entry.reject(acp.RequestError.invalidRequest(undefined, "prompt ended before steer delivery"));
      pending.clear();
    },
  };
}

export const SESSION_CAPABILITIES = { list: {}, fork: {} };

export function lodyMeta<T extends Record<string, unknown>>(value: T) {
  return { lody: value };
}

const forkSchema = z.object({ version: z.literal(1), turnId: z.string().min(1).optional() }) satisfies z.ZodType<NonNullable<LodySessionMeta["forkAtTurn"]>>;

export function forkTurnId(meta: unknown): string | undefined {
  const lody = object(meta)?.lody;
  if (lody !== undefined && !object(lody)) throw acp.RequestError.invalidParams(undefined, "lody metadata requires an object");
  const value = object(lody)?.forkAtTurn;
  if (value === undefined) return undefined;
  const parsed = forkSchema.safeParse(value);
  if (!parsed.success) throw acp.RequestError.invalidParams(undefined, "forkAtTurn requires version 1 and an optional turnId");
  return parsed.data.turnId;
}

export function turnUpdate(turnId: string): acp.SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: lodyMeta({ turnId }) };
}
