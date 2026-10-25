import type * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export function usageUpdate(message: AssistantMessage, model: Model<Api>): acp.SessionUpdate | undefined {
  if (message.provider !== model.provider || message.model !== model.id || message.api !== model.api) return undefined;
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return undefined;
  const tokens = [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite];
  if (tokens.some((count) => !Number.isSafeInteger(count) || count < 0)) return undefined;
  const used = tokens.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(used) || used === 0) return undefined;
  return { sessionUpdate: "usage_update", used, size: model.contextWindow };
}

export function latestUsageUpdate(messages: AgentMessage[], model: Model<Api>): acp.SessionUpdate | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const update = usageUpdate(message, model);
    if (update) return update;
  }
  return undefined;
}
