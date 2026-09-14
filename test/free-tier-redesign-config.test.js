import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("17+18. GitHub Actions workflow never uses a */1 or */10 cron; the schedule trigger, if present, keeps a genuine ~15-minute cadence", () => {
  // During initial rollout (see docs/DEPLOYMENT.md Phase 6/10) the
  // `schedule:` trigger is deliberately OMITTED so the very first
  // owner-triggered manual runs can never race a scheduler tick —
  // `workflow_dispatch` alone is a valid, expected state here. Once the
  // schedule IS added back, it must fire every ~15 minutes — never every
  // 1 or 10.
  //
  // The literal `*/15 * * * *` form is ALSO valid in principle, but in
  // production it produced zero observed runs across two missed
  // boundaries (2026-09-14) — GitHub's docs warn the schedule event "can
  // be delayed during periods of high load... High load times include
  // the start of every hour," and :00/:15/:30/:45 are exactly that. The
  // shifted `7,22,37,52 * * * *` form keeps the same 15-minute spacing
  // while avoiding those congested marks — both are accepted here.
  const yml = readFileSync(path.join(ROOT, ".github", "workflows", "sync.yml"), "utf8");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/1 \* \* \* \*["']?/, "must never use a 1-minute cron");
  assert.doesNotMatch(yml, /cron:\s*["']?\*\/10 \* \* \* \*["']?/, "must use ~15 minutes, not 10, if/when a schedule exists");
  // Strip comment-only lines first — this file's own explanatory comments
  // reference "schedule:" and "cron:" in backticks, which would otherwise
  // false-positive as an active YAML trigger key.
  const codeOnly = yml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const hasSchedule = /^\s*schedule:/m.test(codeOnly);
  if (hasSchedule) {
    const m = yml.match(/cron:\s*["']([^"']+)["']/);
    assert.ok(m, "an existing schedule trigger must declare a quoted cron string");
    const minuteField = m[1].trim().split(/\s+/)[0];
    if (minuteField === "*/15") {
      // literal form — genuinely every 15 minutes, always valid
    } else {
      // shifted form — must be exactly 4 comma-separated minutes, each
      // 0-59, spaced exactly 15 apart (mod 60), e.g. "7,22,37,52"
      const parts = minuteField.split(",").map((s) => Number(s));
      assert.equal(parts.length, 4, `expected exactly 4 shifted minute marks, got "${minuteField}"`);
      for (const n of parts) assert.ok(Number.isInteger(n) && n >= 0 && n <= 59, `each minute mark must be 0-59, got "${minuteField}"`);
      const sorted = [...parts].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        assert.equal(sorted[i] - sorted[i - 1], 15, `shifted minute marks must be exactly 15 apart, got "${minuteField}"`);
      }
    }
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
