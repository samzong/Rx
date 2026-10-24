import { createProvider, envApiKeyAuth, type Api, type Model, type MutableModels, type ProviderStreams, type StreamOptions, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { THINKING_LEVELS } from "./models.ts";

export const PROVIDER_ENV = "RX_AGENT_PROVIDER";
const DEFAULT_MAX_TOKENS = 16_384;
const APIS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": () => withoutPromptCacheKey(openAIResponsesApi()),
  "anthropic-messages": anthropicMessagesApi,
} as const;
type HandoffApi = keyof typeof APIS;

interface HandoffModel {
  id: string;
  name?: string;
  api?: HandoffApi;
  baseUrl?: string;
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
  defaultModel: string;
}

function withoutPromptCacheKey(api: ProviderStreams): ProviderStreams {
  const strip =
    (next: StreamOptions["onPayload"]) =>
    async (payload: unknown, model: Model<Api>): Promise<unknown> => {
      const { prompt_cache_key: _, ...rest } = ((await next?.(payload, model)) ?? payload) as Record<string, unknown>;
      return rest;
    };
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, { ...options, onPayload: strip(options?.onPayload) }),
    streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, onPayload: strip(options?.onPayload) }),
  };
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

function parseApi(value: unknown, path: string): HandoffApi {
  const api = text(value, path);
  if (!Object.hasOwn(APIS, api)) fail(`unsupported ${path} "${api}"`);
  return api as HandoffApi;
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
    api: raw.api === undefined ? undefined : parseApi(raw.api, `${path}.api`),
    baseUrl: raw.baseUrl === undefined ? undefined : text(raw.baseUrl, `${path}.baseUrl`),
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
  const api = parseApi(raw.api, "api");
  if (!Array.isArray(raw.models) || !raw.models.length) fail("models must be a non-empty array");
  const models = raw.models.map((model, index) => parseModel(model, `models[${index}]`));
  const defaultModel = text(raw.defaultModel, "defaultModel");
  if (!models.some((model) => model.id === defaultModel)) fail(`defaultModel "${defaultModel}" is not in models`);
  return {
    id: text(raw.id, "id"),
    name: text(raw.name, "name"),
    api,
    baseUrl: text(raw.baseUrl, "baseUrl"),
    env: text(raw.env, "env"),
    models,
    defaultModel,
  };
}

function endpoint(url: string | undefined): string | undefined {
  return url?.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function applyHandoff(models: MutableModels, handoff: Handoff): void {
  const builtin = models.getProvider(handoff.id);
  const list: Model<Api>[] = handoff.models.map((model) => {
    const api = model.api ?? handoff.api;
    const baseUrl = model.baseUrl ?? handoff.baseUrl;
    const known = builtin
      ? models
          .getModels(handoff.id)
          .find(
            (candidate) =>
              candidate.id === model.id && candidate.api === api && endpoint(candidate.baseUrl) === endpoint(baseUrl)
          )
      : undefined;
    return (
      known ?? {
        id: model.id,
        name: model.name ?? model.id,
        api,
        provider: handoff.id,
        baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        compat: api === "anthropic-messages" && model.thinkingLevelMap ? { forceAdaptiveThinking: true } : undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: DEFAULT_MAX_TOKENS,
      }
    );
  });
  const apis = [...new Set(list.map((model) => model.api as HandoffApi))];
  models.setProvider(
    createProvider({
      id: handoff.id,
      name: handoff.name,
      baseUrl: handoff.baseUrl,
      auth: { apiKey: envApiKeyAuth(`${handoff.name} API key`, [handoff.env]) },
      models: list,
      api: Object.fromEntries(apis.map((api) => [api, APIS[api]()])),
    }),
  );
}
