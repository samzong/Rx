import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { lodyMeta } from "./acp-lody.ts";

const question = Type.Object({
  id: Type.String({ minLength: 1, pattern: "\\S" }),
  question: Type.String({ minLength: 1, pattern: "\\S" }),
  header: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String({ minLength: 1, pattern: "\\S" }),
    description: Type.Optional(Type.String()),
  }))),
  multiSelect: Type.Optional(Type.Boolean()),
  allowCustomAnswer: Type.Optional(Type.Boolean({ description: "Allow a free-text answer in addition to choices. Default: true." })),
});
const parameters = Type.Object({ questions: Type.Array(question, { minItems: 1, maxItems: 8 }) });
type Questions = Static<typeof parameters>["questions"];
type Answers = { answers: Record<string, string | string[]>; notes?: Record<string, string> } | { cancelled: true };

function elicitationMeta(fields: Record<string, unknown>) {
  return { _meta: lodyMeta({ elicitation: { version: 1, ...fields } }) };
}

function form(sessionId: string, toolCallId: string, questions: Questions, answerNotes: boolean): acp.CreateElicitationRequest {
  if (new Set(questions.map((item) => item.id)).size !== questions.length) throw new Error("Question ids must be unique.");
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  for (const [index, item] of questions.entries()) {
    const key = `q${index}`;
    const choices = item.options?.map((option) => ({ const: option.label, title: option.label, ...(option.description ? { description: option.description } : {}) }));
    if (choices && new Set(choices.map((option) => option.const)).size !== choices.length) throw new Error("Question option labels must be unique.");
    if (item.multiSelect && !choices?.length) throw new Error("Multiple-choice questions require options when multiSelect is true.");
    properties[key] = {
      ...(item.multiSelect ? { type: "array", items: { anyOf: choices! } } : { type: "string", ...(choices?.length ? { oneOf: choices } : {}) }),
      ...(item.header ? { title: item.header } : {}),
      description: item.question,
    };
    if (choices?.length && item.allowCustomAnswer !== false) {
      properties[`${key}_custom`] = { type: "string", ...elicitationMeta({ customAnswerFor: key }) };
    }
    if (answerNotes) {
      properties[`${key}_note`] = { type: "string", title: "Additional context", ...elicitationMeta({ noteFor: key }) };
    }
  }
  return {
    mode: "form", sessionId, toolCallId,
    message: questions.length === 1 ? questions[0]!.question : "Rx needs your input.",
    requestedSchema: { type: "object", properties },
    ...elicitationMeta({ autoResolveAfterSeconds: null }),
  };
}

function answers(response: acp.CreateElicitationResponse, questions: Questions, answerNotes: boolean): Answers {
  if (response.action !== "accept") return { cancelled: true };
  const content = (response as acp.ElicitationAcceptAction).content ?? {};
  const result: Array<[string, string | string[]]> = [];
  const notes: Array<[string, string]> = [];
  for (const [index, item] of questions.entries()) {
    const key = `q${index}`;
    const custom = item.allowCustomAnswer !== false && item.options?.length ? content[`${key}_custom`] : undefined;
    let value = typeof custom === "string" && custom.trim() ? custom : content[key];
    if (item.multiSelect && typeof value === "string" && item.options?.some((option) => option.label === value)) value = [value];
    if (value !== undefined) {
      const selected = Array.isArray(value) ? value : [value];
      if ((typeof value !== "string" && !Array.isArray(value)) || selected.some((entry) => typeof entry !== "string" || !entry.trim())
        || (!item.multiSelect && typeof value !== "string")
        || (item.multiSelect && !Array.isArray(value) && value !== custom)
        || (item.allowCustomAnswer === false && item.options?.length && selected.some((entry) => !item.options!.some((option) => option.label === entry)))) {
        throw new Error("The client returned an invalid answer.");
      }
      result.push([item.id, value as string | string[]]);
    }
    const note = answerNotes ? content[`${key}_note`] : undefined;
    if (typeof note === "string" && note.trim()) notes.push([item.id, note]);
  }
  return { answers: Object.fromEntries(result), ...(notes.length ? { notes: Object.fromEntries(notes) } : {}) };
}

export function askUserTool(sessionId: string, client: acp.AgentContext, answerNotes: boolean): AgentTool<typeof parameters, Answers> {
  return {
    name: "ask_user",
    label: "Ask user",
    executionMode: "sequential",
    description: "Ask 1 to 8 questions when a user decision is needed. Use options for choices and omit options for free text. Use multiSelect only with options. A declined or cancelled form returns cancelled: true. Do not guess an answer.",
    parameters,
    async execute(toolCallId, { questions }, signal) {
      signal?.throwIfAborted();
      const request = form(sessionId, toolCallId, questions, answerNotes);
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error("Question cancelled."));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      try {
        const response = await Promise.race([
          client.request(acp.methods.client.elicitation.create, request, { cancellationSignal: signal }),
          aborted,
        ]);
        signal?.throwIfAborted();
        const details = answers(response, questions, answerNotes);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
