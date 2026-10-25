import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createModels, fauxProvider, getSupportedThinkingLevels, type Model, type Api } from "@earendil-works/pi-ai";
import { changeSessionConfig, sessionConfigOptions } from "../src/acp-config.ts";
import type { AcpSelection } from "../src/acp-state.ts";

function setup() {
  const faux = fauxProvider({
    provider: "config-test",
    models: [
      { id: "wide", reasoning: true },
      { id: "narrow", reasoning: true },
      { id: "always-on", reasoning: true },
      { id: "plain", reasoning: false },
    ],
  });
  const [wide, narrow, alwaysOn, plain] = faux.models as [Model<Api>, Model<Api>, Model<Api>, Model<Api>];
  wide.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
  narrow.thinkingLevelMap = { minimal: null, xhigh: null, max: null };
  alwaysOn.thinkingLevelMap = { off: null, minimal: null, low: null, xhigh: null, max: null };
  const models = createModels();
  models.setProvider(faux.provider);
  const supportsFast = (model: Model<Api>) => model.provider === wide.provider && model.id === wide.id;
  const selection: AcpSelection = Object.freeze({ model: wide, thinking: "max", fast: true });
  return { models, faux, wide, narrow, alwaysOn, plain, supportsFast, selection };
}

function invalidParams(error: unknown): boolean {
  assert.ok(error instanceof acp.RequestError);
  assert.equal(error.code, -32602);
  return true;
}

test("options use authenticated models and keep the current model when the catalog omits it", async () => {
  const { models, faux, selection, supportsFast, narrow } = setup();
  models.setProvider({ ...faux.provider, filterModels: () => [narrow] });
  const options = await sessionConfigOptions(models, selection, supportsFast, true);
  assert.equal(options.length, 3);
  const model = options.find((option) => option.id === "model")!;
  assert.equal(model.type, "select");
  assert.equal(model.category, "model");
  if (model.type !== "select") assert.fail("expected model selector");
  assert.equal(model.currentValue, "config-test/wide");
  assert.deepEqual(model.options.map((option) => "value" in option ? option.value : option.group), ["config-test/narrow", "config-test/wide"]);
  const thinking = options.find((option) => option.id === "thinking")!;
  assert.equal(thinking.category, "thought_level");
  if (thinking.type !== "select") assert.fail("expected thinking selector");
  assert.equal(thinking.currentValue, "max");
  assert.deepEqual(thinking.options.map((option) => "value" in option ? option.value : option.group), getSupportedThinkingLevels(selection.model));
  const fast = options.find((option) => option.id === "fast");
  assert.equal(fast?.type, "boolean");
  assert.equal(fast?.category, "model_config");
  assert.equal(fast?.currentValue, true);
  assert.deepEqual((await models.getAvailable()).map((model) => model.id), ["narrow"]);
});

test("options do not duplicate the selected model or include providers without credentials", async () => {
  const { models, selection, supportsFast } = setup();
  const unavailable = fauxProvider({ provider: "unavailable", models: [{ id: "hidden" }] });
  models.setProvider({ ...unavailable.provider, auth: { apiKey: { name: "Missing", resolve: async () => undefined } } });
  const options = await sessionConfigOptions(models, selection, supportsFast, true);
  const model = options[0]!;
  if (model.type !== "select") assert.fail("expected model selector");
  assert.equal(model.options.length, 4);
  assert.equal(model.options.filter((option) => "value" in option && option.value === "config-test/wide").length, 1);
});

test("Fast is exposed only when both the client and selected model support it", async () => {
  const { models, selection, supportsFast, narrow } = setup();
  for (const [booleanSupported, model, expected] of [
    [true, selection.model, true],
    [false, selection.model, false],
    [true, narrow, false],
    [false, narrow, false],
  ] as const) {
    const options = await sessionConfigOptions(models, { ...selection, model }, supportsFast, booleanSupported);
    assert.equal(options.some((option) => option.id === "fast"), expected);
  }
});

test("model changes clamp thinking across supported ranges and reset Fast in both directions", async () => {
  const { models, selection, supportsFast, narrow, wide, plain } = setup();
  const restricted = await changeSessionConfig(models, selection, supportsFast, "model", "config-test/narrow");
  assert.deepEqual(restricted, { model: narrow, thinking: "high", fast: false });
  const expanded = await changeSessionConfig(models, restricted, supportsFast, "model", "config-test/wide");
  assert.deepEqual(expanded, { model: wide, thinking: "high", fast: false });
  const quiet = await changeSessionConfig(models, selection, supportsFast, "model", "config-test/plain");
  assert.deepEqual(quiet, { model: plain, thinking: "off", fast: false });
  assert.deepEqual(selection, { model: wide, thinking: "max", fast: true });
});

test("model changes clamp off and unsupported lower levels upward when required", async () => {
  const { models, selection, supportsFast, alwaysOn } = setup();
  for (const thinking of ["off", "minimal", "low"] as const) {
    const changed = await changeSessionConfig(models, { ...selection, thinking }, supportsFast, "model", "config-test/always-on");
    assert.deepEqual(changed, { model: alwaysOn, thinking: "medium", fast: false });
  }
  const changed = await changeSessionConfig(models, { ...selection, thinking: "minimal" }, supportsFast, "model", "config-test/narrow");
  assert.equal(changed.thinking, "low");
});

test("model selection rechecks credentials even when a previously available model is requested", async () => {
  const { models, faux, selection, supportsFast } = setup();
  await sessionConfigOptions(models, selection, supportsFast, true);
  models.setProvider({ ...faux.provider, auth: { apiKey: { name: "Missing", resolve: async () => undefined } } });
  await assert.rejects(changeSessionConfig(models, selection, supportsFast, "model", "config-test/narrow"), invalidParams);
  assert.equal(selection.thinking, "max");
  assert.equal(selection.fast, true);
});

test("thinking changes accept exact model levels without silently clamping", async () => {
  const { models, selection, supportsFast, narrow, plain } = setup();
  const current = Object.freeze({ ...selection, model: narrow, thinking: "high" as const });
  const changed = await changeSessionConfig(models, current, supportsFast, "thinking", "low");
  assert.deepEqual(changed, { ...current, thinking: "low" });
  assert.notEqual(changed, current);
  for (const value of ["minimal", "xhigh", "max", "ultra", "", true, false]) {
    await assert.rejects(changeSessionConfig(models, current, supportsFast, "thinking", value), invalidParams);
  }
  const nonThinking = { ...selection, model: plain, thinking: "off" as const, fast: false };
  assert.deepEqual(await changeSessionConfig(models, nonThinking, supportsFast, "thinking", "off"), nonThinking);
  await assert.rejects(changeSessionConfig(models, nonThinking, supportsFast, "thinking", "medium"), invalidParams);
  const options = await sessionConfigOptions(models, nonThinking, supportsFast, true);
  const option = options.find((entry) => entry.id === "thinking")!;
  if (option.type !== "select") assert.fail("expected thinking selector");
  assert.deepEqual(option.options, [{ value: "off", name: "off" }]);
  assert.equal(current.thinking, "high");
});

test("Fast changes require a boolean and model support and preserve other selection fields", async () => {
  const { models, selection, supportsFast, narrow } = setup();
  const disabled = await changeSessionConfig(models, selection, supportsFast, "fast", false);
  assert.deepEqual(disabled, { ...selection, fast: false });
  assert.deepEqual(await changeSessionConfig(models, disabled, supportsFast, "fast", true), selection);
  for (const value of ["true", "false", "", "on"]) {
    await assert.rejects(changeSessionConfig(models, selection, supportsFast, "fast", value), invalidParams);
  }
  for (const value of [true, false]) {
    await assert.rejects(changeSessionConfig(models, { ...selection, model: narrow }, supportsFast, "fast", value), invalidParams);
  }
  assert.equal(selection.fast, true);
});

test("invalid configuration ids and model values reject without changing the selection", async () => {
  const { models, selection, supportsFast, wide } = setup();
  for (const value of [true, false, "", "wide", "/wide", "config-test/", "unknown/wide", "config-test/missing"]) {
    await assert.rejects(changeSessionConfig(models, selection, supportsFast, "model", value), invalidParams);
  }
  for (const id of ["mode", "permissions", "plan", "models", ""]) {
    await assert.rejects(changeSessionConfig(models, selection, supportsFast, id, true), invalidParams);
  }
  assert.deepEqual(selection, { model: wide, thinking: "max", fast: true });
});

test("switching to a model with no legal thinking level fails without changing the selection", async () => {
  const { models, selection, supportsFast, alwaysOn } = setup();
  alwaysOn.thinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  await assert.rejects(changeSessionConfig(models, selection, supportsFast, "model", "config-test/always-on"), invalidParams);
  assert.equal(selection.thinking, "max");
  assert.equal(selection.fast, true);
});
