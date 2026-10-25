import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

const PRIORITY_MODELS = new Set([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function supportsFast(model: Model<Api>): boolean {
  return model.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && model.baseUrl.replace(/\/$/, "") === "https://chatgpt.com/backend-api"
    && PRIORITY_MODELS.has(model.id);
}

export function fastStreamOptions(model: Model<Api>, options: SimpleStreamOptions | undefined, fast: boolean): SimpleStreamOptions | undefined {
  if (!fast || !supportsFast(model)) return options;
  return {
    ...options,
    onPayload: async (payload, requestModel) => {
      const next = await options?.onPayload?.(payload, requestModel);
      const body = next === undefined ? payload : next;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Fast mode requires an object request payload");
      return { ...body, service_tier: "priority" };
    },
  };
}
