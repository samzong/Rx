import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSummarySources } from "../src/context-citations.ts";

const sources = [{ from: 1, to: 2 }];
const fact = "Keep the original task. [log 1-2]";

test("pi summary placeholders and structural Markdown do not require factual citations", () => {
  const lines = ["- None", "None.", "- None stated.", "- None reported", "- (none specified)", "- [None known]", "- (none).", "- [ ] (none)", "- [x] None", "1. (none)", "2) None", "-", "- [ ]", "---", "***", "___", "|---|:---:|", "| | |", "**Goal:**", "**Next Steps:**", "### Blocked\n- None identified", "```text\n```"];
  for (const line of lines) assert.deepEqual(validateSummarySources(`${fact}\n${line}`, sources), sources, line);
  assert.deepEqual(validateSummarySources(`${fact}\n| File | Change |\n|---|---|\n| file.txt | Read it. [log 1-2] |`, sources), sources);
});

test("substantive summary lines and table values still need valid sources", () => {
  for (const line of ["- The tests passed", "- [ ] Await later request to retrieve the original marker.", "- [x] The tests passed", "1. Edit file.txt", "**The tests passed:**", "| file.txt | Changed it |", "- None [log 9-9]", "**Goal:** [log 0-0]", "--- [log 1]", "|---|---| [log 3-3]"]) {
    assert.throws(() => validateSummarySources(`${fact}\n${line}`, sources), line);
  }
  assert.throws(() => validateSummarySources("**Goal:**\n- None\n---", sources));
});
