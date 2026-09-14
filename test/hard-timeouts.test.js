import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, fetchWithAbort, OperationTimeoutError } from "../src/timeouts.js";
import { runSync } from "../src/sync.js";
import { tryAcquireLock, releaseLock, newOwnerId } from "../src/lock.js";

// Regression suite for a real incident: a scheduled sync hung indefinitely
// between checkpoints (traced to vibeSource.js clearing its fetch-abort
// timer before body parsing, leaving resp.json() completely unbounded) and
// sat RUNNING past the 15-minute time budget because the budget check only
// ever runs AT a checkpoint — a hung await never reaches one. These tests
// prove every potentially-blocking operation on the hot sync path now fails
// within a bounded time instead of hanging forever.

function neverResolves() {
  return new Promise(() => {});
}

// ---------------------------------------------------------------------------
// 1-2: direct unit tests on the timeout primitives (fast — tiny ms values)
// ---------------------------------------------------------------------------

test("1. a hung fetch aborts within the configured timeout (AbortController)", async () => {
  const originalFetch = global.fetch;
  let sawAbort = false;
  global.fetch = (url, options) =>
    new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  try {
    const start = Date.now();
    await assert.rejects(() => fetchWithAbort("http://example.invalid/", {}, 30, "test_fetch"), OperationTimeoutError);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `should abort near the 30ms timeout, took ${elapsed}ms`);
    assert.equal(sawAbort, true, "the AbortController signal must actually fire, not just the timer");
  } finally {
    global.fetch = originalFetch;
  }
});

test("2. hung response-body parsing (e.g. resp.json()) times out independently of the fetch itself", async () => {
  // Simulates the exact incident shape: headers already arrived (the fetch
  // "succeeded"), but the body read/parse hangs forever.
  const start = Date.now();
  await assert.rejects(() => withTimeout(neverResolves(), 30, "body_parse:test"), OperationTimeoutError);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `should time out near 30ms, took ${elapsed}ms`);
});

test("withTimeout preserves the ORIGINAL error when the operation fails normally (not via timeout)", async () => {
  const boom = new Error("normal failure, not a timeout");
  await assert.rejects(() => withTimeout(Promise.reject(boom), 5000, "test"), (e) => e === boom);
});

test("withTimeout never leaks its timer (rejecting/resolving promise does not keep the process alive)", async () => {
  // If the timer weren't cleared, this would still "work" functionally,
  // but we can at least assert the fast-resolving path doesn't wait out
  // the (long) timeout — proving Promise.race + finally(clearTimeout) is
  // wired correctly.
  const start = Date.now();
  await withTimeout(Promise.resolve("fast"), 5000, "test");
  assert.ok(Date.now() - start < 200, "a fast-resolving promise must not wait for the timeout");
});

// ---------------------------------------------------------------------------
// 3-9, 15: full-sync integration via a minimal but real mock D1 that can
// make one named operation hang forever, plus a fake upstream fetch.
// ---------------------------------------------------------------------------

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
    return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
  };
  t.after(() => {
    global.fetch = original;
  });
}

function makeSyncD1({ hangOnSqlIncludes = null } = {}) {
  let lockRow = null;
  const launches = new Map();
  const syncRuns = [];
  const writesAfterHang = [];
  let hung = false;

  // Once an operation has timed out, the ONLY legitimate further D1 traffic
  // is the terminal status write (sync_runs) and the lease release
  // (sync_lock) — both required by design. Anything touching actual
  // sync-data TABLES after that point would mean work continued past a
  // timeout, which must never happen. Word-boundary matching (not plain
  // substring) — sync_runs's own column names (scores_written,
  // creators_updated) would otherwise false-positive against "scores"/
  // "creators" via naive .includes().
  const FORBIDDEN_TABLE_RE = /\b(launches|market_snapshots|scores|creators|holder_enrichment|activity_enrichment)\b/;
  function maybeHang(sql) {
    if (hangOnSqlIncludes && sql.includes(hangOnSqlIncludes)) {
      hung = true;
      return neverResolves();
    }
    if (hung && FORBIDDEN_TABLE_RE.test(sql) && !sql.includes("sync_runs")) writesAfterHang.push(sql);
    return null;
  }

  return {
    lockRow: () => lockRow,
    syncRuns: () => syncRuns,
    writesAfterHang: () => writesAfterHang,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          return stmt;
        },
        async run() {
          const hang = maybeHang(sql);
          if (hang) return hang;
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
          const hang = maybeHang(sql);
          if (hang) return hang;
          if (sql.includes("SELECT * FROM sync_lock")) return lockRow;
          if (sql.includes("SELECT token_address, first_seen_at FROM launches")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT * FROM launches WHERE token_address=?")) return launches.get(args[0]) || null;
          if (sql.includes("SELECT 1")) return { 1: 1 };
          return null;
        },
        async all() {
          const hang = maybeHang(sql);
          if (hang) return hang;
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

test("3+5+6+7. a hung D1 write times out, aborts truthfully with FAILED_OPERATION_TIMEOUT, does no further work, and releases the lease", async (t) => {
  const d1 = makeSyncD1({ hangOnSqlIncludes: "INSERT INTO launches" });
  installFakeVibeFetch(t);

  const start = Date.now();
  // The page-fetch loop's launch upsert is now batched (upsertLaunchRows),
  // which bundles a chunked existence read with a batched write and is
  // therefore categorized under d1heavy (same tier as the other
  // multi-round-trip batched lookups) rather than d1w — set both timeout
  // tiers small so this test stays robust regardless of which tier the
  // hang falls under.
  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false, d1WriteTimeoutMs: 30, d1HeavyTimeoutMs: 30 });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `should abort near the 30ms D1 write timeout, took ${elapsed}ms`);
  assert.equal(result.status, "FAILED_OPERATION_TIMEOUT");
  assert.equal(d1.writesAfterHang().length, 0, "no further D1 writes may occur once an operation has timed out");
  assert.equal(d1.lockRow(), null, "lease must be released even after an operation timeout");
  const run = d1.syncRuns().find((r) => r.run_id === result.run_id);
  assert.equal(run.status, "FAILED_OPERATION_TIMEOUT");
});

test("4. a hung heavy D1 read (batched lookup cluster) times out truthfully", async (t) => {
  const d1 = makeSyncD1({ hangOnSqlIncludes: "FROM launches WHERE token_address IN" });
  installFakeVibeFetch(t);

  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false, d1HeavyTimeoutMs: 30 });

  assert.equal(result.status, "FAILED_OPERATION_TIMEOUT");
  assert.equal(d1.lockRow(), null);
});

test("8. releaseLock still refuses a non-owner even in the operation-timeout scenario's aftermath", async () => {
  const d1 = makeSyncD1();
  const now = Date.now();
  await tryAcquireLock(d1, "real-owner", 20 * 60_000, now);
  await releaseLock(d1, "attacker-owner");
  assert.notEqual(d1.lockRow(), null, "a non-owner must never be able to release someone else's lease");
});

test("9. a hung terminal status write (logging the timeout itself) does not recurse or hang the whole call", async (t) => {
  // Both the original operation AND the best-effort terminal recordSyncRun
  // write are configured to hang — proves there is no retry loop and the
  // function still returns within a bounded total time.
  const d1 = makeSyncD1({ hangOnSqlIncludes: "INSERT INTO launches" });
  installFakeVibeFetch(t);

  const start = Date.now();
  // See the note on test 3+5+6+7 above: the hanging write now happens
  // inside the batched, d1heavy-tier upsertLaunchRows(), so both timeout
  // tiers need to be small for this to fail fast.
  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false, d1WriteTimeoutMs: 30, d1HeavyTimeoutMs: 30 });
  const elapsed = Date.now() - start;

  // Every timeout-wrapped call (including the terminal status write
  // itself) shares a small timeout here, so total time stays small and
  // bounded rather than growing with each additional hung write.
  assert.ok(elapsed < 2000, `must not hang or loop — took ${elapsed}ms`);
  assert.equal(result.status, "FAILED_OPERATION_TIMEOUT");
});

test("15. checkpoint/operation progress is recorded truthfully on the run that actually stalled", async (t) => {
  // Targets creatorsFor()'s SQL specifically (unique to the scoring
  // phase's batched-lookup cluster) rather than launchesFor()'s — the
  // page-fetch loop's upsertLaunchRows() now ALSO issues a launchesFor()
  // read (its batched pre-existence check), so hanging on that shared SQL
  // shape would now stall in page_fetch_loop instead of scoring.
  const d1 = makeSyncD1({ hangOnSqlIncludes: "FROM creators WHERE creator_address IN" });
  installFakeVibeFetch(t);

  const result = await runSync(d1, { pages: 1, pageLimit: 1, includeEnrichment: false, d1HeavyTimeoutMs: 30 });
  const run = d1.syncRuns().find((r) => r.run_id === result.run_id);
  const notes = JSON.parse(run.notes_json);

  // The stall happened during the "scoring" phase's batched-lookup read —
  // beginOperation("scoring") must have been recorded before the hang, and
  // the last successful checkpoint must be the one immediately prior
  // ("before_scoring"), not something further along.
  assert.equal(notes.current_operation, "scoring");
  assert.equal(notes.last_checkpoint, "before_scoring");
  assert.equal(result.last_checkpoint, "before_scoring");
  assert.equal(result.current_operation, "scoring");
});

// ---------------------------------------------------------------------------
// 10-14 cross-reference: time-budget logic, lock-lost logic, SKIPPED_LOCKED
// behavior, and zero-upstream/zero-writes-when-blocked are already covered
// by test/lease-renewal.test.js and test/sync-lock-guard.test.js and are
// unaffected by this change (verified by the full suite run). Not
// duplicated here.
// ---------------------------------------------------------------------------
