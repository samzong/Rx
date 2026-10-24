import { clampThinkingLevel, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelChoice {
  model: Model<Api>;
  thinking: ThinkingLevel;
}

export function formatModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function parseThinking(value: string | undefined): ThinkingLevel {
  if (value === undefined) return "medium";
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`unknown thinking level "${value}"; expected one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevel;
}

export async function resolveModel(models: Models, spec: string | undefined, thinking: string | undefined): Promise<ModelChoice> {
  if (!spec) {
    const available = (await models.getAvailable()).map(formatModel);
    const hint = available.length
      ? `models with credentials: ${available.slice(0, 20).join(", ")}${available.length > 20 ? ", ..." : ""}`
      : "no provider credentials found; set a provider API key environment variable";
    throw new Error(`no model selected; pass --model provider/id, set RX_MODEL, or set "model" in config.json (${hint})`);
  }
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`invalid model "${spec}"; expected provider/id`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  if (!models.getProvider(provider)) throw new Error(`unknown provider "${provider}"`);
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`unknown model "${id}" for provider "${provider}"; run "rx-agent models" to list models`);
  if (!(await models.checkAuth(provider))) {
    throw new Error(`no credentials for provider "${provider}"; set its API key environment variable`);
  }
  const level = parseThinking(thinking);
  return { model, thinking: level === "off" ? "off" : (clampThinkingLevel(model, level) as ThinkingLevel) };
}
