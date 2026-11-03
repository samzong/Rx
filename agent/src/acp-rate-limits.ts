import type { Api, Model, ProviderResponse } from "@earendil-works/pi-ai";
import type { RateLimit, RateLimitWindow, RateLimitsSnapshot } from "acp-extension-core";

export function codexSubscription(model: Model<Api>): boolean {
  return model.provider === "openai-codex" && model.api === "openai-codex-responses"
    && model.baseUrl.replace(/\/$/, "") === "https://chatgpt.com/backend-api";
}

export function codexRateLimits(response: ProviderResponse, model: Model<Api>, now = Date.now()): RateLimitsSnapshot | undefined {
  if (!codexSubscription(model)) return;
  const headers = new Headers(response.headers);
  const prefixes = new Set(["codex"]);
  for (const name of headers.keys()) {
    const match = /^x-(.+)-primary-used-percent$/.exec(name);
    if (match) prefixes.add(match[1]!);
  }
  const number = (name: string, integer = false): number | null => {
    const raw = headers.get(name)?.trim();
    if (!raw || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || (integer && !/^\d+$/.test(raw))) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
  };
  const rateLimits: RateLimit[] = [];
  for (const prefix of prefixes) {
    const windows: RateLimitWindow[] = [];
    const label = headers.get(`x-${prefix}-limit-name`)?.trim();
    for (const kind of ["primary", "secondary"]) {
      const name = `x-${prefix}-${kind}`;
      const usedPercent = number(`${name}-used-percent`);
      if (usedPercent === null || usedPercent > 100) continue;
      const minutes = number(`${name}-window-minutes`, true);
      const duration = minutes === null || minutes === 0 || !Number.isSafeInteger(minutes * 60) ? null : minutes * 60;
      windows.push({ ...(label ? { label } : {}), usedPercent, windowDurationSeconds: duration, resetsAtEpochSeconds: number(`${name}-reset-at`, true) });
    }
    if (windows.length) rateLimits.push({ limitId: prefix.replaceAll("-", "_"), scope: { providerId: model.provider }, ...(label ? { limitName: label } : {}), windows });
  }
  return rateLimits.length ? { rateLimits, fetchedAtEpochSeconds: Math.floor(now / 1000) } : undefined;
}
