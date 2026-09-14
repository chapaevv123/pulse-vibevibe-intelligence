/**
 * PULSE PUBLIC-DEMO SCORING — ported faithfully from the local Pulse MVP
 * (pulse_vibe_robinhood_intelligence_v1.py, THRESHOLDS_VERSION
 * "VIBE_MVP_THRESHOLDS_V1"). Every threshold/bucket value below is copied
 * verbatim, not redesigned. If the local MVP's thresholds ever change, this
 * file must be re-synced deliberately — it does not read from the local repo.
 *
 * All functions here are pure (no fetch, no D1, no I/O) so they can be
 * unit-tested directly and reused by both the sync job and the API layer.
 */

export const THRESHOLDS_VERSION = "VIBE_MVP_THRESHOLDS_V1";

export const STATUS_THRESHOLDS = {
  AGE_NEW_MAX_MINUTES: 15,
  AGE_EARLY_MAX_MINUTES: 180,
  CROWDED_HOLDER_COUNT_MIN: 50,
  CROWDED_PROGRESS_BPS_MIN: 5000, // 50% of the way to graduation
  HEATING_BUY_COUNT_1H_MIN: 5,
  HEATING_BUY_SELL_RATIO_MIN: 2.0,
  EARLY_MIN_BUY_COUNT_1H: 1,
  EARLY_MIN_HOLDER_COUNT: 2,
};

// Documents the ACTUAL ceiling each compute_score() branch can award (creator
// tops out at 12, not 15) — true reachable max is 97, matching the local MVP.
export const SCORE_MAXIMA = {
  earlyness: 25,
  momentum: 25,
  activity: 20,
  creator: 12,
  confidence: 15,
};

export const STATUSES = ["NEW", "EARLY", "HEATING", "CROWDED", "UNKNOWN"];

export const HOLDER_CONCENTRATION_THRESHOLDS = {
  TOP1_HIGH_BPS: 2000, // 20% held by the single largest non-protocol holder
  TOP3_HIGH_BPS: 4000, // 40% held by the top 3 non-protocol holders combined
  TOP5_HIGH_BPS: 5000, // 50% held by the top 5 non-protocol holders combined
};

export function ageMinutes(createdAt, nowMs = Date.now()) {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 60000;
}

/**
 * Deterministic status classification — no ML, mirrors classify_status().
 * launch: { created_at, source }
 * snapshot: { analytics_status, holder_count, progress_bps, buy_count_1h, sell_count_1h } | null
 */
export function classifyStatus(launch, snapshot, nowMs = Date.now()) {
  const t = STATUS_THRESHOLDS;
  const reasons = { thresholds_version: THRESHOLDS_VERSION };

  if (!snapshot || snapshot.analytics_status !== "AVAILABLE") {
    reasons.reason = "NO_MARKET_DATA";
    return { status: "UNKNOWN", reasons };
  }

  const age = ageMinutes(launch?.created_at, nowMs);
  const holderCount = snapshot.holder_count || 0;
  const progressBps = snapshot.progress_bps;
  const buy1h = snapshot.buy_count_1h || 0;
  const sell1h = snapshot.sell_count_1h || 0;
  Object.assign(reasons, { age_minutes: age, holder_count: holderCount, progress_bps: progressBps, buy_count_1h: buy1h, sell_count_1h: sell1h });

  if (age === null) {
    reasons.reason = "AGE_UNKNOWN";
    return { status: "UNKNOWN", reasons };
  }
  if (age < t.AGE_NEW_MAX_MINUTES) {
    reasons.reason = "AGE_UNDER_NEW_MAX";
    return { status: "NEW", reasons };
  }
  if (holderCount >= t.CROWDED_HOLDER_COUNT_MIN || (progressBps || 0) >= t.CROWDED_PROGRESS_BPS_MIN) {
    reasons.reason = "HOLDER_OR_PROGRESS_OVER_CROWDED_MIN";
    return { status: "CROWDED", reasons };
  }
  if (buy1h >= t.HEATING_BUY_COUNT_1H_MIN && buy1h >= sell1h * t.HEATING_BUY_SELL_RATIO_MIN) {
    reasons.reason = "BUY_COUNT_AND_RATIO_OVER_HEATING_MIN";
    return { status: "HEATING", reasons };
  }
  if (age < t.AGE_EARLY_MAX_MINUTES && (buy1h >= t.EARLY_MIN_BUY_COUNT_1H || holderCount >= t.EARLY_MIN_HOLDER_COUNT)) {
    reasons.reason = "UNDER_EARLY_AGE_MAX_WITH_SOME_SIGNAL";
    return { status: "EARLY", reasons };
  }
  reasons.reason = "NO_RULE_MATCHED";
  return { status: "UNKNOWN", reasons };
}

/** Evidence-only risk flags — NEVER a scam/buy/sell verdict. Mirrors risk_flags(). */
export function riskFlags(launch, snapshot, creator) {
  const flags = [];
  const age = ageMinutes(launch?.created_at);
  if (age !== null && age < STATUS_THRESHOLDS.AGE_NEW_MAX_MINUTES) flags.push("VERY_NEW");
  if (!snapshot || snapshot.analytics_status !== "AVAILABLE") flags.push("NO_MARKET_DATA");
  if (snapshot) {
    const buy1h = snapshot.buy_count_1h || 0;
    const sell1h = snapshot.sell_count_1h || 0;
    const holders = snapshot.holder_count || 0;
    if (buy1h === 0 && sell1h === 0 && holders <= 1) flags.push("NO_ACTIVITY");
    if ((sell1h === 0 && buy1h >= 10) || (sell1h && buy1h / Math.max(sell1h, 1) >= 10)) {
      flags.push("EXTREME_BUY_SELL_IMBALANCE");
    }
  }
  if (launch?.metadata_integrity !== "MATCHED" || !launch?.description) flags.push("MISSING_METADATA");
  const launchCount = creator ? creator.official_launch_count_alltime || creator.total_launches_tracked : null;
  if (launchCount && launchCount >= 10) flags.push("HIGH_CREATOR_LAUNCH_COUNT");
  if (launch?.source !== "LIVE") flags.push("LOW_DATA_CONFIDENCE");
  return flags;
}

/** Explainable, bucketed Pulse Score (0-100, true ceiling 97). Mirrors compute_score(). */
export function computeScore(launch, snapshot, creator) {
  const m = SCORE_MAXIMA;
  const breakdown = {};

  const age = ageMinutes(launch?.created_at);
  const progressBps = snapshot ? snapshot.progress_bps : null;
  let earlyness;
  if (age === null) {
    earlyness = 0;
    breakdown.earlyness_reason = "AGE_UNKNOWN";
  } else {
    if (age < 15) earlyness = m.earlyness;
    else if (age < 60) earlyness = 18;
    else if (age < 180) earlyness = 10;
    else if (age < 1440) earlyness = 4;
    else earlyness = 0;
    if ((progressBps || 0) >= STATUS_THRESHOLDS.CROWDED_PROGRESS_BPS_MIN) earlyness = Math.min(earlyness, 5);
    breakdown.earlyness_reason = `age_minutes=${age.toFixed(1)}`;
  }

  let momentum;
  if (!snapshot || snapshot.buy_count_1h === null || snapshot.buy_count_1h === undefined) {
    momentum = 0;
    breakdown.momentum_reason = "NO_TRADE_COUNTS";
  } else {
    const buy1h = snapshot.buy_count_1h || 0;
    const sell1h = snapshot.sell_count_1h || 0;
    const ratio = buy1h / Math.max(sell1h, 1);
    if (buy1h >= 10 && ratio >= 3) momentum = 25;
    else if (buy1h >= 5 && ratio >= 2) momentum = 18;
    else if (buy1h >= 1 && ratio >= 1) momentum = 10;
    else momentum = 0;
    const pc1h = snapshot.price_change_1h_bps;
    if (pc1h !== null && pc1h !== undefined) {
      const n = Number(pc1h);
      if (!Number.isNaN(n) && Math.abs(n) >= 500) momentum = Math.min(25, momentum + 3);
    }
    breakdown.momentum_reason = `buy1h=${buy1h} sell1h=${sell1h} ratio=${ratio.toFixed(2)}`;
  }

  let activity;
  if (!snapshot) {
    activity = 0;
    breakdown.activity_reason = "NO_SNAPSHOT";
  } else {
    const holders = snapshot.holder_count || 0;
    const trades = (snapshot.buy_count_1h || 0) + (snapshot.sell_count_1h || 0);
    if (holders >= 20 || trades >= 15) activity = 20;
    else if (holders >= 8 || trades >= 6) activity = 12;
    else if (holders >= 2 || trades >= 1) activity = 6;
    else activity = 0;
    breakdown.activity_reason = `holders=${holders} trades_1h=${trades}`;
  }

  let creatorComponent;
  if (!creator) {
    creatorComponent = 7;
    breakdown.creator_reason = "CREATOR_UNKNOWN_NEUTRAL";
  } else {
    const launches = creator.official_launch_count_alltime || creator.total_launches_tracked || 0;
    if (launches === 0) creatorComponent = 7;
    else if (launches <= 3) creatorComponent = 10;
    else if (launches <= 10) creatorComponent = 12;
    else creatorComponent = 8;
    breakdown.creator_reason = `launches_known=${launches}`;
  }

  let confidence = m.confidence;
  if (launch?.source !== "LIVE") confidence -= 8;
  if (!snapshot || snapshot.analytics_status !== "AVAILABLE") confidence -= 6;
  confidence = Math.max(0, confidence);
  breakdown.confidence_reason = `source=${launch?.source} analytics_status=${snapshot?.analytics_status}`;

  let total = earlyness + momentum + activity + creatorComponent + confidence;
  total = Math.max(0, Math.min(100, total));

  return {
    score: total,
    earlyness_component: earlyness,
    momentum_component: momentum,
    activity_component: activity,
    creator_component: creatorComponent,
    confidence_component: confidence,
    breakdown,
    maxima: m,
    thresholds_version: THRESHOLDS_VERSION,
  };
}

/** Holder concentration — evidence flags only, never a scam verdict. Mirrors compute_holder_concentration(). */
export function computeHolderConcentration(holderItems) {
  const t = HOLDER_CONCENTRATION_THRESHOLDS;
  const nonprotocol = holderItems.filter((h) => h.excludedAsProtocol !== true);
  const protocolExcludedCount = holderItems.length - nonprotocol.length;
  const top1 = nonprotocol[0] || null;
  const top3Bps = nonprotocol.slice(0, 3).reduce((s, h) => s + (Number(h.shareBps) || 0), 0);
  const top5Bps = nonprotocol.slice(0, 5).reduce((s, h) => s + (Number(h.shareBps) || 0), 0);
  const top1Bps = top1 ? Number(top1.shareBps) || 0 : 0;

  const flags = [];
  if (top1Bps >= t.TOP1_HIGH_BPS) flags.push("HIGH_TOP1_CONCENTRATION");
  if (top3Bps >= t.TOP3_HIGH_BPS) flags.push("HIGH_TOP3_CONCENTRATION");
  if (top5Bps >= t.TOP5_HIGH_BPS) flags.push("HIGH_TOP5_CONCENTRATION");
  if (nonprotocol.length === 0) flags.push("NO_NONPROTOCOL_HOLDERS_RETURNED");

  const first = holderItems[0] || null;
  return {
    holder_count_returned: holderItems.length,
    protocol_excluded_count: protocolExcludedCount,
    top1_address: first ? first.address : null,
    top1_share_bps: first ? Number(first.shareBps) || 0 : null,
    top1_excluded_as_protocol: first && first.excludedAsProtocol === true ? 1 : 0,
    top_nonprotocol_share_bps: top1Bps,
    top3_nonprotocol_share_bps: top3Bps,
    top5_nonprotocol_share_bps: top5Bps,
    concentration_flags: flags,
  };
}

/** Pure trade-level metrics from the /activity feed. Mirrors compute_activity_metrics(). */
export function computeActivityMetrics(activityItems, prevBuyCount) {
  const buys = activityItems.filter((a) => (a.type || a.side) === "BUY");
  const sells = activityItems.filter((a) => (a.type || a.side) === "SELL");
  const uniqueBuyers = new Set(buys.map((a) => a.actorAddress).filter(Boolean)).size;
  const uniqueSellers = new Set(sells.map((a) => a.actorAddress).filter(Boolean)).size;

  let lastTradeAt = null;
  for (const a of activityItems) {
    if (a.occurredAt && (lastTradeAt === null || a.occurredAt > lastTradeAt)) lastTradeAt = a.occurredAt;
  }
  let lastTradeAgeSeconds = null;
  if (lastTradeAt) {
    const t = Date.parse(lastTradeAt);
    if (!Number.isNaN(t)) lastTradeAgeSeconds = (Date.now() - t) / 1000;
  }

  let buyCountAcceleration = null;
  if (prevBuyCount !== null && prevBuyCount !== undefined) {
    buyCountAcceleration = buys.length - prevBuyCount;
  }

  return {
    trade_count_returned: activityItems.length,
    buy_count: buys.length,
    sell_count: sells.length,
    unique_buyers: uniqueBuyers,
    unique_sellers: uniqueSellers,
    last_trade_occurred_at: lastTradeAt,
    last_trade_age_seconds: lastTradeAgeSeconds,
    buy_count_acceleration: buyCountAcceleration,
  };
}
