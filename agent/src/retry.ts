import { randomUUID } from "node:crypto";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";

export interface RetryEvent {
  id: string;
  status: "in_progress" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

const listeners = new WeakMap<Agent, Set<(event: RetryEvent) => void>>();
const providerFailures = new WeakSet<AssistantMessage>();

export function isProviderFailure(message: AssistantMessage): boolean {
  return providerFailures.has(message);
}

export function retryControl(agent: Agent) {
  let subscriptions = listeners.get(agent);
  if (!subscriptions) {
    subscriptions = new Set();
    listeners.set(agent, subscriptions);
  }
  return {
    subscribe(listener: (event: RetryEvent) => void): () => void {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
    emit(event: RetryEvent): void {
      for (const listener of subscriptions) listener(event);
    },
  };
}

function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted", errorMessage: "Request was aborted", timestamp: Date.now(),
  };
}

function permanentFailure(message: AssistantMessage, diagnostic?: string): boolean {
  const text = message.errorMessage ?? "";
  const status = /^\s*(?:HTTP\s+)?(4\d\d)\b/i.exec(text)?.[1];
  return Boolean(status && !["408", "409", "429"].includes(status))
    || /invalid.?api.?key|unauthori[sz]ed|authentication|forbidden|context_length_exceeded|context_window_exceeded|prompt is too long/i.test(text)
    || /CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_VERIFY|SELF_SIGNED|UNKNOWN_CERTIFICATE/.test(diagnostic ?? "");
}

export function retryStream(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  request: (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  takeFailure: () => string | undefined,
  record: (message: AssistantMessage) => void,
  emit: (event: RetryEvent) => void,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const iterator = stream[Symbol.asyncIterator].bind(stream);
  let forwarded = 0;
  let consumed = 0;
  let drained: (() => void) | undefined;
  const waitForOutput = () => consumed === forwarded ? Promise.resolve() : new Promise<void>((resolve) => { drained = resolve; });
  stream[Symbol.asyncIterator] = async function* () {
    for await (const event of { [Symbol.asyncIterator]: iterator }) {
      yield event;
      consumed++;
      if (consumed === forwarded) { drained?.(); drained = undefined; }
    }
  };
  const id = randomUUID();
  let started = false;
  let latest = emptyMessage(model);
  let diagnostic: string | undefined;
  let waiting = false;
  let activity: RetryEvent | undefined;
  const safeMessage = () => diagnostic && latest.stopReason === "error" ? { ...latest, errorMessage: diagnostic } : latest;
  void (async () => {
    const result = await retryAssistantCall(async () => {
      if (options?.signal?.aborted) return latest = emptyMessage(model);
      const response = await request(model, context, { ...options, maxRetries: 0 });
      for await (const event of response) {
        if (event.type === "done" || event.type === "error") continue;
        if (event.type === "start") {
          if (started) continue;
          started = true;
        }
        forwarded++;
        stream.push(event);
      }
      latest = await response.result();
      diagnostic = takeFailure();
      if (latest.stopReason === "aborted" || options?.signal?.aborted) {
        latest = { ...latest, stopReason: "aborted", content: latest.content.filter((block) => block.type !== "toolCall") };
      }
      return permanentFailure(latest, diagnostic) ? { ...latest, errorMessage: "The model request cannot be retried" } : latest;
    }, { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, options?.signal, {
      onRetryScheduled: async (attempt, maxAttempts, delayMs) => {
        await waitForOutput();
        record(safeMessage());
        waiting = true;
        activity = { id, status: "in_progress", attempt, maxAttempts, delayMs };
        emit(activity);
      },
      onRetryAttemptStart: () => { waiting = false; },
      onRetryFinished: async (success) => {
        await waitForOutput();
        if (activity) emit({ ...activity, status: success ? "completed" : "failed", delayMs: 0 });
        activity = undefined;
      },
    });
    const message = result.stopReason === "aborted" || options?.signal?.aborted
      ? waiting ? emptyMessage(model) : { ...latest, stopReason: "aborted" as const, content: latest.content.filter((block) => block.type !== "toolCall") }
      : safeMessage();
    if (message.stopReason === "pending") { message.stopReason = "error"; message.errorMessage = "The model response did not complete"; }
    if (message.stopReason === "error") providerFailures.add(message);
    if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
    else stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
  })().catch((error: unknown) => {
    if (activity) emit({ ...activity, status: "failed", delayMs: 0 });
    const message = { ...emptyMessage(model), stopReason: "error" as const, errorMessage: error instanceof Error ? error.message : "Model request failed" };
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  });
  return stream;
}
