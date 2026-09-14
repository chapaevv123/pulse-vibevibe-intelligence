import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertLaunchRows, insertSnapshotRows, insertScoreRows, normalizeLaunch, normalizeSnapshot } from "../src/db.js";

// Regression tests for the 2026-09-14 FAILED_OPERATION_TIMEOUT incident's
// second wave of fixes: the sync page-fetch loop and scoring loop each did
// one D1 REST round-trip per row (no batching). db.js now exposes
// upsertLaunchRows/insertSnapshotRows/insertScoreRows, which build an
// array of prepared statements and hand them to db.batch() in one shot.
// This mock D1 counts "round trips" separately from individual prepared
// statements so these tests can prove N rows costs O(1) round-trips, not
// O(N), while still being behaviorally correct (idempotent, preserves
// first_seen_at on conflict, dedupes snapshots).

function makeInMemoryD1() {
  const launches = new Map(); // token_address -> row
  const snapshots = new Set(); // snapshot_id
  const scores = []; // append-only
  let roundTrips = 0; // one per batch() call OR one per individual .run()/.all()/.first()

  function execOne(sql, args) {
    if (sql.includes("SELECT * FROM launches WHERE token_address IN")) {
      const wanted = new Set(args);
      return { results: [...launches.values()].filter((r) => wanted.has(r.token_address)) };
    }
    if (sql.startsWith("INSERT INTO launches")) {
      const [
        token_address, chain_id, launch_id, name, symbol, decimals, creator_address,
        creator_vault_address, curve_address, quote_asset_address, created_at, description,
        image_uri, metadata_uri, metadata_integrity, project_url, source, is_own_project,
        first_seen_at, updated_at, last_run_id,
      ] = args;
      const existing = launches.get(token_address);
      launches.set(token_address, {
        token_address, chain_id, launch_id, name, symbol, decimals, creator_address,
        creator_vault_address, curve_address, quote_asset_address, created_at, description,
        image_uri, metadata_uri, metadata_integrity, project_url, source, is_own_project,
        first_seen_at: existing ? existing.first_seen_at : first_seen_at, // ON CONFLICT never touches this
        updated_at,
        last_run_id,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO market_snapshots")) {
      const snapshot_id = args[0];
      if (snapshots.has(snapshot_id)) return { meta: { changes: 0 } };
      snapshots.add(snapshot_id);
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO scores")) {
      scores.push(args);
      return { meta: { changes: 1 } };
    }
    throw new Error(`unhandled SQL in test mock: ${sql}`);
  }

  return {
    stats: () => ({ roundTrips, launchCount: launches.size, snapshotCount: snapshots.size, scoreCount: scores.length }),
    launches,
    scores,
    prepare(sql) {
      let boundArgs = [];
      const stmt = {
        bind(...args) {
          boundArgs = args;
          return stmt;
        },
        async run() {
          roundTrips++;
          return execOne(sql, boundArgs);
        },
        async all() {
          roundTrips++;
          return execOne(sql, boundArgs);
        },
        async first() {
          roundTrips++;
          const { results } = execOne(sql, boundArgs);
          return results[0] || null;
        },
        _entry() {
          return { sql, args: boundArgs };
        },
      };
      return stmt;
    },
    async batch(statements) {
      roundTrips++; // the entire batch is ONE round-trip, regardless of statement count
      return statements.map((s) => {
        const { sql, args } = s._entry();
        return execOne(sql, args);
      });
    },
  };
}

function makeLaunchRow(tokenAddress, overrides = {}) {
  return normalizeLaunch(
    {
      tokenAddress,
      creatorAddress: "0xcreator1",
      name: "Test Launch",
      symbol: "TST",
      createdAt: "2026-09-14T00:00:00Z",
      ...overrides,
    },
    "run1",
    "vibe-chain"
  );
}

test("upsertLaunchRows writes N rows in ONE batch() round-trip plus one batched existence read", async () => {
  const d1 = makeInMemoryD1();
  const rows = Array.from({ length: 40 }, (_, i) => makeLaunchRow(`0xtoken${i}`));

  const { written, newCount } = await upsertLaunchRows(d1, rows);

  assert.equal(written, 40);
  assert.equal(newCount, 40, "all 40 are new on first write");
  const { roundTrips, launchCount } = d1.stats();
  assert.equal(launchCount, 40);
  // 1 chunked existence SELECT (40 fits in one chunk of 90) + 1 batch() write = 2.
  assert.ok(roundTrips <= 3, `expected O(1) round-trips for 40 rows, got ${roundTrips}`);
});

test("upsertLaunchRows on conflict updates fields but preserves first_seen_at", async () => {
  const d1 = makeInMemoryD1();
  await upsertLaunchRows(d1, [makeLaunchRow("0xabc", { name: "Original Name" })]);
  const firstSeen = d1.launches.get("0xabc").first_seen_at;

  const { newCount } = await upsertLaunchRows(d1, [makeLaunchRow("0xabc", { name: "Updated Name" })]);

  assert.equal(newCount, 0, "re-upserting an existing token must not count as new");
  const row = d1.launches.get("0xabc");
  assert.equal(row.name, "Updated Name", "other fields must still update");
  assert.equal(row.first_seen_at, firstSeen, "first_seen_at must be preserved across an update, exactly like the old UPDATE branch");
});

test("upsertLaunchRows with an empty array performs zero D1 calls", async () => {
  const d1 = makeInMemoryD1();
  const { written, newCount } = await upsertLaunchRows(d1, []);
  assert.equal(written, 0);
  assert.equal(newCount, 0);
  assert.equal(d1.stats().roundTrips, 0);
});

test("insertSnapshotRows writes N rows in ONE batch() round-trip and is idempotent (INSERT OR IGNORE)", async () => {
  const d1 = makeInMemoryD1();
  const rows = Array.from({ length: 30 }, (_, i) => normalizeSnapshot({ tokenAddress: `0xtoken${i}`, asOfBlock: "100" }, "run1"));

  const written = await insertSnapshotRows(d1, rows);
  assert.equal(written, 30);
  assert.equal(d1.stats().roundTrips, 1, "30 statements must cost exactly 1 batch() round-trip");

  // Re-inserting the exact same snapshot ids must be a no-op (changes: 0 each).
  const rewritten = await insertSnapshotRows(d1, rows);
  assert.equal(rewritten, 0, "duplicate snapshot_ids must be ignored, never double-counted");
});

test("insertSnapshotRows filters out null entries (normalizeSnapshot returns null for malformed rows)", async () => {
  const d1 = makeInMemoryD1();
  const rows = [normalizeSnapshot({ tokenAddress: "0xok", asOfBlock: "1" }, "run1"), null, normalizeSnapshot({ tokenAddress: "" }, "run1")];
  const written = await insertSnapshotRows(d1, rows);
  assert.equal(written, 1, "only the one valid row should be written");
});

test("insertScoreRows writes N rows in ONE batch() round-trip (append-only, no conflict handling needed)", async () => {
  const d1 = makeInMemoryD1();
  const rows = Array.from({ length: 60 }, (_, i) => ({
    tokenAddress: `0xtoken${i}`,
    scored: { score: 50, earlyness_component: 1, momentum_component: 1, activity_component: 1, creator_component: 1, confidence_component: 1, breakdown: {}, thresholds_version: "v1" },
    status: "LIVE",
    flags: [],
    runId: "run1",
  }));

  const written = await insertScoreRows(d1, rows);

  assert.equal(written, 60);
  assert.equal(d1.stats().roundTrips, 1, "60 score rows must cost exactly 1 batch() round-trip");
  assert.equal(d1.scores.length, 60, "every score row must actually be appended, none dropped");
});

test("insertScoreRows with an empty array performs zero D1 calls", async () => {
  const d1 = makeInMemoryD1();
  const written = await insertScoreRows(d1, []);
  assert.equal(written, 0);
  assert.equal(d1.stats().roundTrips, 0);
});
