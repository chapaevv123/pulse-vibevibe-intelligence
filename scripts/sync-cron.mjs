#!/usr/bin/env node
/**
 * GITHUB ACTIONS SYNC ENTRYPOINT (public demo)
 * =================================================
 * Runs the SAME shared sync logic (src/sync.js -> runSync) that the
 * Cloudflare Worker used to run under Cron, now driven by a GitHub Actions
 * schedule instead — see .github/workflows/sync.yml. This exists ONLY
 * because Workers Free's 10ms-per-Cron-invocation CPU budget cannot fit
 * our sync's real CPU cost (JSON parsing, scoring, normalization across
 * dozens-to-hundreds of launches); GitHub's runners have no such ceiling.
 *
 * No fork of the sync/scoring logic exists here — this script only wires
 * up a D1 REST client (src/d1RestClient.js) in place of the Workers D1
 * binding and calls the identical runSync(D1, { incremental: true }).
 *
 * Required environment variables (GitHub Actions secrets/vars — see
 * .github/workflows/sync.yml):
 *   CF_ACCOUNT_ID       - Cloudflare account ID (not secret)
 *   CF_D1_DATABASE_ID   - target D1 database ID (not secret)
 *   CF_D1_API_TOKEN     - narrowly-scoped (D1 Edit only) API token (SECRET)
 *
 * This script NEVER logs CF_D1_API_TOKEN, in any form, at any log level.
 */
import { createD1RestClient } from "../src/d1RestClient.js";
import { runSync } from "../src/sync.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export async function main() {
  const startedAt = new Date().toISOString();
  const accountId = requireEnv("CF_ACCOUNT_ID");
  const databaseId = requireEnv("CF_D1_DATABASE_ID");
  const apiToken = requireEnv("CF_D1_API_TOKEN");

  const D1 = createD1RestClient({ accountId, databaseId, apiToken });

  console.log(`[sync-cron] starting incremental sync at ${startedAt}`);

  const result = await runSync(D1, { incremental: true });

  const summary = {
    run_id: result.run_id,
    status: result.status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    launches_discovered: result.launches_seen ?? 0,
    launches_new: result.launches_new ?? 0,
    scores_written: result.scores_written ?? 0,
    enrichments_refreshed: (result.enrichment?.holders_enriched ?? 0) + (result.enrichment?.activity_enriched ?? 0),
    watermark_before: result.watermark_before ?? null,
    watermark_after: result.watermark_after ?? null,
    lease_renewals: result.lease_renewals ?? 0,
    locked_by: result.locked_by ?? null,
  };

  // Deliberately structured, non-secret output only — this is exactly
  // what shows up in the public GitHub Actions run log.
  console.log("[sync-cron] summary:", JSON.stringify(summary, null, 2));

  const FAILURE_STATUSES = new Set(["FAILED", "FAILED_LOCK_LOST", "FAILED_TIME_BUDGET", "FAILED_OPERATION_TIMEOUT"]);
  if (FAILURE_STATUSES.has(result.status)) {
    console.error(`[sync-cron] sync ended in a failure status: ${result.status}`);
    process.exitCode = 1;
    return;
  }
  // SKIPPED_LOCKED and COMPLETED are both a clean, successful exit for
  // this entrypoint — SKIPPED_LOCKED is expected, routine behavior when a
  // prior run is still genuinely active (see src/lock.js), never an error.
  console.log(`[sync-cron] done (${result.status})`);
}

// Only auto-run when executed directly (`node scripts/sync-cron.mjs`), not
// when imported — lets test/sync-cron-entrypoint.test.js import and drive
// main() explicitly, with full control over env/mocks/timing, without a
// second uncontrolled invocation racing it.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isMain) {
  main().catch((e) => {
    // Never print the raw error object wholesale if it could somehow carry
    // request internals — message text only, which our own code controls
    // and never populates with the token (see src/d1RestClient.js).
    console.error(`[sync-cron] FATAL: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
