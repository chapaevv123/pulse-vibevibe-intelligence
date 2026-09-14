/**
 * D1 DATA-ACCESS LAYER (public demo)
 * ====================================
 * Thin, explicit helpers over the Worker's D1 binding. No ORM. Every write
 * here is idempotent (INSERT ... ON CONFLICT or INSERT OR IGNORE) so a
 * cron re-run never duplicates rows.
 */
import { PULSE_TOKEN_ADDRESS, PULSE_CREATOR_ADDRESS, PROJECT_URL } from "./config.js";

function nowIso() {
  return new Date().toISOString();
}

function sid(...parts) {
  // Deterministic-enough id for a snapshot row; D1 doesn't need
  // cryptographic uniqueness here, just stability across a re-run of the
  // same (token, as_of_block) pair.
  const raw = parts.map(String).join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return `snap_${(h >>> 0).toString(16)}_${Date.now().toString(36)}`;
}

function isOwnProject(tokenAddress, creatorAddress) {
  const t = (tokenAddress || "").toLowerCase();
  const c = (creatorAddress || "").toLowerCase();
  return t === PULSE_TOKEN_ADDRESS || c === PULSE_CREATOR_ADDRESS;
}

export function normalizeLaunch(raw, runId, chainId) {
  const tokenAddress = (raw.tokenAddress || "").toLowerCase();
  const creatorAddress = (raw.creatorAddress || "").toLowerCase() || null;
  return {
    token_address: tokenAddress,
    chain_id: chainId,
    launch_id: raw.launchId || null,
    name: raw.name || null,
    symbol: raw.symbol || null,
    decimals: raw.decimals ?? null,
    creator_address: creatorAddress,
    creator_vault_address: (raw.creatorVaultAddress || "").toLowerCase() || null,
    curve_address: (raw.curveAddress || "").toLowerCase() || null,
    quote_asset_address: (raw.quoteAssetAddress || "").toLowerCase() || null,
    created_at: raw.createdAt || null,
    description: raw.content?.description || null,
    image_uri: raw.content?.image?.uri || null,
    metadata_uri: raw.metadata?.uri || null,
    metadata_integrity: raw.metadata?.integrity || null,
    project_url: tokenAddress ? PROJECT_URL(tokenAddress) : null,
    source: "LIVE",
    is_own_project: isOwnProject(tokenAddress, creatorAddress) ? 1 : 0,
    last_run_id: runId,
  };
}

export function normalizeSnapshot(raw, runId) {
  const tokenAddress = (raw.tokenAddress || "").toLowerCase();
  if (!tokenAddress) return null;
  const curve = raw.curve || {};
  const analytics = raw.analytics || {};
  const asOfBlock = raw.asOfBlock !== undefined && raw.asOfBlock !== null ? String(raw.asOfBlock) : null;
  return {
    snapshot_id: sid(tokenAddress, asOfBlock ?? Math.random()),
    token_address: tokenAddress,
    observed_at: nowIso(),
    as_of_block: asOfBlock,
    run_id: runId,
    lifecycle: curve.lifecycle || null,
    progress_bps: curve.progressBps ?? null,
    tokens_sold_base_units: curve.tokensSoldBaseUnits || null,
    net_raised_wei: curve.netRaisedWei || null,
    net_target_wei: curve.netTargetWei || null,
    last_price_wei_per_token: analytics.lastPriceWeiPerToken || null,
    volume_1h_wei: analytics.volume1hWei || null,
    volume_24h_wei: analytics.volume24hWei || null,
    price_change_1h_bps: analytics.priceChange1hBps ?? null,
    price_change_24h_bps: analytics.priceChange24hBps ?? null,
    buy_count_1h: analytics.buyCount1h ?? null,
    sell_count_1h: analytics.sellCount1h ?? null,
    unique_buyers_1h: analytics.uniqueBuyers1h ?? null,
    holder_count: raw.holderCount ?? null,
    analytics_status: analytics.status || null,
  };
}

export async function upsertLaunch(db, row) {
  const existing = await db
    .prepare("SELECT token_address, first_seen_at FROM launches WHERE token_address = ?")
    .bind(row.token_address)
    .first();
  const ts = nowIso();
  if (existing) {
    await db
      .prepare(
        `UPDATE launches SET name=?,symbol=?,decimals=?,creator_address=?,creator_vault_address=?,
         curve_address=?,quote_asset_address=?,created_at=?,description=?,image_uri=?,metadata_uri=?,
         metadata_integrity=?,project_url=?,source=?,is_own_project=?,updated_at=?,last_run_id=?
         WHERE token_address=?`
      )
      .bind(
        row.name, row.symbol, row.decimals, row.creator_address, row.creator_vault_address,
        row.curve_address, row.quote_asset_address, row.created_at, row.description, row.image_uri,
        row.metadata_uri, row.metadata_integrity, row.project_url, row.source, row.is_own_project,
        ts, row.last_run_id, row.token_address
      )
      .run();
    return false;
  }
  await db
    .prepare(
      `INSERT INTO launches(token_address,chain_id,launch_id,name,symbol,decimals,creator_address,
       creator_vault_address,curve_address,quote_asset_address,created_at,description,image_uri,
       metadata_uri,metadata_integrity,project_url,source,is_own_project,first_seen_at,updated_at,last_run_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      row.token_address, row.chain_id, row.launch_id, row.name, row.symbol, row.decimals,
      row.creator_address, row.creator_vault_address, row.curve_address, row.quote_asset_address,
      row.created_at, row.description, row.image_uri, row.metadata_uri, row.metadata_integrity,
      row.project_url, row.source, row.is_own_project, ts, ts, row.last_run_id
    )
    .run();
  return true;
}

export async function insertSnapshot(db, row) {
  if (!row) return false;
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO market_snapshots(
       snapshot_id,token_address,observed_at,as_of_block,run_id,lifecycle,progress_bps,
       tokens_sold_base_units,net_raised_wei,net_target_wei,last_price_wei_per_token,
       volume_1h_wei,volume_24h_wei,price_change_1h_bps,price_change_24h_bps,
       buy_count_1h,sell_count_1h,unique_buyers_1h,holder_count,analytics_status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      row.snapshot_id, row.token_address, row.observed_at, row.as_of_block, row.run_id,
      row.lifecycle, row.progress_bps, row.tokens_sold_base_units, row.net_raised_wei,
      row.net_target_wei, row.last_price_wei_per_token, row.volume_1h_wei, row.volume_24h_wei,
      row.price_change_1h_bps, row.price_change_24h_bps, row.buy_count_1h, row.sell_count_1h,
      row.unique_buyers_1h, row.holder_count, row.analytics_status
    )
    .run();
  return (res.meta?.changes || 0) > 0;
}

export async function latestSnapshot(db, tokenAddress) {
  return db
    .prepare("SELECT * FROM market_snapshots WHERE token_address=? ORDER BY observed_at DESC LIMIT 1")
    .bind(tokenAddress)
    .first();
}

/**
 * Batched "latest row per token" lookups. A page rendering N launches must
 * never issue N separate D1 round-trips per table — Cloudflare enforces a
 * hard per-invocation subrequest ceiling, and N x 5 lookups (snapshot,
 * score, creator, holder, activity) blows past it well before N reaches a
 * few hundred. Each of these takes the full visible token-address list and
 * returns one query's worth of "latest per token" rows via a window
 * function, scoped with WHERE token_address IN (...).
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Cloudflare D1 caps bound parameters at 100/query (well below SQLite's
// classic 999-variable ceiling) — confirmed by a live "too many SQL
// variables" failure at 200. 90 stays safely under that with margin.
const D1_SAFE_IN_CHUNK = 90;

async function latestPerTokenBatch(db, table, tokenAddresses, orderCol) {
  const map = new Map();
  const addrs = [...new Set(tokenAddresses.filter(Boolean))];
  if (!addrs.length) return map;
  for (const part of chunk(addrs, D1_SAFE_IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY token_address ORDER BY ${orderCol} DESC) rn
           FROM ${table} WHERE token_address IN (${placeholders})
         ) WHERE rn = 1`
      )
      .bind(...part)
      .all();
    for (const r of results) map.set(r.token_address, r);
  }
  return map;
}

export const latestSnapshotsFor = (db, tokenAddresses) => latestPerTokenBatch(db, "market_snapshots", tokenAddresses, "observed_at");
export const latestScoresFor = (db, tokenAddresses) => latestPerTokenBatch(db, "scores", tokenAddresses, "computed_at");
export const latestHolderEnrichmentsFor = (db, tokenAddresses) => latestPerTokenBatch(db, "holder_enrichment", tokenAddresses, "observed_at");
export const latestActivityEnrichmentsFor = (db, tokenAddresses) => latestPerTokenBatch(db, "activity_enrichment", tokenAddresses, "observed_at");

export async function launchesFor(db, tokenAddresses) {
  const map = new Map();
  const addrs = [...new Set(tokenAddresses.filter(Boolean))];
  if (!addrs.length) return map;
  for (const part of chunk(addrs, D1_SAFE_IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(",");
    const { results } = await db.prepare(`SELECT * FROM launches WHERE token_address IN (${placeholders})`).bind(...part).all();
    for (const r of results) map.set(r.token_address, r);
  }
  return map;
}

export async function creatorsFor(db, creatorAddresses) {
  const map = new Map();
  const addrs = [...new Set(creatorAddresses.filter(Boolean))];
  if (!addrs.length) return map;
  for (const part of chunk(addrs, D1_SAFE_IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(",");
    const { results } = await db.prepare(`SELECT * FROM creators WHERE creator_address IN (${placeholders})`).bind(...part).all();
    for (const r of results) map.set(r.creator_address, r);
  }
  return map;
}

export async function allPriceHistory(db, tokenAddress) {
  const { results } = await db
    .prepare(
      "SELECT last_price_wei_per_token FROM market_snapshots WHERE token_address=? AND last_price_wei_per_token IS NOT NULL"
    )
    .bind(tokenAddress)
    .all();
  return results.map((r) => BigInt(r.last_price_wei_per_token));
}

export async function getCreator(db, creatorAddress) {
  if (!creatorAddress) return null;
  return db.prepare("SELECT * FROM creators WHERE creator_address=?").bind(creatorAddress).first();
}

async function upsertCreatorAggregateRows(db, rows) {
  const ts = nowIso();
  for (const r of rows) {
    await db
      .prepare(
        `INSERT INTO creators(creator_address,first_observed_at,latest_observed_at,total_launches_tracked,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(creator_address) DO UPDATE SET
           first_observed_at=COALESCE(creators.first_observed_at, excluded.first_observed_at),
           latest_observed_at=excluded.latest_observed_at,
           total_launches_tracked=excluded.total_launches_tracked,
           updated_at=excluded.updated_at`
      )
      .bind(r.creator_address, r.fs, r.ls, r.total, ts)
      .run();
  }
  return rows.length;
}

/**
 * Recomputes creator aggregates (first/latest seen, total launch count).
 *
 * INCIDENT NOTE (2026-09-13): the original unconditional version ran a
 * full-table GROUP BY over every distinct creator ever seen and then
 * sequentially upserted ALL of them, every single sync — cost scaled with
 * total accumulated history (2,155 creators after one backfill), not with
 * that sync's actual work. This was the dominant cause of a scheduled sync
 * exceeding 11 minutes, blowing past the single-flight lock's TTL and
 * causing a real production overlap. Callers on the hot (cron) sync path
 * MUST pass `creatorAddresses` scoped to just this run's touched creators —
 * the aggregate for each included creator is still computed correctly
 * across their FULL launch history (the IN-clause only selects which
 * creators to recompute this cycle, not which of their launches count).
 * A creator not touched this cycle simply keeps its last-computed values
 * until a sync that does touch them runs.
 *
 * `creatorAddresses` omitted/null falls back to the full-table recompute —
 * used only by the bounded, non-hot-path runSingleTokenSync() and by
 * tests, never by the per-sync production loop.
 */
export async function recomputeCreatorAggregates(db, creatorAddresses = null) {
  if (creatorAddresses === null) {
    const { results } = await db
      .prepare(
        `SELECT creator_address, MIN(created_at) fs, MAX(created_at) ls, COUNT(*) total
         FROM launches WHERE creator_address IS NOT NULL GROUP BY creator_address`
      )
      .all();
    return upsertCreatorAggregateRows(db, results);
  }

  const addrs = [...new Set(creatorAddresses.filter(Boolean))];
  if (!addrs.length) return 0;
  let total = 0;
  for (const part of chunk(addrs, D1_SAFE_IN_CHUNK)) {
    const placeholders = part.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT creator_address, MIN(created_at) fs, MAX(created_at) ls, COUNT(*) total
         FROM launches WHERE creator_address IN (${placeholders}) GROUP BY creator_address`
      )
      .bind(...part)
      .all();
    total += await upsertCreatorAggregateRows(db, results);
  }
  return total;
}

export async function storeBuilderRanks(db, alltimeItems, seasonItems) {
  const ts = nowIso();
  const updated = new Set();
  for (const item of alltimeItems || []) {
    const addr = (item.creatorAddress || "").toLowerCase();
    if (!addr) continue;
    await db
      .prepare(
        `INSERT INTO creators(creator_address,official_rank_alltime,official_launch_count_alltime,
         official_pace_label,official_source,official_fetched_at,updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(creator_address) DO UPDATE SET
           official_rank_alltime=excluded.official_rank_alltime,
           official_launch_count_alltime=excluded.official_launch_count_alltime,
           official_pace_label=excluded.official_pace_label,
           official_source=excluded.official_source,
           official_fetched_at=excluded.official_fetched_at,
           updated_at=excluded.updated_at`
      )
      .bind(addr, item.rank ?? null, item.launchCount ?? null, item.pace?.label ?? null, "VIBE_API:/builders", ts, ts)
      .run();
    updated.add(addr);
  }
  for (const item of seasonItems || []) {
    const addr = (item.creatorAddress || "").toLowerCase();
    if (!addr) continue;
    await db
      .prepare(
        `INSERT INTO creators(creator_address,official_rank_season,official_launch_count_season,
         official_source,official_fetched_at,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(creator_address) DO UPDATE SET
           official_rank_season=excluded.official_rank_season,
           official_launch_count_season=excluded.official_launch_count_season,
           official_fetched_at=excluded.official_fetched_at,
           updated_at=excluded.updated_at`
      )
      .bind(addr, item.rank ?? null, item.launchCount ?? null, "VIBE_API:/season/builders", ts, ts)
      .run();
    updated.add(addr);
  }
  return updated.size;
}

export async function insertScore(db, tokenAddress, scored, status, flags, runId) {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO scores(token_address,computed_at,run_id,status,score,earlyness_component,
       momentum_component,activity_component,creator_component,confidence_component,flags_json,
       breakdown_json,thresholds_version)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      tokenAddress, ts, runId, status, scored.score, scored.earlyness_component,
      scored.momentum_component, scored.activity_component, scored.creator_component,
      scored.confidence_component, JSON.stringify(flags), JSON.stringify(scored.breakdown),
      scored.thresholds_version
    )
    .run();
}

export async function latestScore(db, tokenAddress) {
  return db
    .prepare("SELECT * FROM scores WHERE token_address=? ORDER BY computed_at DESC LIMIT 1")
    .bind(tokenAddress)
    .first();
}

export async function insertHolderEnrichment(db, tokenAddress, conc, runId) {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO holder_enrichment(token_address,observed_at,run_id,holder_count_returned,
       protocol_excluded_count,top1_address,top1_share_bps,top1_excluded_as_protocol,
       top_nonprotocol_share_bps,top3_nonprotocol_share_bps,top5_nonprotocol_share_bps,
       concentration_flags_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      tokenAddress, ts, runId, conc.holder_count_returned, conc.protocol_excluded_count,
      conc.top1_address, conc.top1_share_bps, conc.top1_excluded_as_protocol,
      conc.top_nonprotocol_share_bps, conc.top3_nonprotocol_share_bps, conc.top5_nonprotocol_share_bps,
      JSON.stringify(conc.concentration_flags)
    )
    .run();
}

export async function latestHolderEnrichment(db, tokenAddress) {
  return db
    .prepare("SELECT * FROM holder_enrichment WHERE token_address=? ORDER BY observed_at DESC LIMIT 1")
    .bind(tokenAddress)
    .first();
}

export async function insertActivityEnrichment(db, tokenAddress, metrics, runId) {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO activity_enrichment(token_address,observed_at,run_id,trade_count_returned,
       buy_count,sell_count,unique_buyers,unique_sellers,last_trade_occurred_at,
       last_trade_age_seconds,buy_count_acceleration)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      tokenAddress, ts, runId, metrics.trade_count_returned, metrics.buy_count, metrics.sell_count,
      metrics.unique_buyers, metrics.unique_sellers, metrics.last_trade_occurred_at,
      metrics.last_trade_age_seconds, metrics.buy_count_acceleration
    )
    .run();
}

export async function latestActivityEnrichment(db, tokenAddress) {
  return db
    .prepare("SELECT * FROM activity_enrichment WHERE token_address=? ORDER BY observed_at DESC LIMIT 1")
    .bind(tokenAddress)
    .first();
}

export async function recordSyncRun(db, runId, patch) {
  const cols = Object.keys(patch);
  const setClause = cols.map((c) => `${c}=?`).join(",");
  await db
    .prepare(`UPDATE sync_runs SET ${setClause} WHERE run_id=?`)
    .bind(...cols.map((c) => patch[c]), runId)
    .run();
}

export async function startSyncRun(db, runId, runType, chainId) {
  await db
    .prepare("INSERT INTO sync_runs(run_id,run_type,started_at,status,source) VALUES(?,?,?,?,?)")
    .bind(runId, runType, nowIso(), "RUNNING", "LIVE")
    .run();
}

/** Lightweight, notes_json-only progress update for a still-RUNNING sync
 * (stuck-run observability — see sync.js checkpoint()/beginOperation()).
 * Deliberately does not touch status/finished_at: only the terminal write
 * in sync.js does that. Callers treat this as best-effort. */
export async function updateSyncRunNotes(db, runId, notesObj) {
  await db.prepare("UPDATE sync_runs SET notes_json=? WHERE run_id=?").bind(JSON.stringify(notesObj), runId).run();
}

export const DEFAULT_SYNC_STATE_NAME = "vibe_sync";

/** Reads the single sync_state row (null on a fresh/first-ever run — the
 * incremental sync path treats null as "no watermark yet, do a bounded
 * initial backfill instead"). */
export async function getSyncState(db, stateName = DEFAULT_SYNC_STATE_NAME) {
  return db.prepare("SELECT * FROM sync_state WHERE state_name=?").bind(stateName).first();
}

/**
 * Merges `patch` into the single sync_state row (creating it on first use).
 * Only fields present in `patch` are changed — omitted fields keep their
 * previous value. Callers (see sync.js) only call this AFTER a cycle has
 * fully succeeded, so a failed/aborted run never advances the watermark.
 */
export async function upsertSyncState(db, patch, stateName = DEFAULT_SYNC_STATE_NAME) {
  const ts = nowIso();
  const existing = await getSyncState(db, stateName);
  const merged = {
    last_seen_created_at: patch.last_seen_created_at !== undefined ? patch.last_seen_created_at : existing?.last_seen_created_at ?? null,
    last_successful_sync: patch.last_successful_sync !== undefined ? patch.last_successful_sync : existing?.last_successful_sync ?? null,
    launch_cursor: patch.launch_cursor !== undefined ? patch.launch_cursor : existing?.launch_cursor ?? null,
    enrichment_cursor: patch.enrichment_cursor !== undefined ? patch.enrichment_cursor : existing?.enrichment_cursor ?? null,
    creator_refresh_cursor: patch.creator_refresh_cursor !== undefined ? patch.creator_refresh_cursor : existing?.creator_refresh_cursor ?? null,
  };
  if (!existing) {
    await db
      .prepare(
        `INSERT INTO sync_state(state_name,last_seen_created_at,last_successful_sync,launch_cursor,enrichment_cursor,creator_refresh_cursor,updated_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .bind(stateName, merged.last_seen_created_at, merged.last_successful_sync, merged.launch_cursor, merged.enrichment_cursor, merged.creator_refresh_cursor, ts)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE sync_state SET last_seen_created_at=?,last_successful_sync=?,launch_cursor=?,enrichment_cursor=?,creator_refresh_cursor=?,updated_at=?
       WHERE state_name=?`
    )
    .bind(merged.last_seen_created_at, merged.last_successful_sync, merged.launch_cursor, merged.enrichment_cursor, merged.creator_refresh_cursor, ts, stateName)
    .run();
}

export { nowIso };
