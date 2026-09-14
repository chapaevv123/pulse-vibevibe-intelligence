import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync } from "../src/sync.js";
import { handleHealth } from "../src/api.js";

// Full-stack D1 mock covering sync_lock + sync_runs with real conditional
// semantics, plus a write-attempt tripwire on every other table — a
// blocked (SKIPPED_LOCKED) invocation must NEVER touch launches,
// market_snapshots, scores, holder_enrichment, or activity_enrichment.
function makeGuardD1({ preHeldLock } = {}) {
  let lockRow = preHeldLock || null;
  const syncRuns = [];
  const forbiddenWrites = [];
  const FORBIDDEN_TABLES = ["launches", "market_snapshots", "scores ", "holder_enrichment", "activity_enrichment", "creators"];

  return {
    forbiddenWrites: () => forbiddenWrites,
    syncRuns: () => syncRuns,
    lockRow: () => lockRow,
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
          if (FORBIDDEN_TABLES.some((t) => sql.includes(t))) {
            forbiddenWrites.push(sql);
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("SELECT * FROM sync_lock")) return lockRow;
          if (sql.includes("SELECT 1")) return { 1: 1 };
          if (sql.includes("FROM sync_runs")) {
            let candidates = syncRuns;
            const eqMatch = sql.match(/status='(\w+)'/);
            const inMatch = sql.match(/status IN \(([^)]+)\)/);
            if (eqMatch) {
              candidates = candidates.filter((r) => r.status === eqMatch[1]);
            } else if (inMatch) {
              const allowed = inMatch[1].split(",").map((s) => s.trim().replace(/'/g, ""));
              candidates = candidates.filter((r) => allowed.includes(r.status));
            }
            return candidates.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] || null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

test("3+4. a blocked (locked) invocation performs zero upstream fetches and zero table writes", async (t) => {
  const activeLock = {
    lock_name: "vibe_sync",
    owner_id: "someone-else",
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), // still valid
  };
  const d1 = makeGuardD1({ preHeldLock: activeLock });

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async (...args) => {
    fetchCalls++;
    throw new Error(`upstream fetch must never be called while blocked: ${args[0]}`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await runSync(d1);

  assert.equal(fetchCalls, 0, "a blocked invocation must issue zero upstream vibe/vibe calls");
  assert.equal(d1.forbiddenWrites().length, 0, "a blocked invocation must write zero launch/snapshot/score/enrichment rows");
  assert.equal(result.status, "SKIPPED_LOCKED");
  assert.equal(result.locked_by, "someone-else");

  const recordedRun = d1.syncRuns().find((r) => r.run_id === result.run_id);
  assert.ok(recordedRun, "a truthful SKIPPED_LOCKED sync_runs row must still be recorded");
  assert.equal(recordedRun.status, "SKIPPED_LOCKED");
});

test("8. a stale historical RUNNING sync_runs row does not make /api/health report an active sync", async () => {
  const d1 = makeGuardD1(); // no lock held right now
  // Simulate a past incident: a RUNNING row with no finished_at, never
  // touched by cleanup — exactly what the real production incident left
  // behind. This must never leak into current_sync_active.
  d1.syncRuns().push({
    run_id: "run_orphaned_incident",
    run_type: "SYNC",
    started_at: "2026-09-13T15:05:22.287Z",
    status: "RUNNING",
    source: "LIVE",
  });

  const res = await handleHealth(d1, {});
  const body = await res.json();

  assert.equal(body.current_sync_active, false, "a stale RUNNING row must not be interpreted as an active sync");
  assert.equal(body.current_sync_owner, null);
  // last_sync_result must exclude the raw RUNNING row entirely.
  assert.notEqual(body.last_sync_result?.status, "RUNNING");
});

test("current_sync_active is true only while the lock is genuinely held and unexpired", async () => {
  const activeLock = {
    lock_name: "vibe_sync",
    owner_id: "owner-live",
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const d1 = makeGuardD1({ preHeldLock: activeLock });
  const res = await handleHealth(d1, {});
  const body = await res.json();
  assert.equal(body.current_sync_active, true);
  assert.equal(body.current_sync_owner, "owner-live");
});
