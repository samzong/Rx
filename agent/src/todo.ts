import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Check } from "typebox/value";

const entry = Type.Object({
  content: Type.String({ minLength: 1, pattern: "\\S" }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
});
const parameters = Type.Object({ entries: Type.Array(entry, { description: "The complete task list, replacing the previous list. Use an empty list to clear it." }) });
const snapshot = Type.Object({ version: Type.Literal(1), entries: Type.Array(entry) });

export function todoTool(): AgentTool<typeof parameters, { version: 1; entries: PlanEntry[] }> {
  return {
    name: "todo",
    label: "Todo",
    executionMode: "sequential",
    description: "Replace the complete task list. Update it when work starts, finishes, or changes. Keep completed tasks in the list. This tool does not execute tasks.",
    parameters,
    async execute(_id, { entries }, signal) {
      signal?.throwIfAborted();
      const plan = entries.map(({ content, status, priority }) => ({ content, status, priority: priority ?? "medium" }));
      const text = plan.length ? plan.map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.content}`).join("\n") : "Task list cleared.";
      return { content: [{ type: "text", text }], details: { version: 1, entries: plan } };
    },
  };
}

export function todoUpdate(details: unknown): SessionUpdate | undefined {
  if (!Check(snapshot, details)) return undefined;
  return { sessionUpdate: "plan", entries: details.entries.map((item) => ({ ...item, priority: item.priority ?? "medium" })) };
}
