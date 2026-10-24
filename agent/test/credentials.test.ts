import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { deviceId, FileCredentialStore } from "../src/credentials.ts";
import { login, terminalInteraction } from "../src/login.ts";
import { applyHandoff, parseHandoff } from "../src/rx-provider.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function scripted(lines: string[]): { interaction: ReturnType<typeof terminalInteraction>; output: () => string } {
  const input = new PassThrough();
  const sink = new PassThrough();
  let text = "";
  sink.on("data", (chunk) => (text += chunk));
  input.end(lines.map((line) => `${line}\n`).join(""));
  return { interaction: terminalInteraction({ input, output: sink, openUrl: () => {} }), output: () => text };
}

test("stored credentials round-trip through a secret-only file", async () => {
  const home = join(tempDir(), "home");
  mkdirSync(home, { mode: 0o755 });
  const store = new FileCredentialStore(home);
  assert.equal(await store.read("deepseek"), undefined);
  await store.modify("deepseek", async () => ({ type: "api_key", key: "sk-one" }));
  await store.modify("openai-codex", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
  assert.deepEqual(await new FileCredentialStore(home).read("deepseek"), { type: "api_key", key: "sk-one" });
  assert.deepEqual(await store.list(), [
    { providerId: "deepseek", type: "api_key" },
    { providerId: "openai-codex", type: "oauth" },
  ]);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(await store.modify("deepseek", async () => undefined), { type: "api_key", key: "sk-one" });
  await store.delete("deepseek");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(store.path, "utf8"))), ["openai-codex"]);
});

test("malformed credential files and entries fail closed", async () => {
  const home = tempDir();
  const store = new FileCredentialStore(home);
  for (const text of ["{", "[]", '{"deepseek": {"type": "api_key", "key": 1}}', '{"x": {"type": "oauth", "access": "a"}}']) {
    writeFileSync(store.path, text);
    await assert.rejects(store.read("deepseek"), (error: Error) => error.message.startsWith(store.path));
    await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: "k" })));
    assert.equal(readFileSync(store.path, "utf8"), text);
  }
  writeFileSync(store.path, "{}");
  await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: 1 }) as never), /malformed credential/);
  assert.equal(readFileSync(store.path, "utf8"), "{}");
});

test("the provider handed off by an rx launch is hidden from the store", async () => {
  const home = tempDir();
  await new FileCredentialStore(home).modify("acme", async () => ({ type: "api_key", key: "stored-key" }));
  const store = new FileCredentialStore(home, "acme");
  assert.equal(await store.read("acme"), undefined);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.modify("acme", async () => ({ type: "api_key", key: "k" })), /come from the rx launch/);
  await assert.rejects(store.delete("acme"), /come from the rx launch/);

  const handoff = parseHandoff(
    JSON.stringify({ id: "acme", name: "Acme", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", env: "ACME_CRED_TEST_KEY", models: [{ id: "m", contextWindow: 8000, reasoning: false }], defaultModel: "m" }),
  );
  const launched = builtinModels({ credentials: store });
  const unscoped = builtinModels({ credentials: new FileCredentialStore(home) });
  applyHandoff(launched, handoff);
  applyHandoff(unscoped, handoff);
  process.env.ACME_CRED_TEST_KEY = "launch-key";
  try {
    assert.equal((await unscoped.getAuth("acme"))?.auth.apiKey, "stored-key");
    assert.equal((await launched.getAuth("acme"))?.auth.apiKey, "launch-key");
  } finally {
    delete process.env.ACME_CRED_TEST_KEY;
  }
});

test("writers serialize in-process and wait for a live lock owner", async () => {
  const home = tempDir();
  const store = new FileCredentialStore(home);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.modify(`p${index}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { type: "api_key", key: String(index) };
      }),
    ),
  );
  assert.equal((await store.list()).length, 20);

  const lock = `${store.path}.lock`;
  writeFileSync(lock, String(process.ppid));
  await assert.rejects(
    store.modify("held", async () => ({ type: "api_key", key: "k" }), { signal: AbortSignal.timeout(200) }),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(await store.read("held"), undefined);
  assert.equal(readFileSync(lock, "utf8"), String(process.ppid));

  writeFileSync(lock, String(spawnSync("true").pid));
  await store.modify("held", async () => ({ type: "api_key", key: "k" }));
  assert.deepEqual(await store.read("held"), { type: "api_key", key: "k" });
  assert.equal(existsSync(lock), false);
});

test("the device id is created once and must stay a UUID", () => {
  const home = tempDir();
  const id = deviceId(home);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(deviceId(home), id);
  assert.equal(statSync(join(home, "device-id")).mode & 0o777, 0o600);
  writeFileSync(join(home, "device-id"), "not-a-uuid\n");
  assert.throws(() => deviceId(home), /expected a UUID/);
});

test("login offers providers, asks for an API key, and stores it", async () => {
  const home = tempDir();
  const store = new FileCredentialStore(home);
  const models = builtinModels({ credentials: store });
  const index = models
    .getProviders()
    .filter((provider) => provider.auth.oauth || provider.auth.apiKey?.login)
    .findIndex((provider) => provider.id === "deepseek");
  const { interaction, output } = scripted([String(index + 1), "", "sk-scripted"]);
  try {
    const result = await login(models, undefined, interaction, () => deviceId(home));
    assert.equal(result.provider.id, "deepseek");
    assert.equal(result.type, "api_key");
  } finally {
    interaction.close();
  }
  assert.match(output(), /Log in to\n/);
  assert.match(output(), /Enter DeepSeek API key: /);
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "sk-scripted" });
  assert.equal((await models.getAuth("deepseek"))?.source, "stored credential");
});

test("login asks which method when a provider has a subscription and an API key", async () => {
  const models = builtinModels({ credentials: new FileCredentialStore(tempDir()) });
  const both = models.getProviders().find((provider) => provider.auth.oauth && provider.auth.apiKey?.login);
  assert.ok(both);
  const { interaction, output } = scripted(["9"]);
  try {
    await assert.rejects(login(models, both.id, interaction, () => "x"), /invalid selection "9"/);
  } finally {
    interaction.close();
  }
  assert.match(output(), new RegExp(`Sign in to ${both.name} with\\n  1\\. `));
  await assert.rejects(login(models, "no-such-provider", interaction, () => "x"), /unknown provider "no-such-provider"/);
});

test("the CLI logs in from piped input, lists the provider, and logs out", () => {
  const home = tempDir();
  const env = { ...process.env, RX_HOME: home, DEEPSEEK_API_KEY: "", RX_AGENT_PROVIDER: "", RX_MODEL: "" };
  const run = (args: string[], input = "") => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });

  const loggedIn = run(["login", "deepseek"], "sk-cli\n");
  assert.equal(loggedIn.status, 0, loggedIn.stderr);
  assert.match(loggedIn.stderr, /logged in to DeepSeek; credentials saved in /);
  assert.doesNotMatch(loggedIn.stderr + loggedIn.stdout, /sk-cli/);
  assert.match(run(["models"]).stdout, /^deepseek\//m);

  assert.equal(run(["logout", "deepseek"]).status, 0);
  assert.doesNotMatch(run(["models"]).stdout, /^deepseek\//m);
  const missing = run(["logout", "deepseek"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no stored credentials for "deepseek"/);
  assert.match(run(["logout"]).stderr, /logout needs a provider/);
  assert.match(run(["login", "a", "b"]).stderr, /unexpected argument "b"/);
});
