import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { inlineSlashToken, RxAutocompleteProvider, RxEditor } from "../src/completion.ts";

const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const UP = "\x1b[A";
const UNDO = "\x1f";
const SHIFT_SPACE = "\x1b[32;2u";
const identity = (value: string) => value;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const commands = [{ name: "exit", description: "Exit" }, { name: "greet", description: "Greet" }, { name: "review", description: "Review" }];

function editor(history: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "rx-completion-"));
  writeFileSync(join(cwd, "notes.md"), "");
  writeFileSync(join(cwd, "my notes.md"), "");
  const fd = join(cwd, "fd");
  writeFileSync(fd, "#!/bin/sh\nprintf 'notes.md\\nmy notes.md\\n'\n");
  chmodSync(fd, 0o755);
  const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
  const instance = new RxEditor(tui, theme, { paddingX: 0 });
  instance.setAutocompleteProvider(new RxAutocompleteProvider(commands, cwd, fd));
  for (const entry of history) instance.addToHistory(entry);
  const submitted: string[] = [];
  instance.onSubmit = (text) => submitted.push(text);
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      instance.handleInput(key);
      await sleep(60);
    }
  };
  const type = (text: string) => press(...text);
  const opened = async () => {
    for (let waited = 0; waited < 3000 && !instance.isShowingAutocomplete(); waited += 20) await sleep(20);
    return instance.isShowingAutocomplete();
  };
  return { instance, submitted, press, type, opened, popup: () => instance.isShowingAutocomplete(), text: () => instance.getText(), menu: () => instance.render(100).join("\n") };
}

test("inline slash tokens exclude the message start and paths", () => {
  assert.equal(inlineSlashToken(["/gr"], 0, 3), undefined);
  assert.equal(inlineSlashToken(["  /gr"], 0, 5), undefined);
  assert.equal(inlineSlashToken(["fix /gr"], 0, 7), "/gr");
  assert.equal(inlineSlashToken(["fix", "/gr"], 1, 3), "/gr");
  assert.equal(inlineSlashToken(["fix /usr/lo"], 0, 11), undefined);
  assert.equal(inlineSlashToken(["fix a/b"], 0, 7), undefined);
});

test("a mid-input slash opens a filtered command list and Enter inserts without submitting", async () => {
  const e = editor();
  await e.type("please /");
  assert.ok(e.popup());
  await e.type("gre");
  assert.ok(e.popup());
  assert.match(e.menu(), /greet/);
  assert.doesNotMatch(e.menu(), /review/);
  await e.press(ENTER);
  assert.equal(e.text(), "please /greet ");
  assert.equal(e.popup(), false);
  assert.deepEqual(e.submitted, []);
  await e.type("now");
  await e.press(ENTER);
  assert.deepEqual(e.submitted, ["please /greet now"]);
});

test("a slash at the start of a later line also completes without submitting", async () => {
  const e = editor();
  await e.type("context");
  await e.press("\n");
  await e.type("/rev");
  assert.equal(e.text(), "context\n/rev");
  assert.ok(e.popup());
  await e.press(ENTER);
  assert.equal(e.text(), "context\n/review ");
  assert.deepEqual(e.submitted, []);
});

test("a space or Esc closes the slash list and Esc does not reopen it", async () => {
  const e = editor();
  await e.type("x /gr");
  assert.ok(e.popup());
  await e.type(" ");
  assert.equal(e.popup(), false);
  assert.equal(e.text(), "x /gr ");
  await e.type("/gr");
  assert.ok(e.popup());
  await e.press(ESC);
  assert.equal(e.popup(), false);
  await sleep(100);
  assert.equal(e.popup(), false);
  assert.equal(e.text(), "x /gr /gr");
  await e.press(BACKSPACE);
  assert.ok(e.popup());
});

test("Shift+Space closes the list and undo closes it before Enter can apply a stale entry", async () => {
  const e = editor();
  await e.type("x /gr");
  assert.ok(e.popup());
  await e.press(SHIFT_SPACE);
  assert.equal(e.popup(), false);
  assert.equal(e.text(), "x /gr ");
  await e.type("/gr");
  assert.ok(e.popup());
  await e.press(UNDO);
  assert.equal(e.popup(), false);
  const kept = e.text();
  assert.doesNotMatch(kept, /greet/);
  await e.press(ENTER);
  assert.deepEqual(e.submitted, [kept.trim()]);
});

test("a mid-input slash lists only names that start with the typed text", async () => {
  const e = editor();
  await e.type("ls /rw");
  assert.equal(e.popup(), false);
  await e.press(ENTER);
  assert.deepEqual(e.submitted, ["ls /rw"]);
});

test("a space closes the file list opened by a mid-input @", async () => {
  const e = editor();
  await e.type("read @no");
  assert.ok(await e.opened());
  assert.match(e.menu(), /notes\.md/);
  await e.type(" ");
  assert.equal(e.popup(), false);
  await sleep(100);
  assert.equal(e.popup(), false);
  assert.equal(e.text(), "read @no ");
});

test("a space inside a quoted @ path keeps the file list open", async () => {
  const e = editor();
  await e.type('read @"my');
  assert.ok(await e.opened());
  await e.type(" ");
  assert.equal(e.text(), 'read @"my ');
  assert.ok(await e.opened());
  assert.match(e.menu(), /my notes\.md/);
});

test("start-of-message slash keeps pi submit behavior", async () => {
  const e = editor();
  await e.type("/gre");
  assert.ok(e.popup());
  await e.press(ENTER);
  assert.deepEqual(e.submitted, ["/greet"]);
});

test("history recall and unknown names do not open the list", async () => {
  const e = editor(["ask /greet"]);
  await e.press(UP);
  assert.equal(e.text(), "ask /greet");
  assert.equal(e.popup(), false);
  const other = editor();
  await other.type("see /zzz");
  assert.equal(other.popup(), false);
});
