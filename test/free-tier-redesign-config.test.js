import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("17+18. GitHub Actions workflow is scheduled at */15, not */10 or */1", () => {
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.match(yml, /cron:\s*["']?\*\/15 \* \* \* \*["']?/, "workflow must be scheduled every 15 minutes");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/1 \* \* \* \*["']?/, "must never use a 1-minute cron");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/10 \* \* \* \*["']?/, "must use 15 minutes, not 10");
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
