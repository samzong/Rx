import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { danglingToolCalls } from "./session-log.ts";
import { messageSources, clearedMessage, rawMessageSeq, setMessageSources, type SourceRange } from "./context-source.ts";
import { mergeSources, sourceLabel } from "./context-citations.ts";
import { messageTokens, total, transcript, textTokens, visibleMessage } from "./context-messages.ts";

export const MAX_SUMMARY_CALLS = 8;

export function contextBudget(model: Model<Api>): { ceiling: number; summary: number; recent: number; reserve: number } {
  const reserve = Math.min(model.maxTokens, Math.max(256, Math.floor(model.contextWindow * 0.1)));
  const ceiling = Math.max(1, Math.floor(Math.min(model.contextWindow * 0.8, model.contextWindow - 4096 - reserve)));
  return {
    ceiling,
    summary: Math.max(1, Math.min(4096, model.maxTokens, Math.floor(ceiling * 0.1))),
    recent: Math.max(0, Math.min(20000, Math.floor(ceiling * 0.25))),
    reserve,
  };
}

function boundaries(messages: AgentMessage[]): number[] {
  const pending = new Set<string>();
  const result = [0];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
    if (pending.size === 0) result.push(index + 1);
  }
  return result;
}

function latestCompletedToolStart(messages: AgentMessage[]): number {
  const pending = new Set<string>();
  let start = messages.length;
  let latest = messages.length;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const calls = message.content.filter((block) => block.type === "toolCall");
      if (calls.length && !pending.size) start = index;
      for (const call of calls) pending.add(call.id);
    } else if (message.role === "toolResult" && pending.delete(message.toolCallId) && !pending.size) latest = start;
  }
  return latest;
}

function splitText(text: string, budget: number): string[] {
  if (budget < 64) throw new Error("The model context window is too small for a summary request");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let low = 1;
    let high = text.length - offset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (textTokens(text.slice(offset, offset + mid)) <= budget) low = mid;
      else high = mid - 1;
    }
    let end = offset + low;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff && end < text.length) end--;
    if (end === offset) throw new Error("The model context window is too small for a summary request");
    chunks.push(text.slice(offset, end));
    if (chunks.length > MAX_SUMMARY_CALLS) throw new Error(`Context compaction needs more than ${MAX_SUMMARY_CALLS} summary requests. The original history is unchanged`);
    offset = end;
  }
  return chunks;
}

function sourceChunks(messages: AgentMessage[], budget: number): { text: string; sources: SourceRange[] }[] {
  const chunks: { text: string; sources: SourceRange[] }[] = [];
  for (const message of messages) {
    const body = transcript(message);
    if (!body.trim()) continue;
    const sources = messageSources(message);
    const prefix = `${sourceLabel(sources)}\n`;
    const parts = splitText(body, budget - textTokens(prefix) - 4);
    for (const part of parts) {
      const text = prefix + part;
      const previous = chunks.at(-1);
      if (previous && textTokens(`${previous.text}\n\n${text}`) <= budget) {
        previous.text += `\n\n${text}`;
        previous.sources = mergeSources([...previous.sources, ...sources]);
      } else chunks.push({ text, sources });
      if (chunks.length > MAX_SUMMARY_CALLS) throw new Error(`Context compaction needs more than ${MAX_SUMMARY_CALLS} summary requests. The original history is unchanged`);
    }
  }
  return chunks;
}

export function pruningPlan(messages: AgentMessage[], model: Model<Api>, pressure = total(messages)): { messages: AgentMessage[]; clearedSeqs: number[]; freedTokens: number } | undefined {
  const { recent, ceiling } = contextBudget(model);
  const source = messages.filter((message) => message.role !== "system");
  const cuts = boundaries(source);
  let cut = cuts.at(-1) ?? 0;
  for (const boundary of cuts) {
    if (boundary > 0 && total(source.slice(boundary)) <= recent) { cut = boundary; break; }
  }
  cut = Math.min(cut, latestCompletedToolStart(source));
  const candidates = source.slice(0, cut).flatMap((message) => {
    const seq = rawMessageSeq(message);
    if (message.role !== "toolResult" || seq === undefined) return [];
    const replacement = clearedMessage(message, seq);
    return messageTokens(replacement) < messageTokens(message) ? [{ message, replacement, seq }] : [];
  }).sort((a, b) => a.seq - b.seq);
  const replacements = new Map<AgentMessage, AgentMessage>();
  let freedTokens = 0;
  const lowWater = ceiling - recent;
  for (const candidate of candidates) {
    replacements.set(candidate.message, candidate.replacement);
    freedTokens += messageTokens(candidate.message) - messageTokens(candidate.replacement);
    if (pressure - freedTokens < lowWater) break;
  }
  if (!replacements.size || freedTokens < recent) return undefined;
  return { freedTokens, messages: messages.map((message) => replacements.get(message) ?? message), clearedSeqs: candidates.filter(({ message }) => replacements.has(message)).map(({ seq }) => seq) };
}

export class CompactionBudgetError extends Error {}

export function compactionPlan(messages: AgentMessage[], model: Model<Api>, overflow = false) {
  const budget = contextBudget(model);
  const fixed = messages.filter((message) => message.role === "system");
  const source = messages.filter((message) => message.role !== "system");
  if (overflow && source.at(-1)?.role === "assistant") source.pop();
  if (!source.length) {
    return undefined;
  }
  if (danglingToolCalls(source).length) throw new Error("Context compaction cannot split an unfinished tool call");
  const fixedTokens = total(fixed);
  if (fixedTokens >= budget.ceiling) throw new CompactionBudgetError("The estimated system instructions and tools leave no room for a summary. Select a larger model");
  const mandatory = source.at(-1)?.role === "user" ? source.length - 1 : source.length;
  if (mandatory < source.length && fixedTokens + total(source.slice(mandatory)) + budget.summary >= budget.ceiling) {
    throw new CompactionBudgetError("The current input leaves no estimated room for a summary. Reduce the input or select a larger model");
  }
  const suffixTokens = new Array<number>(source.length + 1).fill(0);
  for (let index = source.length - 1; index >= 0; index--) suffixTokens[index] = suffixTokens[index + 1]! + messageTokens(source[index]!);
  let cut = source.length;
  for (const boundary of boundaries(source)) {
    if (boundary === 0 || boundary > mandatory) continue;
    if (suffixTokens[boundary]! <= budget.recent || boundary === mandatory) {
      cut = boundary;
      break;
    }
  }
  if (mandatory === 0) throw new CompactionBudgetError("There is no earlier history to compact. Reduce the input or select a larger model");
  const retainedSources: SourceRange[][] = [];
  const retained = source.slice(cut).flatMap((message) => {
    const visible = visibleMessage(message);
    if (!visible) return [];
    const sources = messageSources(message);
    sourceLabel(sources);
    retainedSources.push(sources);
    setMessageSources(visible, sources);
    return [visible];
  });
  if (fixedTokens + total(retained) + budget.summary >= budget.ceiling) throw new CompactionBudgetError("The recent messages leave no estimated room for a summary. Select a larger model");
  const inputBudget = model.contextWindow - 4096 - budget.summary * 2 - 2048;
  if (inputBudget < 64) throw new CompactionBudgetError("The model context window is too small for a summary request");
  const chunks = sourceChunks(source.slice(0, cut), inputBudget);
  return { budget, fixed, retained, retainedSources, chunks };
}
