import * as acp from "@agentclientprotocol/sdk/unstable";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LODY_EXTENSION_METHODS, type LodySessionActivityState, type RateLimitsSnapshot } from "acp-extension-core";
import type { AcpSelection } from "./acp-state.ts";
import { formatModel } from "./models.ts";
import { SESSION_USAGE_METHOD, SessionUsage } from "./acp-session-usage.ts";
import type { SessionLog } from "./session-log.ts";
import type { McpConnection } from "./mcp.ts";
import { hasKnownModelCost } from "./rx-provider.ts";
import { contextControl } from "./context-control.ts";
import { hookControl } from "./hooks.ts";
import { isProviderFailure, retryControl } from "./retry.ts";
import { expandSkillCommand, type SkillCommand } from "./skills.ts";
import { compactionUpdate, eventUpdates, promptInput, retryUpdate, toolInputUpdate } from "./acp-messages.ts";
import { sessionSteering, turnUpdate } from "./acp-lody.ts";
import { usageUpdate } from "./acp-usage.ts";
import { activityUpdate } from "./acp-activity.ts";

export interface LiveSession {
  agent: Agent;
  log: SessionLog;
  running: boolean;
  manual: boolean;
  cancelled: boolean;
  configuring: boolean;
  selection: AcpSelection;
  mcp: McpConnection;
  commands: SkillCommand[];
  steering: ReturnType<typeof sessionSteering>;
  usage: SessionUsage;
  reportUsage?: (message: AssistantMessage) => void;
  reportRateLimits?: (snapshot: RateLimitsSnapshot) => Promise<void>;
  reportActivity?: (state: LodySessionActivityState) => Promise<void>;
}

function stopReason(messages: AgentMessage[], cancelled: boolean): acp.StopReason {
  if (cancelled) return "cancelled";
  const last = messages.findLast((m) => m.role === "assistant");
  if (last?.role !== "assistant") return "end_turn";
  if (last.stopReason === "aborted") return "cancelled";
  if (last.stopReason === "length") return "max_tokens";
  if (last.stopReason === "error") {
    if (!isProviderFailure(last)) throw acp.RequestError.internalError(undefined, last.errorMessage);
    const detail = last.errorMessage ?? "The model request failed";
    const hint = /\b401\b|\b403\b|api.?key|unauthori[sz]ed|authentication/i.test(detail)
      ? " Check the provider credential and try again."
      : /quota|billing|balance|budget|usage.?limit/i.test(detail) ? " Check the provider balance or account limit before trying again." : "";
    const separator = hint && !/[.!?]$/.test(detail.trimEnd()) ? "." : "";
    throw new acp.RequestError(-32010, `Model provider request failed: ${detail}${separator}${hint}`, { type: "provider_error" });
  }
  return "end_turn";
}

export async function promptSession(live: LiveSession, params: acp.PromptRequest, client: acp.AgentContext, signal: AbortSignal, compactionSupported: boolean): Promise<acp.PromptResponse> {
  if (live.running || live.configuring) throw acp.RequestError.invalidRequest(undefined, "session is already running a prompt or changing configuration");
  const { text, images } = promptInput(params.prompt);
  if (images.length && !live.selection.model.input.includes("image")) throw acp.RequestError.invalidParams(undefined, `model ${formatModel(live.selection.model)} does not support image input`);
  const control = contextControl(live.agent);
  const manual = params.prompt.every((block) => block.type === "text") && text.trim() === "/compact";
  let pending = Promise.resolve();
  const abort = () => {
    live.steering.clear();
    live.agent.abort();
    control.abort();
  };
  const notify = (update: acp.SessionUpdate) => {
    pending = pending
      .then(() => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }))
      .catch(abort);
  };
  live.reportUsage = (message) => {
    const update = live.usage.record(params.sessionId, message, hasKnownModelCost(live.agent.state.model));
    if (update) pending = pending.then(() => client.notify(SESSION_USAGE_METHOD, update)).catch(abort);
  };
  live.reportActivity = async (state) => {
    pending = pending.then(() => client.notify(LODY_EXTENSION_METHODS.sessionActivityUpdate, activityUpdate(params.sessionId, state))).catch(abort);
    await pending;
  };
  live.reportRateLimits = async (snapshot) => {
    pending = pending.then(() => client.notify(LODY_EXTENSION_METHODS.rateLimitsUpdate, snapshot)).catch(abort);
    await pending;
  };
  const unsubscribe = live.agent.subscribe((event) => {
    const updates = eventUpdates(live.log.cwd, event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = usageUpdate(event.message, live.selection.model);
      if (usage) updates.push(usage);
    }
    for (const update of updates) notify(update);
    return pending;
  });
  const unsubscribeRetry = retryControl(live.agent).subscribe((event) => notify(retryUpdate(event)));
  const unsubscribeCompaction = control.subscribe((event) => notify(compactionUpdate(event, compactionSupported, live.cancelled)));
  const unsubscribeHooks = hookControl(live.agent)?.subscribe((notice) => notify("text" in notice
    ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${notice.text}\n` } }
    : toolInputUpdate(live.log.cwd, notice.toolCallId, notice.toolName, notice.input)));
  const onClose = () => {
    live.cancelled = true;
    abort();
  };
  live.manual = manual;
  live.running = true;
  live.cancelled = false;
  signal.addEventListener("abort", onClose, { once: true });
  if (signal.aborted) onClose();
  try {
    await live.reportActivity("running");
    if (!live.cancelled) {
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: turnUpdate(live.log.beginTurn()) });
      if (live.mcp.warnings.length) {
        await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${live.mcp.warnings.join("\n")}\n` } } });
        live.mcp.warnings.length = 0;
      }
      if (!live.cancelled) {
        if (manual) await control.compact();
        else await live.agent.prompt(expandSkillCommand(text, live.commands), images);
      }
    }
  } catch (error) {
    if (!live.cancelled) throw acp.RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      await Promise.all([live.agent.waitForIdle(), control.waitForIdle()]);
      unsubscribe();
      unsubscribeCompaction();
      unsubscribeRetry();
      unsubscribeHooks?.();
      live.reportUsage = undefined;
      live.reportRateLimits = undefined;
      live.reportActivity = undefined;
      await pending;
    } finally {
      signal.removeEventListener("abort", onClose);
      live.running = false;
      live.steering.clear();
      await client.notify(LODY_EXTENSION_METHODS.sessionActivityUpdate, activityUpdate(params.sessionId, "idle"));
    }
  }
  return { stopReason: (manual || hookControl(live.agent)?.rejected) ? (live.cancelled ? "cancelled" : "end_turn") : stopReason(live.agent.state.messages, live.cancelled) };
}
