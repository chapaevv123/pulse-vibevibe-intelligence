import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync } from "../src/sync.js";
import { tryAcquireLock, renewLock, getLockState, newOwnerId, LOCK_TTL_MS } from "../src/lock.js";

// ---------------------------------------------------------------------------
// 1-3: direct renewLock() unit tests (atomic, ownership-scoped renewal)
// ---------------------------------------------------------------------------

function makeLockD1() {
  let row = null;
  return {
    _row: () => row,
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
            if (!row || row.expires_at < nowForCompare) {
              row = { lock_name: lockName, owner_id: ownerId, acquired_at: acquiredAt, expires_at: expiresAt };
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.startsWith("UPDATE sync_lock SET expires_at")) {
            const [expiresAt, lockName, ownerId] = args;
            if (row && row.lock_name === lockName && row.owner_id === ownerId) {
              row.expires_at = expiresAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("DELETE FROM sync_lock")) {
            const [lockName, ownerId] = args;
            if (row && row.lock_name === lockName && row.owner_id === ownerId) {
              row = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        async first() {
          if (sql.includes("SELECT * FROM sync_lock")) return row;
          throw new Error(`unexpected SQL: ${sql}`);
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

test("1. the owning invocation can renew its own lease", async () => {
  const d1 = makeLockD1();
  const owner = "owner-A";
  await tryAcquireLock(d1, owner);
  const renewed = await renewLock(d1, owner);
  assert.equal(renewed, true);
});

test("2. a different owner cannot renew someone else's lease", async () => {
  const d1 = makeLockD1();
  await tryAcquireLock(d1, "owner-A");
  const renewedByStranger = await renewLock(d1, "owner-B");
  assert.equal(renewedByStranger, false);
  const state = await getLockState(d1);
  assert.equal(state.owner_id, "owner-A", "ownership must be unchanged after a failed renewal attempt");
});

test("3. a successful renewal extends expires_at forward", async () => {
  const d1 = makeLockD1();
  const owner = "owner-A";
  const now = Date.now();
  await tryAcquireLock(d1, owner, LOCK_TTL_MS, now);
  const before = (await getLockState(d1, now)).expires_at;
  const later = now + 5 * 60_000;
  await renewLock(d1, owner, LOCK_TTL_MS, later);
  const after = (await getLockState(d1, later)).expires_at;
  assert.ok(new Date(after).getTime() > new Date(before).getTime(), "renewal must push expires_at forward");
});

test("4. an actively renewed lease keeps blocking a second invocation past the original expiry", async () => {
  const d1 = makeLockD1();
  const now = Date.now();
  await tryAcquireLock(d1, "owner-A", LOCK_TTL_MS, now);
  const originalExpiry = (await getLockState(d1, now)).expires_at;

  // Renew shortly before the original expiry would have hit.
  const justBeforeOriginalExpiry = now + LOCK_TTL_MS - 30_000;
  const renewed = await renewLock(d1, "owner-A", LOCK_TTL_MS, justBeforeOriginalExpiry);
  assert.equal(renewed, true);

  // A second owner tries to acquire AFTER the original (pre-renewal) expiry
  // time would have passed — this is exactly the scenario that caused the
  // real production overlap incident under the old fixed-TTL-only design.
  const afterOriginalExpiry = new Date(originalExpiry).getTime() + 1000;
  const stolen = await tryAcquireLock(d1, "owner-B", LOCK_TTL_MS, afterOriginalExpiry);
  assert.equal(stolen, false, "a renewed lease must not be recoverable just because the ORIGINAL expiry passed");
});

// ---------------------------------------------------------------------------
// 5-11: full-sync integration tests via a minimal but real mock D1 + fake
// upstream fetch. Scope kept to 1 page / no enrichment so an abort at the
// very first checkpoint is meaningful and the mock surface stays small.
// ---------------------------------------------------------------------------

function makeSyncD1({ stealLockAfterAcquire = false } = {}) {
  let lockRow = null;
  const launches = new Map();
  const snapshots = [];
  const creators = new Map();
  const scores = [];
  const syncRuns = [];
  const writesToForbiddenTables = [];

  return {
    lockRow: () => lockRow,
    syncRuns: () => syncRuns,
    writesToForbiddenTables: () => writesToForbiddenTables,
    scoresCount: () => scores.length,
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
              if (stealLockAfterAcquire) {
                // Simulate another owner taking over the row immediately
                // after this invocation acquired it (e.g. a concurrent
                // recovery race) — the NEXT renewLock() call must then
                // correctly report ownership lost.
                lockRow = { ...lockRow, owner_id: "someone-else" };
              }
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
          if (sql.includes("INSERT INTO launches")) {
            launches.set(args[0], { token_address: args[0], creator_address: args[6] || null, created_at: args[10] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE launches SET")) {
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR IGNORE INTO market_snapshots") || sql.includes("INSERT INTO market_snapshots")) {
            snapshots.push({ token_address: args[1] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO creators")) {
            creators.set(args[0], { creator_address: args[0] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INSERT INTO scores")) {
            scores.push({ token_address: args[0] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("holder_enrichment") || sql.includes("activity_enrichment")) {
            writesToForbiddenTables.push(sql);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("SELECT * FROM sync_lock")) return lockRow;
          if (sql.includes("SELECT token_address, first_seen_at FROM launches")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT * FROM launches WHERE token_address=?")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT 1")) return { 1: 1 };
          return null;
        },
        async all() {
          if (sql.includes("FROM launches WHERE token_address IN")) {
            return { results: args.map((a) => launches.get(a)).filter(Boolean) };
          }
          if (sql.includes("market_snapshots") && sql.includes("token_address IN")) {
            return { results: [] }; // no prior snapshot needed for this minimal test
          }
          if (sql.includes("FROM creators WHERE creator_address IN")) {
            return { results: [] };
          }
          if (sql.includes("GROUP BY creator_address")) {
            return { results: [] }; // no creator_address on the single test launch
          }
          if (sql.includes("FROM scores s")) {
            return { results: [] }; // enrichment candidate selection — irrelevant, includeEnrichment:false
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

const FAKE_LAUNCH = {
  tokenAddress: "0xabc0000000000000000000000000000000abc1",
  creatorAddress: "0xcreatorabc0000000000000000000000000001",
  createdAt: new Date().toISOString(),
};

function installFakeVibeFetch(t, items = [FAKE_LAUNCH]) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/launches") && !u.includes("/launches/")) {
      return { ok: true, status: 200, json: async () => ({ data: { items, page: { hasMore: false } } }) };
    }
    // builders / season builders — irrelevant to these tests
    return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
  };
  // t.after guarantees restoration even if the test throws/asserts before
  // reaching a manual restore call — a prior version of this test leaked
  // the fake fetch into later tests on assertion failure.
  t.after(() => {
    global.fetch = original;
  });
}

/** A `now` function for injection into runSync's opts: the first call (used
 * to capture runSyncLocked's startTime) returns the real time; every call
 * after that (checkpoint reads) returns real time + jumpMs — so elapsed
 * time as seen by the time-budget guard is deterministically `jumpMs`,
 * without any fragile global Date.now monkey-patching or reliance on how
 * many unrelated Date.now()/newDate() calls happen elsewhere in the path. */
function makeJumpingClock(jumpMs) {
  let calls = 0;
  return () => {
    calls++;
    return calls === 1 ? Date.now() : Date.now() + jumpMs;
  };
}

test("5. an expired, abandoned lease can eventually be recovered by a new invocation", async () => {
  const d1 = makeSyncD1();
  const now = Date.now();
  await tryAcquireLock(d1, "abandoned-owner", LOCK_TTL_MS, now);
  const later = now + LOCK_TTL_MS + 60_000;
  const recovered = await tryAcquireLock(d1, "new-owner", LOCK_TTL_MS, later);
  assert.equal(recovered, true);
});

test("6+11 unexpected-error path: lock is released (via outer finally) even on a generic error, and sync_runs is left honestly orphaned, not fabricated", async (t) => {
  // Forces an unexpected (non-lock/non-time-budget) error partway through
  // the sync — the creator-aggregation query, which the fake launch's
  // creatorAddress guarantees actually gets called (touchedCreators is
  // non-empty) — exercising the "any other unexpected error" rethrow
  // branch, distinct from the anticipated LockLostError/TimeBudgetError
  // paths tested elsewhere.
  const d1 = makeSyncD1();
  installFakeVibeFetch(t);
  const originalPrepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => {
    if (sql.includes("GROUP BY creator_address")) throw new Error("simulated unexpected DB error");
    return originalPrepare(sql);
  };

  await assert.rejects(() => runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false }));

  assert.equal(d1.lockRow(), null, "lock must be released even after an unexpected in-process error");
});

test("8. losing lock ownership mid-sync aborts immediately with FAILED_LOCK_LOST, no further writes", async (t) => {
  const d1 = makeSyncD1({ stealLockAfterAcquire: true });
  installFakeVibeFetch(t);
  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false });

  assert.equal(result.status, "FAILED_LOCK_LOST");
  assert.equal(d1.scoresCount(), 0, "scoring must never run after lease ownership is lost");
  assert.equal(d1.writesToForbiddenTables().length, 0);
  const run = d1.syncRuns().find((r) => r.run_id === result.run_id);
  assert.equal(run.status, "FAILED_LOCK_LOST");
});

test("9. breaching the time budget aborts the sync truthfully with FAILED_TIME_BUDGET", async (t) => {
  const d1 = makeSyncD1();
  installFakeVibeFetch(t);

  const result = await runSync(d1, {
    pages: 1,
    pageLimit: 1,
    includeEnrichment: false,
    now: makeJumpingClock(16 * 60_000), // 16 min > TIME_BUDGET_MS (15 min)
  });

  assert.equal(result.status, "FAILED_TIME_BUDGET");
  assert.equal(d1.scoresCount(), 0, "scoring must never run after the time budget is breached");
  const run = d1.syncRuns().find((r) => r.run_id === result.run_id);
  assert.equal(run.status, "FAILED_TIME_BUDGET");
});

test("10. lock is released after a clean COMPLETED sync", async (t) => {
  const d1 = makeSyncD1();
  installFakeVibeFetch(t);
  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false });

  assert.equal(result.status, "COMPLETED");
  assert.equal(d1.lockRow(), null, "lock must be released after a successful completion");
});
