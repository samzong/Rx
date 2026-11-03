import type { Api, Model, ProviderResponse } from "@earendil-works/pi-ai";
import type { RateLimit, RateLimitWindow, RateLimitsSnapshot } from "acp-extension-core";

export function codexSubscription(model: Model<Api>): boolean {
  return model.provider === "openai-codex" && model.api === "openai-codex-responses"
    && model.baseUrl.replace(/\/$/, "") === "https://chatgpt.com/backend-api";
}

function rateLimitWindow(usedPercent: unknown, minutes: unknown, resetAt: unknown): RateLimitWindow | undefined {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return;
  const duration = typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes > 0 && Number.isSafeInteger(minutes * 60) ? minutes * 60 : null;
  const resetsAtEpochSeconds = typeof resetAt === "number" && Number.isSafeInteger(resetAt) && resetAt >= 0 ? resetAt : null;
  return { usedPercent, windowDurationSeconds: duration, resetsAtEpochSeconds };
}

export function codexRateLimitEvent(data: unknown, model: Model<Api>, now = Date.now()): RateLimitsSnapshot | undefined {
  if (!codexSubscription(model) || typeof data !== "object" || data === null) return;
  const event = data as Record<string, unknown>;
  if (event.type !== "codex.rate_limits" || typeof event.rate_limits !== "object" || event.rate_limits === null) return;
  const details = event.rate_limits as Record<string, unknown>;
  const windows = ["primary", "secondary"].flatMap((kind) => {
    const value = details[kind];
    if (typeof value !== "object" || value === null) return [];
    const window = value as Record<string, unknown>;
    const parsed = rateLimitWindow(window.used_percent, window.window_minutes, window.reset_at);
    return parsed ? [parsed] : [];
  });
  if (!windows.length) return;
  const name = typeof event.metered_limit_name === "string" ? event.metered_limit_name : typeof event.limit_name === "string" ? event.limit_name : "codex";
  const limitId = name.trim().toLowerCase().replaceAll("-", "_");
  return { rateLimits: [{ limitId, scope: { providerId: model.provider }, windows }], fetchedAtEpochSeconds: Math.floor(now / 1000) };
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
      const parsed = rateLimitWindow(number(`${name}-used-percent`), number(`${name}-window-minutes`, true), number(`${name}-reset-at`, true));
      if (parsed) windows.push({ ...(label ? { label } : {}), ...parsed });
    }
    if (windows.length) rateLimits.push({ limitId: prefix.replaceAll("-", "_"), scope: { providerId: model.provider }, ...(label ? { limitName: label } : {}), windows });
  }
  return rateLimits.length ? { rateLimits, fetchedAtEpochSeconds: Math.floor(now / 1000) } : undefined;
}
