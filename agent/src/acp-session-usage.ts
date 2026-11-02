import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { lodyMeta } from "./acp-lody.ts";

export const SESSION_USAGE_METHOD = "_lody/session/usage_update";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  costUSD?: number;
}

export interface SessionUsageUpdate {
  sessionId: string;
  usage: ModelUsage;
  modelUsage: Record<string, ModelUsage>;
  delta: { usage: ModelUsage; modelUsage: Record<string, ModelUsage> };
  _meta: ReturnType<typeof lodyMeta<{ usageScopeId: string }>>;
}

const counters = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] as const;

function addUsage(previous: ModelUsage, next: ModelUsage): ModelUsage {
  const result: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  for (const key of counters) {
    if (previous[key] !== undefined || next[key] !== undefined) result[key] = (previous[key] ?? 0) + (next[key] ?? 0);
  }
  if (previous.costUSD !== undefined && next.costUSD !== undefined) result.costUSD = previous.costUSD + next.costUSD;
  return result;
}

export class SessionUsage {
  private readonly scopeId = randomUUID();
  private readonly totals = new Map<string, ModelUsage>();

  record(sessionId: string, message: AssistantMessage, costKnown = true): SessionUsageUpdate | undefined {
    const source = message.usage;
    if (!source || !message.provider || !message.model) return undefined;
    const counts = [source.input, source.output, source.cacheRead, source.cacheWrite];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return undefined;
    if (source.reasoning !== undefined && (!Number.isSafeInteger(source.reasoning) || source.reasoning < 0 || source.reasoning > source.output)) return undefined;
    const usage: ModelUsage = {
      inputTokens: source.input,
      outputTokens: source.output - (source.reasoning ?? 0),
      cacheReadInputTokens: source.cacheRead,
      cacheCreationInputTokens: source.cacheWrite,
      ...(source.reasoning === undefined ? {} : { reasoningOutputTokens: source.reasoning }),
      ...(costKnown && Number.isFinite(source.cost?.total) && source.cost.total >= 0 ? { costUSD: source.cost.total } : {}),
    };
    const model = `${message.provider}/${message.model}`;
    const previous = this.totals.get(model);
    const total = previous ? addUsage(previous, usage) : { ...usage };
    if (counters.some((key) => !Number.isSafeInteger(total[key] ?? 0))) return undefined;
    this.totals.set(model, total);
    const delta = { ...usage };
    if (total.costUSD === undefined) delete delta.costUSD;
    return structuredClone({
      sessionId, usage, modelUsage: Object.fromEntries(this.totals),
      delta: { usage: delta, modelUsage: { [model]: delta } },
      _meta: lodyMeta({ usageScopeId: this.scopeId }),
    });
  }
}
