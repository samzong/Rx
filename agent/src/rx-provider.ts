import { createProvider, envApiKeyAuth, type Api, type Model, type MutableModels, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { THINKING_LEVELS } from "./models.ts";

export const PROVIDER_ENV = "RX_AGENT_PROVIDER";
const DEFAULT_MAX_TOKENS = 16_384;
const APIS = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi } as const;
type HandoffApi = keyof typeof APIS;

interface HandoffModel {
  id: string;
  name?: string;
  contextWindow: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface Handoff {
  id: string;
  name: string;
  api: HandoffApi;
  baseUrl: string;
  env: string;
  models: HandoffModel[];
}

function fail(message: string): never {
  throw new Error(`${PROVIDER_ENV}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) fail(`${path} must be a non-empty string`);
  return value;
}

function parseLevels(value: unknown, path: string): ThinkingLevelMap {
  const levels = record(value, path);
  for (const [level, wire] of Object.entries(levels)) {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) fail(`${path} has unknown level "${level}"`);
    if (wire !== null && typeof wire !== "string") fail(`${path}.${level} must be a string or null`);
  }
  return levels as ThinkingLevelMap;
}

function parseModel(value: unknown, path: string): HandoffModel {
  const raw = record(value, path);
  const contextWindow = raw.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    fail(`${path}.contextWindow must be a positive integer`);
  }
  if (typeof raw.reasoning !== "boolean") fail(`${path}.reasoning must be a boolean`);
  return {
    id: text(raw.id, `${path}.id`),
    name: raw.name === undefined ? undefined : text(raw.name, `${path}.name`),
    contextWindow,
    reasoning: raw.reasoning,
    thinkingLevelMap: raw.thinkingLevelMap === undefined ? undefined : parseLevels(raw.thinkingLevelMap, `${path}.thinkingLevelMap`),
  };
}

export function parseHandoff(source: string): Handoff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    fail(`invalid JSON: ${(error as Error).message}`);
  }
  const raw = record(parsed, "document");
  const api = text(raw.api, "api");
  if (!Object.hasOwn(APIS, api)) fail(`unsupported api "${api}"`);
  if (!Array.isArray(raw.models) || !raw.models.length) fail("models must be a non-empty array");
  return {
    id: text(raw.id, "id"),
    name: text(raw.name, "name"),
    api: api as HandoffApi,
    baseUrl: text(raw.baseUrl, "baseUrl"),
    env: text(raw.env, "env"),
    models: raw.models.map((model, index) => parseModel(model, `models[${index}]`)),
  };
}

function endpoint(url: string | undefined): string | undefined {
  return url?.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function applyHandoff(models: MutableModels, handoff: Handoff): void {
  const builtin = models.getProvider(handoff.id);
  const known =
    builtin && endpoint(builtin.baseUrl) === endpoint(handoff.baseUrl)
      ? models.getModels(handoff.id).filter((model) => model.api === handoff.api)
      : [];
  const list: Model<Api>[] = handoff.models.map(
    (model) =>
      known.find((candidate) => candidate.id === model.id) ?? {
        id: model.id,
        name: model.name ?? model.id,
        api: handoff.api,
        provider: handoff.id,
        baseUrl: handoff.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: DEFAULT_MAX_TOKENS,
      },
  );
  models.setProvider(
    createProvider({
      id: handoff.id,
      name: handoff.name,
      baseUrl: handoff.baseUrl,
      auth: { apiKey: envApiKeyAuth(`${handoff.name} API key`, [handoff.env]) },
      models: list,
      api: APIS[handoff.api](),
    }),
  );
}
