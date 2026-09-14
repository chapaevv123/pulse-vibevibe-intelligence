import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  riskFlags,
  computeScore,
  computeHolderConcentration,
  computeActivityMetrics,
  STATUSES,
  SCORE_MAXIMA,
} from "../src/scoring.js";

// Fixture shapes below mirror the local Pulse MVP's FX-1 / FX-2 fixtures
// (pulse_vibe_robinhood_sources_v1.py FIXTURE_LAUNCHES) so score/status
// parity can be checked against known local outcomes.

const FX1_LAUNCH = { created_at: new Date().toISOString(), source: "LIVE", metadata_integrity: "MATCHED", description: "x" };
const FX1_SNAPSHOT = { analytics_status: "AVAILABLE", holder_count: 2, progress_bps: 200, buy_count_1h: 3, sell_count_1h: 0, price_change_1h_bps: "10" };

const FX2_LAUNCH = { created_at: "2026-01-01T02:00:00.000Z", source: "LIVE", metadata_integrity: "MATCHED", description: "x" };
const FX2_SNAPSHOT = { analytics_status: "AVAILABLE", holder_count: 60, progress_bps: 6000, buy_count_1h: 0, sell_count_1h: 0, price_change_1h_bps: "0" };

test("status: brand-new launch with light activity classifies NEW (age dominates)", () => {
  const { status } = classifyStatus(FX1_LAUNCH, FX1_SNAPSHOT);
  assert.equal(status, "NEW");
});

test("status: high holder count / progress classifies CROWDED regardless of age", () => {
  const { status } = classifyStatus(FX2_LAUNCH, FX2_SNAPSHOT);
  assert.equal(status, "CROWDED");
});

test("status: missing market data (no snapshot) classifies UNKNOWN", () => {
  const { status, reasons } = classifyStatus({ created_at: null, source: "LIVE" }, null);
  assert.equal(status, "UNKNOWN");
  assert.equal(reasons.reason, "NO_MARKET_DATA");
});

test("status: unknown age with available snapshot classifies UNKNOWN, not NEW", () => {
  const { status, reasons } = classifyStatus({ created_at: null, source: "LIVE" }, { analytics_status: "AVAILABLE", holder_count: 0, buy_count_1h: 0, sell_count_1h: 0 });
  assert.equal(status, "UNKNOWN");
  assert.equal(reasons.reason, "AGE_UNKNOWN");
});

test("status: HEATING requires buy_count_1h >= 5 AND buy >= 2x sell", () => {
  const olderLaunch = { created_at: new Date(Date.now() - 4 * 3600_000).toISOString(), source: "LIVE" };
  const { status } = classifyStatus(olderLaunch, { analytics_status: "AVAILABLE", holder_count: 3, buy_count_1h: 6, sell_count_1h: 1 });
  assert.equal(status, "HEATING");
});

test("score: components never exceed documented maxima, and total never exceeds true ceiling 97", () => {
  const scored = computeScore(FX1_LAUNCH, FX1_SNAPSHOT, null);
  assert.ok(scored.earlyness_component <= SCORE_MAXIMA.earlyness);
  assert.ok(scored.momentum_component <= SCORE_MAXIMA.momentum);
  assert.ok(scored.activity_component <= SCORE_MAXIMA.activity);
  assert.ok(scored.creator_component <= SCORE_MAXIMA.creator);
  assert.ok(scored.confidence_component <= SCORE_MAXIMA.confidence);
  const sumOfMaxima = Object.values(SCORE_MAXIMA).reduce((a, b) => a + b, 0);
  assert.equal(sumOfMaxima, 97, "documented ceiling must stay 97, matching the local MVP's QUALITY PASS V1.1 fix");
});

test("score: crowded launch (progress_bps over threshold) caps earlyness at 5", () => {
  const scored = computeScore(FX2_LAUNCH, FX2_SNAPSHOT, null);
  assert.ok(scored.earlyness_component <= 5);
});

test("score: unknown creator gets the neutral 7-point bucket, not 0 or max", () => {
  const scored = computeScore(FX1_LAUNCH, FX1_SNAPSHOT, null);
  assert.equal(scored.creator_component, 7);
});

test("score: FIXTURE-sourced / non-LIVE launch loses 8 confidence points", () => {
  const liveScored = computeScore({ ...FX1_LAUNCH, source: "LIVE" }, FX1_SNAPSHOT, null);
  const nonLiveScored = computeScore({ ...FX1_LAUNCH, source: "OTHER" }, FX1_SNAPSHOT, null);
  assert.equal(liveScored.confidence_component - nonLiveScored.confidence_component, 8);
});

test("risk flags: very-new + no-metadata launch is flagged, never labeled a scam", () => {
  const flags = riskFlags({ created_at: new Date().toISOString(), source: "LIVE", metadata_integrity: null, description: null }, FX1_SNAPSHOT, null);
  assert.ok(flags.includes("VERY_NEW"));
  assert.ok(flags.includes("MISSING_METADATA"));
  assert.ok(!flags.some((f) => /SCAM/i.test(f)), "risk flags must never assert a scam verdict");
});

test("risk flags: high creator launch count (>=10) is flagged", () => {
  const flags = riskFlags(FX1_LAUNCH, FX1_SNAPSHOT, { official_launch_count_alltime: 12, total_launches_tracked: 12 });
  assert.ok(flags.includes("HIGH_CREATOR_LAUNCH_COUNT"));
});

test("holder concentration: protocol-excluded holder is dropped from non-protocol shares", () => {
  const items = [
    { rank: 1, address: "0xprotocol", shareBps: 9000, excludedAsProtocol: true },
    { rank: 2, address: "0xwhale", shareBps: 2500, excludedAsProtocol: false },
    { rank: 3, address: "0xsmall", shareBps: 100, excludedAsProtocol: false },
  ];
  const conc = computeHolderConcentration(items);
  assert.equal(conc.top1_address, "0xprotocol"); // raw top1_address is still the API's #1 row
  assert.equal(conc.top_nonprotocol_share_bps, 2500); // but the non-protocol share skips it
  assert.ok(conc.concentration_flags.includes("HIGH_TOP1_CONCENTRATION"));
});

test("holder concentration: ambiguous (missing) excludedAsProtocol is treated as NOT excluded", () => {
  const items = [{ rank: 1, address: "0xambiguous", shareBps: 3000 }];
  const conc = computeHolderConcentration(items);
  assert.equal(conc.top_nonprotocol_share_bps, 3000, "missing excludedAsProtocol must never be silently dropped");
});

test("activity metrics: buy/sell counts and unique buyers computed correctly", () => {
  const items = [
    { type: "BUY", actorAddress: "0xa", occurredAt: new Date().toISOString() },
    { type: "BUY", actorAddress: "0xb", occurredAt: new Date().toISOString() },
    { type: "SELL", actorAddress: "0xc", occurredAt: new Date().toISOString() },
  ];
  const metrics = computeActivityMetrics(items, null);
  assert.equal(metrics.buy_count, 2);
  assert.equal(metrics.sell_count, 1);
  assert.equal(metrics.unique_buyers, 2);
  assert.equal(metrics.buy_count_acceleration, null);
});

test("activity metrics: acceleration computed relative to previous buy count", () => {
  const items = [{ type: "BUY", actorAddress: "0xa", occurredAt: new Date().toISOString() }];
  const metrics = computeActivityMetrics(items, 3);
  assert.equal(metrics.buy_count_acceleration, 1 - 3);
});

test("STATUSES export matches the five documented statuses", () => {
  assert.deepEqual(STATUSES, ["NEW", "EARLY", "HEATING", "CROWDED", "UNKNOWN"]);
});
