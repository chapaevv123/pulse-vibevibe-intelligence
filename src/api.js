/**
 * PUBLIC READ-ONLY API (public demo)
 * =====================================
 * Every route here is GET-only. There is no POST/PUT/PATCH/DELETE route
 * anywhere in this Worker — the only way data is written is the internal
 * sync job, invoked directly from the scheduled() handler (see index.js),
 * never via an HTTP request a visitor could hit.
 */
import * as db from "./db.js";
import * as lock from "./lock.js";
import { PULSE_TOKEN_ADDRESS, PULSE_CREATOR_ADDRESS, PULSE_PROJECT_NAME, PULSE_PROJECT_TICKER, VIBE_CHAIN_ID, VIBE_CHAIN_NAME } from "./config.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

// Pure: assembles the API launch-row shape from already-fetched rows. Never
// issues its own D1 calls — callers fetch (individually for one launch, or
// batched for many) and pass the results in.
function buildLaunchRow(launch, { snap, score, creator, holders, activity }) {
  return {
    token_address: launch.token_address,
    name: launch.name,
    symbol: launch.symbol,
    creator_address: launch.creator_address,
    created_at: launch.created_at,
    project_url: launch.project_url,
    is_own_project: !!launch.is_own_project,
    status: score ? score.status : "UNKNOWN",
    score: score ? score.score : null,
    flags: score?.flags_json ? JSON.parse(score.flags_json) : [],
    market: snap
      ? {
          lifecycle: snap.lifecycle,
          progress_bps: snap.progress_bps,
          last_price_wei_per_token: snap.last_price_wei_per_token,
          buy_count_1h: snap.buy_count_1h,
          sell_count_1h: snap.sell_count_1h,
          holder_count: snap.holder_count,
          analytics_status: snap.analytics_status,
          observed_at: snap.observed_at,
        }
      : null,
    creator: creator
      ? {
          official_rank_alltime: creator.official_rank_alltime,
          official_launch_count_alltime: creator.official_launch_count_alltime,
          official_pace_label: creator.official_pace_label,
          total_launches_tracked: creator.total_launches_tracked,
        }
      : null,
    holder_enrichment: holders
      ? {
          top1_nonprotocol_share_bps: holders.top_nonprotocol_share_bps,
          top3_nonprotocol_share_bps: holders.top3_nonprotocol_share_bps,
          concentration_flags: holders.concentration_flags_json ? JSON.parse(holders.concentration_flags_json) : [],
        }
      : null,
    activity_enrichment: activity
      ? {
          buy_count: activity.buy_count,
          sell_count: activity.sell_count,
          unique_buyers: activity.unique_buyers,
          buy_count_acceleration: activity.buy_count_acceleration,
        }
      : null,
  };
}

// One-launch path (handleOwnProject, handleLaunchDetail): five individual
// D1 calls is fine for a single row.
async function loadLaunchRowSingle(D1, launch) {
  const [snap, score, creator, holders, activity] = await Promise.all([
    db.latestSnapshot(D1, launch.token_address),
    db.latestScore(D1, launch.token_address),
    db.getCreator(D1, launch.creator_address),
    db.latestHolderEnrichment(D1, launch.token_address),
    db.latestActivityEnrichment(D1, launch.token_address),
  ]);
  return buildLaunchRow(launch, { snap, score, creator, holders, activity });
}

export async function handleSummary(D1) {
  const { results: launches } = await D1.prepare("SELECT created_at FROM launches").all();
  const { results: scoreRows } = await D1.prepare(
    `SELECT s.status, s.score FROM scores s
     JOIN (SELECT token_address, MAX(computed_at) mc FROM scores GROUP BY token_address) x
       ON x.token_address=s.token_address AND x.mc=s.computed_at`
  ).all();
  const counts = { NEW: 0, EARLY: 0, HEATING: 0, CROWDED: 0, UNKNOWN: 0 };
  const scores = [];
  for (const r of scoreRows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.score !== null) scores.push(r.score);
  }
  scores.sort((a, b) => a - b);
  const today = new Date().toISOString().slice(0, 10);
  const launchesToday = launches.filter((l) => (l.created_at || "").slice(0, 10) === today).length;
  const lastSync = await D1.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1").first();

  return json({
    total_launches: launches.length,
    launches_today: launchesToday,
    status_counts: counts,
    score_mean: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    score_median: scores.length ? scores[Math.floor(scores.length / 2)] : null,
    last_sync_at: lastSync?.finished_at || null,
    last_sync_status: lastSync?.status || "NEVER_RUN",
    data_source: "LIVE",
    chain_id: VIBE_CHAIN_ID,
    chain_name: VIBE_CHAIN_NAME,
  });
}

export async function handleLaunches(D1, url) {
  const status = (url.searchParams.get("status") || "").toUpperCase();
  const minScore = url.searchParams.get("min_score");
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);

  const { results: launches } = await D1.prepare("SELECT * FROM launches ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  // Batched, not per-row — see db.js latestPerTokenBatch: N launches must
  // never cost N x5 separate D1 round-trips (Cloudflare's per-invocation
  // subrequest ceiling).
  const tokenAddresses = launches.map((l) => l.token_address);
  const creatorAddresses = launches.map((l) => l.creator_address);
  const [snapshots, scoresMap, creators, holdersMap, activityMap] = await Promise.all([
    db.latestSnapshotsFor(D1, tokenAddresses),
    db.latestScoresFor(D1, tokenAddresses),
    db.creatorsFor(D1, creatorAddresses),
    db.latestHolderEnrichmentsFor(D1, tokenAddresses),
    db.latestActivityEnrichmentsFor(D1, tokenAddresses),
  ]);
  let rows = launches.map((l) =>
    buildLaunchRow(l, {
      snap: snapshots.get(l.token_address) || null,
      score: scoresMap.get(l.token_address) || null,
      creator: creators.get(l.creator_address) || null,
      holders: holdersMap.get(l.token_address) || null,
      activity: activityMap.get(l.token_address) || null,
    })
  );

  if (status) rows = rows.filter((r) => r.status === status);
  if (minScore) rows = rows.filter((r) => (r.score || 0) >= Number(minScore));
  if (q) rows = rows.filter((r) => (r.name || "").toLowerCase().includes(q) || (r.symbol || "").toLowerCase().includes(q));

  return json({ count: rows.length, launches: rows });
}

export async function handleLaunchDetail(D1, tokenAddress) {
  const launch = await D1.prepare("SELECT * FROM launches WHERE token_address=?").bind(tokenAddress.toLowerCase()).first();
  if (!launch) return json({ error: "NOT_FOUND" }, 404);
  return json(await loadLaunchRowSingle(D1, launch));
}

export async function handleCreators(D1) {
  const { results } = await D1.prepare("SELECT * FROM creators ORDER BY total_launches_tracked DESC LIMIT 200").all();
  return json({
    count: results.length,
    creators: results.map((c) => ({
      creator_address: c.creator_address,
      total_launches_tracked: c.total_launches_tracked,
      official_rank_alltime: c.official_rank_alltime,
      official_launch_count_alltime: c.official_launch_count_alltime,
      official_pace_label: c.official_pace_label,
      first_observed_at: c.first_observed_at,
      latest_observed_at: c.latest_observed_at,
    })),
  });
}

export async function handleOwnProject(D1) {
  const launch = await D1.prepare("SELECT * FROM launches WHERE token_address=?").bind(PULSE_TOKEN_ADDRESS).first();
  if (!launch) {
    return json({
      configured: true,
      status: "NOT_YET_LAUNCHED",
      token_address: PULSE_TOKEN_ADDRESS,
      creator_address: PULSE_CREATOR_ADDRESS,
      name: PULSE_PROJECT_NAME,
      symbol: PULSE_PROJECT_TICKER,
    });
  }
  const row = await loadLaunchRowSingle(D1, launch);
  return json({ configured: true, status: "LAUNCHED", ...row });
}

export async function handleHealth(D1, env) {
  let dbOk = true;
  try {
    await D1.prepare("SELECT 1").first();
  } catch {
    dbOk = false;
  }

  // current_sync_active is derived ONLY from the sync_lock table (see
  // src/lock.js) — never from sync_runs.status. A historical sync_runs row
  // stuck at status='RUNNING' (e.g. an orphaned invocation from a past
  // incident) must never make health report an active sync forever; the
  // lock has its own TTL and reflects only genuinely current state.
  const lockState = await lock.getLockState(D1).catch(() => ({ active: false, owner_id: null }));

  // last_completed_sync / last_sync_result deliberately exclude raw
  // 'RUNNING' rows — a RUNNING row is either the currently-active sync
  // (already covered by current_sync_active) or a stale orphan, and either
  // way it is never a meaningful "last result."
  const lastCompleted = await D1.prepare(
    "SELECT run_id, started_at, finished_at, status, launches_seen, scores_written FROM sync_runs WHERE status='COMPLETED' ORDER BY started_at DESC LIMIT 1"
  )
    .first()
    .catch(() => null);
  const lastResult = await D1.prepare(
    `SELECT run_id, started_at, finished_at, status, error FROM sync_runs
     WHERE status IN ('COMPLETED','FAILED','SKIPPED_LOCKED','FAILED_LOCK_LOST','FAILED_TIME_BUDGET','FAILED_OPERATION_TIMEOUT')
     ORDER BY started_at DESC LIMIT 1`
  )
    .first()
    .catch(() => null);

  const nowMs = Date.now();
  const leaseAgeSeconds = lockState.active && lockState.acquired_at ? Math.round((nowMs - Date.parse(lockState.acquired_at)) / 1000) : null;

  return json({
    ok: dbOk,
    d1: dbOk ? "OK" : "UNAVAILABLE",
    current_sync_active: lockState.active,
    current_sync_owner: lockState.active ? lockState.owner_id : null,
    current_sync_expires_at: lockState.active ? lockState.expires_at : null,
    current_sync_lease_age_seconds: leaseAgeSeconds,
    last_completed_sync: lastCompleted || null,
    last_sync_result: lastResult || null,
    // Kept for backward compatibility with existing consumers/tests —
    // now sourced from last_sync_result, never from a raw stale RUNNING row.
    last_sync_status: lastResult?.status || "NEVER_RUN",
    last_sync_at: lastResult?.finished_at || null,
    chain_id: VIBE_CHAIN_ID,
    time: new Date().toISOString(),
  });
}
