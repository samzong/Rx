import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSystemMessageText, type UserMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export function textTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other * 2);
}

export function messageTokens(message: AgentMessage): number {
  let text = "";
  if (message.role === "system") text = getSystemMessageText(message) + JSON.stringify(message.toolsAdded ?? []);
  else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
    text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "thinking") return [block.thinking];
      if (block.type === "toolCall") return [block.name, JSON.stringify(block.arguments)];
      return [];
    }).join("");
  }
  let unicodeAdjustment = 0;
  for (const char of text) if (char.codePointAt(0)! >= 128) unicodeAdjustment += 0.75;
  return estimateTokens(message) + Math.ceil(unicodeAdjustment);
}

export function total(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

export function visibleMessage(message: AgentMessage): UserMessage | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "user") {
    return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "image" ? { type: "image", data: block.data, mimeType: block.mimeType } : { type: "text", text: block.text }), timestamp: message.timestamp };
  }
  if (message.role === "assistant") {
    const text = message.content.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "toolCall") return [`Recorded tool call ${block.name} (${block.id}), requested input: ${JSON.stringify(block.arguments)}`];
      return [];
    }).join("\n");
    const error = message.stopReason === "error" || message.stopReason === "aborted" ? `\nRecorded ${message.stopReason}: ${message.errorMessage ?? "no details"}` : "";
    return text || error ? { role: "user", content: `[Recorded assistant message]\n${text}${error}`, timestamp: message.timestamp } : undefined;
  }
  if (message.role === "toolResult") {
    const text = `[Recorded tool result ${message.toolName} (${message.toolCallId}), ${message.isError ? "error" : "success"}]`;
    return { role: "user", content: [{ type: "text", text }, ...message.content.map((block) => block.type === "image" ? { type: "image" as const, data: block.data, mimeType: block.mimeType } : { type: "text" as const, text: block.text })], timestamp: message.timestamp };
  }
  throw new Error("Context contains an unsupported message type");
}

export function transcript(message: AgentMessage): string {
  const visible = visibleMessage(message);
  if (!visible) return "";
  const content = typeof visible.content === "string" ? visible.content : visible.content.map((block) => block.type === "text" ? block.text : "[Historical image omitted. Use recall_log with this source range if its visual detail is needed.]").join("\n");
  return `${message.role === "user" ? "[Recorded user message]" : ""}\n${content}`;
}
