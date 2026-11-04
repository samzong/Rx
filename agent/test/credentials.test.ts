import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore } from "../src/credentials.ts";
import { applyHandoff, parseHandoff } from "../src/rx-provider.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "../src/cli.ts");

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
    await assert.rejects(store.read("deepseek"));
    await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: "k" })));
    assert.equal(readFileSync(store.path, "utf8"), text);
  }
  writeFileSync(store.path, "{}");
  await assert.rejects(store.modify("deepseek", async () => ({ type: "api_key", key: 1 }) as never));
  assert.equal(readFileSync(store.path, "utf8"), "{}");
});

test("the provider handed off by an rx launch is hidden from the store", async () => {
  const home = tempDir();
  await new FileCredentialStore(home).modify("acme", async () => ({ type: "api_key", key: "stored-key" }));
  const store = new FileCredentialStore(home, "acme");
  assert.equal(await store.read("acme"), undefined);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.modify("acme", async () => ({ type: "api_key", key: "k" })));
  await assert.rejects(store.delete("acme"));

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

test("the CLI logs in from piped input, lists the provider, and logs out", () => {
  const home = tempDir();
  const env = { ...process.env, RX_HOME: home, DEEPSEEK_API_KEY: "", RX_AGENT_PROVIDER: "", RX_MODEL: "" };
  const run = (args: string[], input = "") => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });

  const loggedIn = run(["login", "deepseek"], "sk-cli\n");
  assert.equal(loggedIn.status, 0, loggedIn.stderr);
  assert.doesNotMatch(loggedIn.stderr + loggedIn.stdout, /sk-cli/);
  assert.match(run(["models"]).stdout, /^deepseek\//m);

  assert.equal(run(["logout", "deepseek"]).status, 0);
  assert.doesNotMatch(run(["models"]).stdout, /^deepseek\//m);
  const missing = run(["logout", "deepseek"]);
  assert.equal(missing.status, 1);
});
