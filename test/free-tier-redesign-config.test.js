import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("17+18. GitHub Actions workflow never uses a */1 or */10 cron; the schedule trigger, if present, is exactly */15", () => {
  // During initial rollout (see docs/DEPLOYMENT.md Phase 6/10) the
  // `schedule:` trigger is deliberately OMITTED so the very first
  // owner-triggered manual runs can never race a scheduler tick —
  // `workflow_dispatch` alone is a valid, expected state here. Once the
  // schedule IS added back, it must be exactly */15 — never */1, never
  // */10.
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/1 \* \* \* \*["']?/, "must never use a 1-minute cron");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/10 \* \* \* \*["']?/, "must use 15 minutes, not 10, if/when a schedule exists");
  // Strip comment-only lines first — this file's own explanatory comments
  // reference "schedule:" and "cron:" in backticks, which would otherwise
  // false-positive as an active YAML trigger key.
  const codeOnly = yml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const hasSchedule = /^\s*schedule:/m.test(codeOnly);
  if (hasSchedule) {
    assert.match(yml, /cron:\s*["']?\*\/15 \* \* \* \*["']?/, "an existing schedule trigger must be exactly */15");
  }
});

test("workflow_dispatch is supported for owner-controlled manual testing", () => {
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.match(yml, /workflow_dispatch/);
});

test("workflow declares a concurrency group with cancel-in-progress: false", () => {
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.match(yml, /concurrency:/);
  assert.match(yml, /group:\s*pulse-vibevibe-sync/);
  assert.match(yml, /cancel-in-progress:\s*false/);
});

test("workflow secret is referenced via secrets.CF_D1_API_TOKEN, never a literal token", () => {
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.match(yml, /\$\{\{\s*secrets\.CF_D1_API_TOKEN\s*\}\}/);
  // No 40+ char alphanumeric literal that could plausibly be a real token.
  assert.doesNotMatch(yml, /['"][A-Za-z0-9_-]{40,}['"]/);
});

test("19. the deployed Worker's cron trigger is permanently disabled (crons: [])", () => {
  const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"crons":\s*\[\s*\]/, "wrangler.jsonc must declare an empty crons array");
});

test("the Worker's scheduled() handler is inert (no sync.js import, no runSync call anywhere in index.js)", () => {
  const indexJs = readFileSync(path.join(ROOT, "src", "index.js"), "utf8");
  assert.doesNotMatch(indexJs, /runSync/, "index.js must not reference runSync anywhere — the Worker no longer performs sync");
  assert.match(indexJs, /async scheduled\(/, "a scheduled() handler must still exist (inert, so a stray cron registration lands on a no-op)");
});
