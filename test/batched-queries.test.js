import { test } from "node:test";
import assert from "node:assert/strict";
import { latestSnapshotsFor, creatorsFor } from "../src/db.js";

// Regression test for a real production incident: rendering N launches with
// one D1 round-trip per launch per table (N x5 separate queries) blew past
// Cloudflare's per-invocation subrequest ceiling at N≈2000 (HTTP 500,
// "Too many API requests by single Worker invocation"). The fix batches
// lookups via WHERE token_address IN (...) with a window function, chunked
// to stay under D1's 100-bound-parameter-per-query ceiling (a second live
// failure, "too many SQL variables", was hit at a 200-per-chunk size).
// This test proves the call count stays O(N / chunkSize), not O(N).

function makeCountingD1(rowsByTable) {
  let prepareCalls = 0;
  const boundCounts = [];
  return {
    stats: () => ({ prepareCalls, boundCounts }),
    prepare(sql) {
      prepareCalls++;
      let boundArgs = [];
      const stmt = {
        bind(...args) {
          boundArgs = args;
          boundCounts.push(args.length);
          return stmt;
        },
        async all() {
          const table = Object.keys(rowsByTable).find((t) => sql.includes(t));
          const rows = table ? rowsByTable[table] : [];
          const key = table === "creators" ? "creator_address" : "token_address";
          const wanted = new Set(boundArgs);
          return { results: rows.filter((r) => wanted.has(r[key])) };
        },
        async first() {
          const { results } = await stmt.all();
          return results[0] || null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

test("latestSnapshotsFor issues O(N/chunkSize) D1 calls, not O(N), for many tokens", async () => {
  const N = 500;
  const tokenAddresses = Array.from({ length: N }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
  const snapshotRows = tokenAddresses.map((t) => ({ token_address: t, observed_at: "2026-01-01T00:00:00Z", buy_count_1h: 1 }));
  const d1 = makeCountingD1({ market_snapshots: snapshotRows });

  const map = await latestSnapshotsFor(d1, tokenAddresses);

  assert.equal(map.size, N, "every token should resolve to a row");
  const { prepareCalls, boundCounts } = d1.stats();
  assert.ok(prepareCalls <= 10, `expected a small, bounded number of D1 calls for ${N} tokens, got ${prepareCalls}`);
  assert.ok(prepareCalls >= Math.ceil(N / 90), "chunking must still cover every token");
  for (const n of boundCounts) {
    assert.ok(n <= 90, `each chunk must bind at most 90 params (D1's documented ceiling is 100), got ${n}`);
  }
});

test("latestSnapshotsFor with zero tokens issues zero D1 calls", async () => {
  const d1 = makeCountingD1({ market_snapshots: [] });
  const map = await latestSnapshotsFor(d1, []);
  assert.equal(map.size, 0);
  assert.equal(d1.stats().prepareCalls, 0);
});

test("creatorsFor batches and dedupes creator addresses the same way", async () => {
  const N = 300;
  const creatorAddresses = Array.from({ length: N }, (_, i) => `0xcreator${i}`);
  // Duplicate every address once, as real launch rows would (many launches
  // sharing a creator) — the batch must dedupe before chunking.
  const withDupes = [...creatorAddresses, ...creatorAddresses];
  const creatorRows = creatorAddresses.map((c) => ({ creator_address: c, total_launches_tracked: 1 }));
  const d1 = makeCountingD1({ creators: creatorRows });

  const map = await creatorsFor(d1, withDupes);

  assert.equal(map.size, N);
  const { prepareCalls } = d1.stats();
  assert.ok(prepareCalls <= 10, `expected bounded D1 calls for ${N} unique creators, got ${prepareCalls}`);
});
