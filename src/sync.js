/**
 * SYNC ORCHESTRATION (public demo)
 * ===================================
 * Mirrors run_sync() from the local Pulse MVP: fetch launches -> normalize
 * -> upsert -> recompute creators -> pull builder leaderboards -> score ->
 * bounded holder/activity enrichment. LIVE-only — the public demo has no
 * fixture fallback (fixtures are a local Pulse concept; publishing a fake
 * "demo" row here would violate the "own project should never fabricate
 * data" rule carried over from the local MVP).
 *
 * Called from both the scheduled (cron) handler and an internal-only sync
 * trigger — never from an unauthenticated public POST route.
 *
 * LEASE DISCIPLINE (see src/lock.js for the full mechanism/history): the
 * hot sync path renews its lease at natural phase checkpoints via cp().
 * Losing the lease, breaching TIME_BUDGET_MS, or a hard operation timeout
 * (see src/timeouts.js) all abort immediately — no further upstream calls,
 * no further writes, and a truthful terminal status, never a fabricated
 * COMPLETED.
 *
 * INCIDENT (2026-09-13/14): a scheduled run acquired its lease, renewed
 * once, then never checkpointed again — it sat RUNNING past the 15-minute
 * time budget because a hung await between checkpoints never returned, so
 * the time-budget check never got a chance to run. Root cause traced to
 * vibeSource.js clearing its fetch-abort timer as soon as HTTP headers
 * arrived, leaving `resp.json()` (body read+parse) completely unbounded.
 * Fixed by (a) giving every upstream fetch a separate, explicit body-parse
 * timeout (see vibeSource.js) and (b) wrapping every D1 read/write on this
 * hot path in withTimeout() too, so no single awaited operation — network
 * or database — can ever again hang indefinitely between checkpoints.
 */
import * as sources from "./vibeSource.js";
import * as db from "./db.js";
import * as lock from "./lock.js";
import { classifyStatus, riskFlags, computeScore, computeHolderConcentration, computeActivityMetrics } from "./scoring.js";
import { VIBE_CHAIN_ID, ENRICHMENT_CAP, ENRICHMENT_MIN_SCORE, SYNC_PAGE_LIMIT, SYNC_MAX_PAGES, PULSE_TOKEN_ADDRESS } from "./config.js";
import { withTimeout, OperationTimeoutError, D1_QUERY_TIMEOUT_MS, D1_WRITE_TIMEOUT_MS, MAX_HEAVY_DB_OPERATION_MS } from "./timeouts.js";

export class LockLostError extends Error {}
export class TimeBudgetError extends Error {}

// Safety ceiling, NOT an expected runtime — measured real duration after
// the scaling fix is ~156-159s. This exists only to guarantee a sync
// aborts cleanly (truthful FAILED_TIME_BUDGET, lease released) before
// risking Cloudflare's own platform execution limits. It only fires AT a
// checkpoint, though — see the hard per-operation timeouts below for the
// complementary guarantee that a checkpoint is always eventually reached.
const TIME_BUDGET_MS = 15 * 60 * 1000; // 15 minutes

// Incremental (watermark-based) sync — see docs/DEPLOYMENT.md GitHub
// Actions redesign. A safety ceiling on pages even in incremental mode
// (the watermark should stop pagination far sooner in steady state; this
// only guards a pathological case — e.g. a burst of new launches larger
// than any single cycle should try to absorb at once). Kept well below
// the legacy SYNC_MAX_PAGES-driven full-rescan pattern isn't relevant here
// since incremental mode ignores `pages` entirely.
const MAX_INCREMENTAL_PAGES = 20;
// First-ever run (no watermark yet) needs an explicit bound — never an
// unlimited historical crawl.
const INITIAL_BACKFILL_PAGES = 5;

function runId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One lease checkpoint: renew-or-abort, plus a time-budget check, plus a
 * best-effort progress write (see persistProgress). Called at every natural
 * phase boundary in runSyncLocked (never on a busy timer). Throws
 * LockLostError or TimeBudgetError to unwind immediately — callers must not
 * catch-and-continue; only the outer per-run try/catch in runSyncLocked
 * handles these, to record a truthful terminal status. `d1w` is the
 * caller's write-timeout-wrapped executor (configurable — see
 * runSyncLocked — so tests can use short timeouts without waiting out the
 * real multi-second production values).
 */
async function checkpoint(D1, ownerId, startTime, label, progress, now, d1w) {
  const elapsedMs = now() - startTime;
  if (elapsedMs > TIME_BUDGET_MS) {
    throw new TimeBudgetError(`TIME_BUDGET_EXCEEDED at "${label}" after ${Math.round(elapsedMs / 1000)}s`);
  }
  const renewed = await d1w(lock.renewLock(D1, ownerId), `renew_lock:${label}`);
  if (!renewed) {
    throw new LockLostError(`LOCK_LOST at "${label}" after ${Math.round(elapsedMs / 1000)}s`);
  }
  progress.renewals.push({ label, elapsed_ms: elapsedMs });
  progress.last_checkpoint = label;
  progress.last_checkpoint_at = db.nowIso();
  await persistProgress(D1, progress, d1w);
}

/** Marks the start of a major phase — best-effort, never fatal on its own
 * failure. Lets a future stuck run show "current_operation" even if it
 * hangs before ever reaching the NEXT checkpoint. */
async function beginOperation(D1, label, progress, d1w) {
  progress.current_operation = label;
  progress.current_operation_started_at = db.nowIso();
  await persistProgress(D1, progress, d1w);
}

/** Best-effort observability write — a failure here must never abort the
 * sync itself (this is diagnostics, not correctness), and must never be
 * retried (a single attempt, swallowed on failure — no recursive logging
 * of a logging failure). */
async function persistProgress(D1, progress, d1w) {
  try {
    await d1w(
      db.updateSyncRunNotes(D1, progress.run_id, {
        last_checkpoint: progress.last_checkpoint,
        last_checkpoint_at: progress.last_checkpoint_at,
        current_operation: progress.current_operation,
        current_operation_started_at: progress.current_operation_started_at,
        lease_renewal_count: progress.renewals.length,
      }),
      "persist_progress"
    );
  } catch {
    // best-effort only
  }
}

async function selectEnrichmentCandidates(D1, cap, minScore) {
  const { results } = await D1.prepare(
    `SELECT s.token_address, s.score, s.status FROM scores s
     JOIN (SELECT token_address, MAX(computed_at) mc FROM scores GROUP BY token_address) x
       ON x.token_address=s.token_address AND x.mc=s.computed_at
     ORDER BY s.score DESC`
  ).all();
  const topN = results.slice(0, cap).map((r) => r.token_address);
  const hot = results
    .filter((r) => ["NEW", "EARLY", "HEATING"].includes(r.status) && (r.score || 0) >= minScore)
    .map((r) => r.token_address);
  const combined = new Set([...topN, ...hot]);
  const ordered = results.filter((r) => combined.has(r.token_address)).map((r) => r.token_address);
  return ordered.slice(0, cap);
}

/**
 * Targeted single-launch sync: fetches one token directly via
 * GET /launches/:address (same public, LIVE-only endpoint the list feed
 * uses) and runs it through the identical normalize/upsert/score pipeline
 * as runSync(). Exists because the list feed is newest-first and, on a
 * high-volume launchpad, a launch from several hours ago can sit behind
 * thousands of newer ones. NOT on the hot cron path — not lease-guarded,
 * for manual/internal use only, never concurrently with a production sync.
 * (Upstream calls are still hard-timeout-protected via vibeSource.js.)
 */
export async function runSingleTokenSync(D1, tokenAddress) {
  const id = runId();
  await db.startSyncRun(D1, id, "SINGLE_TOKEN_SYNC", VIBE_CHAIN_ID);

  let errorNote = null;
  let launchRow = null;
  try {
    const raw = await sources.fetchLaunchDetail(tokenAddress);
    const detail = raw?.data || raw;
    launchRow = db.normalizeLaunch(detail, id, VIBE_CHAIN_ID);
    await db.upsertLaunch(D1, launchRow);
    const snapRow = db.normalizeSnapshot(detail, id);
    await db.insertSnapshot(D1, snapRow);

    await db.recomputeCreatorAggregates(D1, launchRow.creator_address ? [launchRow.creator_address] : []);

    const launch = await D1.prepare("SELECT * FROM launches WHERE token_address=?").bind(launchRow.token_address).first();
    const snap = await db.latestSnapshot(D1, launchRow.token_address);
    const creator = await db.getCreator(D1, launch.creator_address);
    const { status } = classifyStatus(launch, snap);
    const flags = riskFlags(launch, snap, creator);
    const scored = computeScore(launch, snap, creator);
    await db.insertScore(D1, launchRow.token_address, scored, status, flags, id);

    try {
      const holdersResp = await sources.fetchLaunchHolders(launchRow.token_address, 10);
      const conc = computeHolderConcentration(holdersResp?.data?.items || []);
      await db.insertHolderEnrichment(D1, launchRow.token_address, conc, id);
    } catch {
      // non-fatal: enrichment is a bonus, never blocks the core sync
    }
    try {
      const activityResp = await sources.fetchLaunchActivity(launchRow.token_address, 25);
      const prev = await db.latestActivityEnrichment(D1, launchRow.token_address);
      const metrics = computeActivityMetrics(activityResp?.data?.items || [], prev ? prev.buy_count : null);
      await db.insertActivityEnrichment(D1, launchRow.token_address, metrics, id);
    } catch {
      // non-fatal
    }
  } catch (e) {
    errorNote = String(e?.message || e);
  }

  await db.recordSyncRun(D1, id, {
    finished_at: db.nowIso(),
    status: errorNote ? "FAILED" : "COMPLETED",
    source: "LIVE",
    pages_fetched: 0,
    launches_seen: launchRow ? 1 : 0,
    launches_new: 0,
    snapshots_written: launchRow ? 1 : 0,
    creators_updated: 0,
    scores_written: launchRow ? 1 : 0,
    error: errorNote,
    notes_json: JSON.stringify({ mode: "SINGLE_TOKEN_SYNC", token_address: tokenAddress }),
  });

  return { run_id: id, token_address: tokenAddress, status: errorNote ? "FAILED" : "COMPLETED", error: errorNote };
}

/**
 * Public entry point — ALWAYS lease-guarded. See src/lock.js for the full
 * mechanism/TTL reasoning. A second invocation that finds the lease already
 * held performs ZERO upstream vibe/vibe calls and ZERO launch/snapshot/
 * enrichment writes: it records a truthful SKIPPED_LOCKED sync_runs row
 * (never a fabricated COMPLETED) and returns immediately. This is expected,
 * routine behavior when cron overlaps a still-running sync — not an error.
 */
export async function runSync(D1, opts = {}) {
  const d1WriteTimeoutMs = opts.d1WriteTimeoutMs ?? D1_WRITE_TIMEOUT_MS;
  const ownerId = lock.newOwnerId();
  const acquired = await lock.tryAcquireLock(D1, ownerId);
  if (!acquired) {
    const lockState = await lock.getLockState(D1);
    const id = runId();
    await db.startSyncRun(D1, id, "SYNC", VIBE_CHAIN_ID);
    await db.recordSyncRun(D1, id, {
      finished_at: db.nowIso(),
      status: "SKIPPED_LOCKED",
      source: "LIVE",
      pages_fetched: 0,
      launches_seen: 0,
      launches_new: 0,
      snapshots_written: 0,
      creators_updated: 0,
      scores_written: 0,
      error: null,
      notes_json: JSON.stringify({ locked_by: lockState.owner_id, lock_expires_at: lockState.expires_at }),
    });
    return { run_id: id, status: "SKIPPED_LOCKED", locked_by: lockState.owner_id };
  }
  try {
    return await runSyncLocked(D1, ownerId, opts);
  } finally {
    // Defensive: only deletes if owner_id still matches. If the lease was
    // already lost (checkpoint threw LockLostError), this is correctly a
    // harmless no-op rather than releasing someone else's active lease.
    // Best-effort/bounded — releasing must never itself hang forever.
    await withTimeout(lock.releaseLock(D1, ownerId), d1WriteTimeoutMs, "release_lock").catch(() => {});
  }
}

async function runSyncLocked(
  D1,
  ownerId,
  {
    pages = SYNC_MAX_PAGES,
    pageLimit = SYNC_PAGE_LIMIT,
    includeEnrichment = true,
    enrichmentCap = ENRICHMENT_CAP,
    now = () => Date.now(),
    // Configurable so tests can exercise real timeout behavior in
    // milliseconds instead of waiting out the real 20-30s production
    // values. Production code never passes these — it relies on the
    // documented defaults from src/timeouts.js.
    d1QueryTimeoutMs = D1_QUERY_TIMEOUT_MS,
    d1WriteTimeoutMs = D1_WRITE_TIMEOUT_MS,
    d1HeavyTimeoutMs = MAX_HEAVY_DB_OPERATION_MS,
    // Watermark-based incremental mode (GitHub Actions redesign) — see
    // docs/DEPLOYMENT.md. When true, `pages` above is ignored: pagination
    // is bounded by INITIAL_BACKFILL_PAGES (no watermark yet) or
    // MAX_INCREMENTAL_PAGES (watermark exists) instead, and stops as soon
    // as a page's items are no longer newer than the stored watermark.
    // ONE shared code path — this is the exact same function the
    // (disabled) Worker cron path and the GitHub Actions entrypoint both
    // call; no forked/duplicate sync logic exists anywhere.
    incremental = false,
  } = {}
) {
  // Thin, labeled wrappers so every call site below reads as "this D1 op is
  // bounded" without repeating a timeout value everywhere. d1heavy is for
  // operations legitimately touching many rows in one logical step
  // (creator aggregation, the pre-scoring batched-lookup cluster, the
  // enrichment-candidate scan) — everything else is a single-row-ish
  // read/write and gets the tighter default.
  const d1r = (p, label) => withTimeout(p, d1QueryTimeoutMs, label);
  const d1w = (p, label) => withTimeout(p, d1WriteTimeoutMs, label);
  const d1heavy = (p, label) => withTimeout(p, d1HeavyTimeoutMs, label);

  const id = runId();
  const startTime = now();
  await db.startSyncRun(D1, id, "SYNC", VIBE_CHAIN_ID);
  const progress = {
    run_id: id,
    renewals: [],
    last_checkpoint: null,
    last_checkpoint_at: null,
    current_operation: null,
    current_operation_started_at: null,
  };
  const cp = (label) => checkpoint(D1, ownerId, startTime, label, progress, now, d1w);
  const beginOp = (label) => beginOperation(D1, label, progress, d1w);

  let pagesFetched = 0;
  let launchesSeen = 0;
  let launchesNew = 0;
  let snapshotsWritten = 0;
  const touched = new Set();
  const touchedCreators = new Set();
  let errorNote = null;
  let creatorsUpdated = 0;
  let buildersUpdated = 0;
  let scoresWritten = 0;
  let enrichment = { candidates: 0, holders_enriched: 0, activity_enriched: 0, errors: 0 };

  // Incremental-only bookkeeping. watermark is the createdAt boundary
  // loaded from sync_state (null = no prior successful cycle, i.e. a
  // bounded initial backfill). maxCreatedAtSeen tracks the newest
  // created_at actually observed via PAGINATION this cycle (never
  // affected by the own-$PULSE targeted refresh below, which may touch an
  // arbitrarily old launch) — this is what advances the watermark on
  // success, and only ever forward, never backward.
  let watermark = null;
  let maxCreatedAtSeen = null;
  let ownProjectRefreshed = false;
  if (incremental) {
    const state = await d1r(db.getSyncState(D1), "get_sync_state");
    watermark = state?.last_seen_created_at || null;
  }
  const effectivePages = incremental ? (watermark ? MAX_INCREMENTAL_PAGES : INITIAL_BACKFILL_PAGES) : pages;

  try {
    await beginOp("page_fetch_loop");
    let cursor = undefined;
    let reachedWatermark = false;
    for (let i = 0; i < Math.max(1, effectivePages) && !reachedWatermark; i++) {
      let resp;
      try {
        resp = await sources.fetchLaunches(cursor, pageLimit);
      } catch (e) {
        errorNote = String(e?.message || e);
        break;
      }
      const items = resp?.data?.items || [];
      pagesFetched++;
      // Rows are collected per page and written via ONE batch() round-trip
      // each (see db.js's upsertLaunchRows/insertSnapshotRows) instead of
      // one REST call per row — a page can hold ~100+ items, and
      // per-row writes were a secondary contributor to the 2026-09-14
      // FAILED_OPERATION_TIMEOUT incident (the primary one, creator
      // aggregation, is fixed the same way).
      const pageLaunchRows = [];
      const pageSnapRows = [];
      for (const raw of items) {
        // Feed is newest-first (verified in vibeSource.js/db.js usage) —
        // once we reach a launch at or older than the watermark, every
        // remaining item on this page and beyond is already known; stop
        // processing immediately rather than doing redundant idempotent
        // work.
        if (incremental && watermark && raw.createdAt && raw.createdAt <= watermark) {
          reachedWatermark = true;
          break;
        }
        launchesSeen++;
        const launchRow = db.normalizeLaunch(raw, id, VIBE_CHAIN_ID);
        if (!launchRow.token_address) continue;
        pageLaunchRows.push(launchRow);
        pageSnapRows.push(db.normalizeSnapshot(raw, id));
        touched.add(launchRow.token_address);
        if (launchRow.creator_address) touchedCreators.add(launchRow.creator_address);
        if (incremental && raw.createdAt && (!maxCreatedAtSeen || raw.createdAt > maxCreatedAtSeen)) {
          maxCreatedAtSeen = raw.createdAt;
        }
        if (launchRow.token_address === PULSE_TOKEN_ADDRESS) ownProjectRefreshed = true;
      }
      if (pageLaunchRows.length) {
        const { newCount } = await d1heavy(db.upsertLaunchRows(D1, pageLaunchRows), "upsert_launch_rows");
        launchesNew += newCount;
      }
      if (pageSnapRows.length) {
        snapshotsWritten += await d1heavy(db.insertSnapshotRows(D1, pageSnapRows), "insert_snapshot_rows");
      }
      // Checkpoint: after each page's fetch + upserts (not just once at
      // the end) — protects a manually-widened `pages` run (e.g. a deep
      // catch-up backfill) from losing its lease mid-fetch.
      await cp(`after_page_${i + 1}_fetch_and_upserts`);
      const pageMeta = resp?.data?.page || {};
      cursor = pageMeta.nextCursor;
      if (!pageMeta.hasMore || !cursor) break;
    }

    // Bounded refresh set (incremental mode only): own $PULSE must never
    // silently fall outside the watermark window just because it isn't
    // among the newest launches. One extra targeted, bounded fetch — same
    // public detail endpoint runSingleTokenSync() uses — never a second
    // scoring implementation.
    if (incremental && !ownProjectRefreshed) {
      await beginOp("own_project_refresh");
      try {
        const raw = await sources.fetchLaunchDetail(PULSE_TOKEN_ADDRESS);
        const detail = raw?.data || raw;
        if (detail?.tokenAddress) {
          const launchRow = db.normalizeLaunch(detail, id, VIBE_CHAIN_ID);
          const isNew = await d1w(db.upsertLaunch(D1, launchRow), "upsert_launch_own_project");
          if (isNew) launchesNew++;
          const snapRow = db.normalizeSnapshot(detail, id);
          const wrote = await d1w(db.insertSnapshot(D1, snapRow), "insert_snapshot_own_project");
          if (wrote) snapshotsWritten++;
          launchesSeen++;
          touched.add(launchRow.token_address);
          if (launchRow.creator_address) touchedCreators.add(launchRow.creator_address);
        }
      } catch {
        // non-fatal: own-project refresh is a bonus guarantee, never
        // blocks the rest of the cycle — it will simply retry next cycle.
      }
      await cp("after_own_project_refresh");
    }

    await beginOp("creator_aggregation");
    creatorsUpdated = await d1heavy(db.recomputeCreatorAggregates(D1, [...touchedCreators]), "recompute_creator_aggregates");
    await cp("after_creator_aggregation");

    await beginOp("builders_fetch");
    try {
      const [alltime, season] = await Promise.all([
        sources.fetchBuilders(100).catch(() => null),
        sources.fetchSeasonBuilders(100).catch(() => null),
      ]);
      if (alltime || season) {
        buildersUpdated = await d1w(db.storeBuilderRanks(D1, alltime?.data?.items, season?.data?.items), "store_builder_ranks");
      }
    } catch {
      // non-fatal: builder leaderboard is a bonus enrichment, never blocks sync
    }
    await cp("before_scoring");

    await beginOp("scoring");
    // Batched reads (see the recomputeCreatorAggregates incident note in
    // db.js): touched.size can be up to ~150/sync, and 4 sequential D1
    // round-trips per token was a secondary contributor to sync duration.
    // Writes are batched too now (insertScoreRows, one batch() call per
    // 50-token flush) — scores is append-only (plain INSERT, no ON
    // CONFLICT), so there's no read-before-write cost to batching it,
    // unlike upsertLaunchRows.
    const touchedList = [...touched];
    const [launchesMap, scoreSnapshotsMap, scoreCreatorsMap] = await d1heavy(
      Promise.all([db.launchesFor(D1, touchedList), db.latestSnapshotsFor(D1, touchedList), db.creatorsFor(D1, [...touchedCreators])]),
      "batched_score_lookups"
    );
    let pendingScoreRows = [];
    const flushScores = async (label) => {
      if (!pendingScoreRows.length) return;
      scoresWritten += await d1heavy(db.insertScoreRows(D1, pendingScoreRows), "insert_score_rows");
      pendingScoreRows = [];
      await cp(label);
    };
    for (const tokenAddress of touchedList) {
      const launch = launchesMap.get(tokenAddress);
      if (!launch) continue;
      const snap = scoreSnapshotsMap.get(tokenAddress) || null;
      const creator = launch.creator_address ? scoreCreatorsMap.get(launch.creator_address) || null : null;
      const { status } = classifyStatus(launch, snap);
      const flags = riskFlags(launch, snap, creator);
      const scored = computeScore(launch, snap, creator);
      pendingScoreRows.push({ tokenAddress, scored, status, flags, runId: id });
      // Flush + checkpoint every 50 tokens (natural batch boundary — not a
      // timer) in case a widened touch set makes scoring itself
      // long-running.
      if (pendingScoreRows.length >= 50) {
        await flushScores(`scoring_batch_${scoresWritten + pendingScoreRows.length}`);
      }
    }
    await flushScores("scoring_final_flush");

    if (includeEnrichment) {
      await beginOp("enrichment");
      const candidates = await d1heavy(selectEnrichmentCandidates(D1, enrichmentCap, ENRICHMENT_MIN_SCORE), "select_enrichment_candidates");
      let holdersDone = 0;
      let activityDone = 0;
      let errors = 0;
      let idx = 0;
      for (const tokenAddress of candidates) {
        try {
          const holdersResp = await sources.fetchLaunchHolders(tokenAddress, 10);
          const items = holdersResp?.data?.items || [];
          const conc = computeHolderConcentration(items);
          await d1w(db.insertHolderEnrichment(D1, tokenAddress, conc, id), "insert_holder_enrichment");
          holdersDone++;
        } catch {
          errors++;
        }
        try {
          const activityResp = await sources.fetchLaunchActivity(tokenAddress, 25);
          const items = activityResp?.data?.items || [];
          const prev = await d1r(db.latestActivityEnrichment(D1, tokenAddress), "latest_activity_enrichment");
          const metrics = computeActivityMetrics(items, prev ? prev.buy_count : null);
          await d1w(db.insertActivityEnrichment(D1, tokenAddress, metrics, id), "insert_activity_enrichment");
          activityDone++;
        } catch {
          errors++;
        }
        idx++;
        // Checkpoint: periodically during enrichment batches.
        if (idx % 10 === 0) {
          await cp(`enrichment_batch_${idx}`);
        }
      }
      enrichment = { candidates: candidates.length, holders_enriched: holdersDone, activity_enriched: activityDone, errors };
      // Checkpoint: after holder/activity enrichment batches complete.
      await cp("after_enrichment");
    }

    await beginOp("final_write");
    // Checkpoint: before the final completion write.
    await cp("before_final_completion_write");

    const status = errorNote && pagesFetched === 0 ? "FAILED" : "COMPLETED";

    // Watermark only ever advances forward, and ONLY on a genuinely
    // successful (COMPLETED) cycle — a FAILED cycle (e.g. the very first
    // upstream fetch failed) leaves sync_state untouched so nothing is
    // silently skipped on the next attempt.
    let watermarkAdvanced = false;
    if (incremental && status === "COMPLETED" && maxCreatedAtSeen && (!watermark || maxCreatedAtSeen > watermark)) {
      await d1w(
        db.upsertSyncState(D1, { last_seen_created_at: maxCreatedAtSeen, last_successful_sync: db.nowIso() }),
        "upsert_sync_state"
      );
      watermarkAdvanced = true;
    } else if (incremental && status === "COMPLETED") {
      // Nothing newer than the existing watermark this cycle (a genuine
      // zero-new-launch cycle) — still record that we ran successfully.
      await d1w(db.upsertSyncState(D1, { last_successful_sync: db.nowIso() }), "upsert_sync_state");
    }

    await d1w(
      db.recordSyncRun(D1, id, {
        finished_at: db.nowIso(),
        status,
        source: "LIVE",
        pages_fetched: pagesFetched,
        launches_seen: launchesSeen,
        launches_new: launchesNew,
        snapshots_written: snapshotsWritten,
        creators_updated: creatorsUpdated,
        scores_written: scoresWritten,
        error: errorNote,
        notes_json: JSON.stringify({
          builders_updated: buildersUpdated,
          enrichment,
          lease_renewal_count: progress.renewals.length,
          incremental,
          watermark_before: watermark,
          watermark_after: watermarkAdvanced ? maxCreatedAtSeen : watermark,
        }),
      }),
      "record_sync_run_completed"
    );

    return {
      run_id: id, status, pages_fetched: pagesFetched, launches_seen: launchesSeen,
      launches_new: launchesNew, snapshots_written: snapshotsWritten, creators_updated: creatorsUpdated,
      builders_updated: buildersUpdated, scores_written: scoresWritten, error: errorNote, enrichment,
      lease_renewals: progress.renewals.length,
      watermark_before: watermark, watermark_after: watermarkAdvanced ? maxCreatedAtSeen : watermark,
    };
  } catch (e) {
    const isTimeout = e instanceof OperationTimeoutError;
    const isLockLost = e instanceof LockLostError;
    const isTimeBudget = e instanceof TimeBudgetError;
    if (isLockLost || isTimeBudget || isTimeout) {
      const abortStatus = isLockLost ? "FAILED_LOCK_LOST" : isTimeBudget ? "FAILED_TIME_BUDGET" : "FAILED_OPERATION_TIMEOUT";
      // Best-effort, ONE attempt — see persistProgress's comment: if the
      // original failure was itself a D1 timeout, this terminal write may
      // also fail OR hang the same way. It is bounded by its own timeout
      // (so a hung logging attempt can never itself hang the function
      // forever) and never retried/looped; a swallowed failure here just
      // leaves the row as an honest orphaned RUNNING artifact, exactly
      // like a genuine platform-level kill.
      try {
        await d1w(db.recordSyncRun(D1, id, {
          finished_at: db.nowIso(),
          status: abortStatus,
          source: "LIVE",
          pages_fetched: pagesFetched,
          launches_seen: launchesSeen,
          launches_new: launchesNew,
          snapshots_written: snapshotsWritten,
          creators_updated: creatorsUpdated,
          scores_written: scoresWritten,
          error: e.message,
          notes_json: JSON.stringify({
            builders_updated: buildersUpdated,
            enrichment,
            lease_renewal_count: progress.renewals.length,
            last_checkpoint: progress.last_checkpoint,
            last_checkpoint_at: progress.last_checkpoint_at,
            current_operation: progress.current_operation,
            current_operation_started_at: progress.current_operation_started_at,
            aborted: true,
          }),
        }), "terminal_status_write");
      } catch {
        // single attempt only — never recurse into trying to log the
        // logging failure itself
      }
      return {
        run_id: id, status: abortStatus, error: e.message, pages_fetched: pagesFetched,
        launches_seen: launchesSeen, scores_written: scoresWritten, lease_renewals: progress.renewals.length,
        last_checkpoint: progress.last_checkpoint, current_operation: progress.current_operation,
      };
    }
    // Any other unexpected error: preserve prior behavior — bubble up so
    // the outer runSync()'s finally still attempts a (harmless, ownership-
    // checked) lock release. The sync_runs row is left as a genuine
    // orphaned RUNNING artifact, exactly like a real platform-level kill —
    // never silently rewritten as COMPLETED or FAILED after the fact.
    throw e;
  }
}
