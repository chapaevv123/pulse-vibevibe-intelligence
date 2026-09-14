import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync } from "../src/sync.js";
import { PULSE_TOKEN_ADDRESS, PULSE_CREATOR_ADDRESS } from "../src/config.js";

// Regression/behavior suite for the GitHub Actions incremental (watermark)
// redesign — see docs/DEPLOYMENT.md. Proves: pagination stops at the
// watermark instead of rescanning full history, the watermark only ever
// advances on a genuinely successful cycle, own $PULSE is never silently
// dropped just because it's outside the watermark window, and first-run
// (no watermark) uses a bounded backfill rather than an unlimited crawl.

function makeIncrementalD1(initialSyncState = null) {
  let lockRow = null;
  const launches = new Map();
  const syncRuns = [];
  let syncState = initialSyncState ? { ...initialSyncState, state_name: "vibe_sync" } : null;

  return {
    lockRow: () => lockRow,
    syncRuns: () => syncRuns,
    syncState: () => syncState,
    launchCount: () => launches.size,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async run() {
          if (sql.includes("INSERT INTO sync_lock")) {
            const [lockName, ownerId, acquiredAt, expiresAt, nowForCompare] = args;
            if (!lockRow || lockRow.expires_at < nowForCompare) {
              lockRow = { lock_name: lockName, owner_id: ownerId, acquired_at: acquiredAt, expires_at: expiresAt };
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.startsWith("UPDATE sync_lock SET expires_at")) {
            const [expiresAt, lockName, ownerId] = args;
            if (lockRow && lockRow.lock_name === lockName && lockRow.owner_id === ownerId) {
              lockRow.expires_at = expiresAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("DELETE FROM sync_lock")) {
            const [lockName, ownerId] = args;
            if (lockRow && lockRow.lock_name === lockName && lockRow.owner_id === ownerId) {
              lockRow = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("INSERT INTO sync_runs")) {
            syncRuns.push({ run_id: args[0], run_type: args[1], started_at: args[2], status: args[3], source: args[4] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE sync_runs SET")) {
            const runId = args[args.length - 1];
            const row = syncRuns.find((r) => r.run_id === runId);
            const cols = [...sql.matchAll(/(\w+)=\?/g)].map((m) => m[1]);
            cols.forEach((c, i) => {
              if (row) row[c] = args[i];
            });
            return { meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes("INSERT INTO sync_state")) {
            const [stateName, lastSeen, lastSync, launchCursor, enrichmentCursor, creatorCursor] = args;
            syncState = {
              state_name: stateName,
              last_seen_created_at: lastSeen,
              last_successful_sync: lastSync,
              launch_cursor: launchCursor,
              enrichment_cursor: enrichmentCursor,
              creator_refresh_cursor: creatorCursor,
            };
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE sync_state SET")) {
            const [lastSeen, lastSync, launchCursor, enrichmentCursor, creatorCursor] = args;
            if (syncState) {
              syncState = {
                ...syncState,
                last_seen_created_at: lastSeen,
                last_successful_sync: lastSync,
                launch_cursor: launchCursor,
                enrichment_cursor: enrichmentCursor,
                creator_refresh_cursor: creatorCursor,
              };
            }
            return { meta: { changes: syncState ? 1 : 0 } };
          }
          if (sql.includes("INSERT INTO launches")) {
            launches.set(args[0], { token_address: args[0], creator_address: args[6] || null, created_at: args[10] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE launches SET")) return { meta: { changes: 1 } };
          if (sql.includes("market_snapshots") || sql.includes("creators") || sql.includes("scores") || sql.includes("enrichment")) {
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("SELECT * FROM sync_lock")) return lockRow;
          if (sql.includes("SELECT * FROM sync_state")) return syncState;
          if (sql.includes("SELECT token_address, first_seen_at FROM launches")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT * FROM launches WHERE token_address=?")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT 1")) return { 1: 1 };
          return null;
        },
        async all() {
          if (sql.includes("FROM launches WHERE token_address IN")) {
            return { results: args.map((a) => launches.get(a)).filter(Boolean) };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

function launch(tokenAddress, createdAt, creatorAddress = "0xcreator0000000000000000000000000000001") {
  return { tokenAddress, creatorAddress, createdAt };
}

/** Fake vibe/vibe upstream serving a fixed, paginated, newest-first list of
 * launches (mirrors the real feed's documented ordering). `pageSize` items
 * per page; own-project detail lookups are served from the same list too. */
function installPaginatedFakeFetch(t, allLaunchesNewestFirst, pageSize = 3) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/launches/") ) {
      // single-launch detail lookup (own-project targeted refresh)
      const addrMatch = u.match(/\/launches\/([^/?]+)/);
      const addr = addrMatch ? decodeURIComponent(addrMatch[1]) : null;
      const found = allLaunchesNewestFirst.find((l) => l.tokenAddress.toLowerCase() === (addr || "").toLowerCase());
      if (found) return { ok: true, status: 200, json: async () => ({ data: found }) };
      return { ok: true, status: 404, json: async () => ({ error: "not found" }) };
    }
    if (u.includes("/launches")) {
      const cursorMatch = u.match(/cursor=(\d+)/);
      const offset = cursorMatch ? parseInt(cursorMatch[1], 10) : 0;
      const pageItems = allLaunchesNewestFirst.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      const hasMore = nextOffset < allLaunchesNewestFirst.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: pageItems, page: { hasMore, nextCursor: hasMore ? String(nextOffset) : null } } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
  };
  t.after(() => {
    global.fetch = original;
  });
}

test("10. first run (no watermark) performs a bounded backfill, not an unlimited crawl", async (t) => {
  // 30 launches, pageSize 3 -> 10 pages available upstream, but
  // INITIAL_BACKFILL_PAGES (5) must cap it regardless of how much more
  // exists upstream.
  const all = Array.from({ length: 30 }, (_, i) => launch(`0xtoken${String(i).padStart(3, "0")}`, `2026-01-01T${String(23 - i).padStart(2, "0")}:00:00.000Z`));
  const d1 = makeIncrementalD1(); // no prior sync_state
  installPaginatedFakeFetch(t, all, 3);

  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.ok(result.pages_fetched <= 5, `expected <=5 pages (INITIAL_BACKFILL_PAGES), got ${result.pages_fetched}`);
  assert.ok(d1.launchCount() <= 15, `expected at most 5 pages x 3 items = 15 launches processed, got ${d1.launchCount()}`);
});

test("6+7. watermark starts null, then advances to the newest processed created_at after a successful cycle", async (t) => {
  const all = [launch("0xtokenA", "2026-01-03T00:00:00.000Z"), launch("0xtokenB", "2026-01-02T00:00:00.000Z")];
  const d1 = makeIncrementalD1();
  installPaginatedFakeFetch(t, all, 10);

  assert.equal(d1.syncState(), null, "no watermark before the first run");
  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.equal(d1.syncState().last_seen_created_at, "2026-01-03T00:00:00.000Z", "watermark must advance to the newest processed launch");
  assert.ok(d1.syncState().last_successful_sync, "last_successful_sync must be recorded");
});

test("9. pagination stops at the watermark — older, already-known launches are not reprocessed", async (t) => {
  const all = [
    launch("0xnew1", "2026-01-05T00:00:00.000Z"),
    launch("0xnew2", "2026-01-04T00:00:00.000Z"),
    launch("0xold1", "2026-01-03T00:00:00.000Z"), // <= watermark, must stop here
    launch("0xold2", "2026-01-02T00:00:00.000Z"),
    launch("0xold3", "2026-01-01T00:00:00.000Z"),
  ];
  const d1 = makeIncrementalD1({ last_seen_created_at: "2026-01-03T00:00:00.000Z", last_successful_sync: "2026-01-03T00:05:00.000Z" });
  installPaginatedFakeFetch(t, all, 2); // page size 2, so watermark item lands mid-page

  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.launches_seen, 2, "only the 2 genuinely-newer launches should be processed");
  assert.equal(d1.launchCount(), 2);
  assert.equal(d1.syncState().last_seen_created_at, "2026-01-05T00:00:00.000Z");
});

test("11. a zero-new-launch cycle still completes and records last_successful_sync, without moving the watermark backward", async (t) => {
  const all = [launch("0xold1", "2026-01-01T00:00:00.000Z")]; // already <= watermark
  const d1 = makeIncrementalD1({ last_seen_created_at: "2026-01-02T00:00:00.000Z", last_successful_sync: "2026-01-02T00:05:00.000Z" });
  installPaginatedFakeFetch(t, all, 10);

  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.launches_seen, 0);
  assert.equal(d1.syncState().last_seen_created_at, "2026-01-02T00:00:00.000Z", "watermark must not regress on a zero-new-launch cycle");
  assert.notEqual(d1.syncState().last_successful_sync, "2026-01-02T00:05:00.000Z", "last_successful_sync must still be refreshed");
});

test("8. watermark does NOT advance when the cycle fails (first upstream fetch error)", async (t) => {
  const d1 = makeIncrementalD1({ last_seen_created_at: "2026-01-01T00:00:00.000Z", last_successful_sync: "2026-01-01T00:05:00.000Z" });
  const original = global.fetch;
  global.fetch = async () => {
    throw new Error("simulated upstream outage");
  };
  t.after(() => {
    global.fetch = original;
  });

  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "FAILED");
  assert.equal(d1.syncState().last_seen_created_at, "2026-01-01T00:00:00.000Z", "watermark must be untouched after a failed cycle");
});

test("12. own $PULSE is refreshed even when it falls entirely outside this cycle's watermark window", async (t) => {
  const ownLaunch = launch(PULSE_TOKEN_ADDRESS, "2020-01-01T00:00:00.000Z", PULSE_CREATOR_ADDRESS); // ancient — never in the newest window
  const recent = [launch("0xnew1", "2026-01-05T00:00:00.000Z"), launch("0xnew2", "2026-01-04T00:00:00.000Z")];
  const d1 = makeIncrementalD1({ last_seen_created_at: "2026-01-03T00:00:00.000Z", last_successful_sync: "2026-01-03T00:05:00.000Z" });
  // The paginated feed itself never includes ownLaunch — only the direct
  // detail-lookup path (installPaginatedFakeFetch's /launches/:addr branch)
  // can serve it, proving the sync reached for it deliberately.
  installPaginatedFakeFetch(t, [...recent, ownLaunch], 10);
  // Force ownLaunch out of the paginated /launches list specifically by
  // re-wrapping fetch to exclude it from the list endpoint only.
  const listOnly = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/launches") && !u.includes("/launches/")) {
      return { ok: true, status: 200, json: async () => ({ data: { items: recent, page: { hasMore: false } } }) };
    }
    return listOnly(url);
  };

  const result = await runSync(d1, { incremental: true, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.ok(d1.launchCount() >= 3, "recent launches + own $PULSE must all be present");
  assert.equal(result.launches_seen, 3, "2 recent + 1 targeted own-project refresh");
});
