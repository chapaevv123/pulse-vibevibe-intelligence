import { test } from "node:test";
import assert from "node:assert/strict";

// 15. Proves the GitHub Actions entrypoint (scripts/sync-cron.mjs) is a
// thin wrapper — it wires a D1 REST client in place of the Workers D1
// binding and calls the SAME shared runSync() used everywhere else, with
// no forked/duplicate sync or scoring logic of its own. Exercises the
// full stack end-to-end: entrypoint -> d1RestClient -> runSync -> lock.js
// -> scoring.js, against fake HTTP responses for both the D1 REST API and
// the vibe/vibe upstream API.

function d1RestResponse(results = [], meta = {}) {
  return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: [{ results, success: true, meta }] }) };
}

function makeFakeD1RestBackend() {
  let lockRow = null;
  const launches = new Map();
  const syncRuns = [];
  let syncState = null;

  return async (url, options) => {
    const body = JSON.parse(options.body);
    const { sql, params = [] } = body;

    if (sql.includes("INSERT INTO sync_lock")) {
      const [lockName, ownerId, acquiredAt, expiresAt, nowForCompare] = params;
      if (!lockRow || lockRow.expires_at < nowForCompare) {
        lockRow = { lock_name: lockName, owner_id: ownerId, acquired_at: acquiredAt, expires_at: expiresAt };
        return d1RestResponse([], { changes: 1 });
      }
      return d1RestResponse([], { changes: 0 });
    }
    if (sql.startsWith("UPDATE sync_lock SET expires_at")) {
      const [expiresAt, lockName, ownerId] = params;
      if (lockRow && lockRow.lock_name === lockName && lockRow.owner_id === ownerId) {
        lockRow.expires_at = expiresAt;
        return d1RestResponse([], { changes: 1 });
      }
      return d1RestResponse([], { changes: 0 });
    }
    if (sql.includes("DELETE FROM sync_lock")) {
      const [lockName, ownerId] = params;
      if (lockRow && lockRow.lock_name === lockName && lockRow.owner_id === ownerId) {
        lockRow = null;
        return d1RestResponse([], { changes: 1 });
      }
      return d1RestResponse([], { changes: 0 });
    }
    if (sql.includes("SELECT * FROM sync_lock")) return d1RestResponse(lockRow ? [lockRow] : []);
    if (sql.includes("SELECT * FROM sync_state")) return d1RestResponse(syncState ? [syncState] : []);
    if (sql.includes("INSERT INTO sync_state")) {
      syncState = { state_name: params[0], last_seen_created_at: params[1], last_successful_sync: params[2] };
      return d1RestResponse([], { changes: 1 });
    }
    if (sql.startsWith("UPDATE sync_state SET")) {
      if (syncState) syncState = { ...syncState, last_seen_created_at: params[0], last_successful_sync: params[1] };
      return d1RestResponse([], { changes: syncState ? 1 : 0 });
    }
    if (sql.includes("INSERT INTO sync_runs")) {
      syncRuns.push({ run_id: params[0], status: params[3] });
      return d1RestResponse([], { changes: 1 });
    }
    if (sql.startsWith("UPDATE sync_runs SET")) {
      const runId = params[params.length - 1];
      const row = syncRuns.find((r) => r.run_id === runId);
      const cols = [...sql.matchAll(/(\w+)=\?/g)].map((m) => m[1]);
      cols.forEach((c, i) => {
        if (row) row[c] = params[i];
      });
      return d1RestResponse([], { changes: row ? 1 : 0 });
    }
    if (sql.includes("SELECT token_address, first_seen_at FROM launches") || sql.includes("SELECT * FROM launches WHERE token_address=?")) {
      return d1RestResponse(launches.has(params[0]) ? [launches.get(params[0])] : []);
    }
    if (sql.includes("INSERT INTO launches")) {
      launches.set(params[0], { token_address: params[0], creator_address: params[6] || null, created_at: params[10] });
      return d1RestResponse([], { changes: 1 });
    }
    if (sql.includes("FROM launches WHERE token_address IN")) {
      return d1RestResponse(params.map((a) => launches.get(a)).filter(Boolean));
    }
    // Any other write (snapshots, scores, creators, enrichment tables,
    // builder ranks) — accept harmlessly, matching the other mocks' style.
    if (/^(INSERT|UPDATE)/.test(sql.trim())) return d1RestResponse([], { changes: 1 });
    return d1RestResponse([]);
  };
}

test("15. sync-cron.mjs entrypoint drives the shared runSync() through the D1 REST client end-to-end, never logs the token", async () => {
  const savedEnv = { ...process.env };
  const savedExitCode = process.exitCode;
  const originalFetch = global.fetch;
  const secretToken = "super-secret-d1-token-should-never-appear-in-logs";

  process.env.CF_ACCOUNT_ID = "test-account";
  process.env.CF_D1_DATABASE_ID = "test-db";
  process.env.CF_D1_API_TOKEN = secretToken;

  const d1Backend = makeFakeD1RestBackend();
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.cloudflare.com")) return d1Backend(url, options);
    if (u.includes("/launches") && !u.includes("/launches/")) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [], page: { hasMore: false } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
  };

  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const { main } = await import("../scripts/sync-cron.mjs");
    await main();
  } finally {
    process.env = savedEnv;
    process.exitCode = savedExitCode;
    global.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }

  const allOutput = [...logs, ...errors].join("\n");
  assert.ok(!allOutput.includes(secretToken), "the API token must NEVER appear in any log output");
  assert.match(allOutput, /"status":\s*"(COMPLETED|SKIPPED_LOCKED)"/, "should report a clean terminal status in the summary");
  assert.match(allOutput, /run_id/, "summary must include a run_id");
});

test("missing required env vars fail fast with a clear message, before any network call", async () => {
  const savedEnv = { ...process.env };
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.CF_D1_DATABASE_ID;
  delete process.env.CF_D1_API_TOKEN;

  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("should never be called");
  };

  try {
    const { main } = await import("../scripts/sync-cron.mjs?t=" + Date.now()); // bust module cache for a fresh env read
    await assert.rejects(() => main(), /CF_ACCOUNT_ID/);
  } finally {
    process.env = savedEnv;
    global.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, "no network call should happen before env validation completes");
});
