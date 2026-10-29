import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRxAgent } from "../src/agent.ts";
import { contextControl } from "../src/context-control.ts";
import { SessionLog } from "../src/session-log.ts";
import { fauxModels, tempDir } from "./helpers.ts";

function setup(window = 16384, history: AgentMessage[] = [], prompt = "Follow the user's constraints. Never repeat completed side effects.") {
  const { models, faux, model } = fauxModels();
  const selected = { ...model, contextWindow: window };
  const cwd = tempDir();
  const log = SessionLog.create(tempDir(), cwd);
  for (const message of history) log.append(message.role === "user" ? "cli" : message.role === "toolResult" ? "tool" : "model", message);
  const agent = createRxAgent({ models, model: selected, cwd, thinking: "off", log, origin: "cli", systemPrompt: prompt, messages: history });
  return { models, faux, model: selected, log, agent, control: contextControl(agent) };
}

function records(log: SessionLog): any[] {
  return readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a read restores an older image after compaction omits it from working context", async () => {
  const { agent, faux, log, control } = setup();
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  const path = join(log.cwd, "screen.png");
  writeFileSync(path, Buffer.from(data, "base64"));
  const read = (id: string) => fauxAssistantMessage([fauxToolCall("read", { path }, { id })], { stopReason: "toolUse" });
  faux.setResponses([read("before"), fauxAssistantMessage("saw the image"), fauxAssistantMessage("recorded the later evidence")]);
  await agent.prompt("Read screen.png");
  await agent.prompt("later evidence ".repeat(1500));
  faux.setResponses([(context) => {
    assert.match(JSON.stringify(context.messages), /Historical image omitted/);
    assert.ok(!JSON.stringify(context.messages).includes(data));
    return fauxAssistantMessage(`The image source is ${path}. Read it again for visual details. Later evidence was recorded. [log 1-1]`);
  }]);
  await control.compact();
  assert.ok(!JSON.stringify(agent.state.messages).includes(data));
  assert.ok(readFileSync(log.path, "utf8").includes(data));
  faux.setResponses([read("after"), (context) => {
    const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "after");
    assert.ok(result?.role === "toolResult" && !result.isError);
    assert.deepEqual(result.content[1], { type: "image", data, mimeType: "image/png" });
    return fauxAssistantMessage("image restored");
  }]);
  await agent.prompt("Read screen.png again");
  assert.ok(records(log).some((entry) => entry.type === "compaction"));
  assert.ok(SessionLog.open(log.home, log.id).messages.some((message) => message.role === "toolResult" && message.toolCallId === "after"));
});
