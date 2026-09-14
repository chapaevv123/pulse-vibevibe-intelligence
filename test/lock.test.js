import { test } from "node:test";
import assert from "node:assert/strict";
import { tryAcquireLock, releaseLock, getLockState, newOwnerId, LOCK_TTL_MS } from "../src/lock.js";

// Minimal in-memory D1 stub that implements REAL conditional-upsert
// semantics for the single sync_lock row — not just canned responses. This
// is what makes these tests meaningful: the WHERE-clause logic in
// tryAcquireLock is exercised for real, the same way it would run against
// actual D1.
function makeLockD1() {
  let row = null; // { lock_name, owner_id, acquired_at, expires_at }
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
            if (!row) {
              row = { lock_name: lockName, owner_id: ownerId, acquired_at: acquiredAt, expires_at: expiresAt };
              return { meta: { changes: 1 } };
            }
            // ON CONFLICT DO UPDATE ... WHERE sync_lock.expires_at < ?
            if (row.expires_at < nowForCompare) {
              row = { lock_name: lockName, owner_id: ownerId, acquired_at: acquiredAt, expires_at: expiresAt };
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
          throw new Error(`unexpected SQL in lock mock: ${sql}`);
        },
        async first() {
          if (sql.includes("SELECT * FROM sync_lock")) return row;
          throw new Error(`unexpected SQL in lock mock: ${sql}`);
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

test("1. first invocation acquires the lock", async () => {
  const d1 = makeLockD1();
  const acquired = await tryAcquireLock(d1, newOwnerId());
  assert.equal(acquired, true);
});

test("2. second concurrent invocation cannot acquire an unexpired lock", async () => {
  const d1 = makeLockD1();
  const now = Date.now();
  const first = await tryAcquireLock(d1, "owner-A", LOCK_TTL_MS, now);
  const second = await tryAcquireLock(d1, "owner-B", LOCK_TTL_MS, now + 1000); // 1s later, well inside TTL
  assert.equal(first, true);
  assert.equal(second, false, "a second owner must not acquire while the first lock is still valid");
  const state = await getLockState(d1, now + 1000);
  assert.equal(state.owner_id, "owner-A", "the lock must still be held by the original owner");
});

test("5. an expired lock can be recovered by a new owner", async () => {
  const d1 = makeLockD1();
  const now = Date.now();
  await tryAcquireLock(d1, "owner-A", LOCK_TTL_MS, now);
  const wayLater = now + LOCK_TTL_MS + 60_000; // 1 minute past expiry
  const recovered = await tryAcquireLock(d1, "owner-B", LOCK_TTL_MS, wayLater);
  assert.equal(recovered, true, "an expired lock must be recoverable, not stuck forever");
  const state = await getLockState(d1, wayLater);
  assert.equal(state.owner_id, "owner-B");
});

test("6. lock is released after a successful sync (owner matches)", async () => {
  const d1 = makeLockD1();
  const ownerId = newOwnerId();
  await tryAcquireLock(d1, ownerId);
  await releaseLock(d1, ownerId);
  const state = await getLockState(d1);
  assert.equal(state.active, false);
});

test("7. releaseLock does not remove a lock owned by someone else (defensive)", async () => {
  const d1 = makeLockD1();
  const now = Date.now();
  await tryAcquireLock(d1, "owner-A", LOCK_TTL_MS, now);
  await releaseLock(d1, "owner-B"); // wrong owner — must be a no-op
  const state = await getLockState(d1, now);
  assert.equal(state.active, true, "a lock must never be released by a non-owner");
  assert.equal(state.owner_id, "owner-A");
});

test("getLockState reports inactive with no owner when no lock row exists", async () => {
  const d1 = makeLockD1();
  const state = await getLockState(d1);
  assert.deepEqual(state, { active: false, owner_id: null, acquired_at: null, expires_at: null });
});

test("LOCK_TTL_MS is not 1 minute and is a positive, sane duration", () => {
  assert.notEqual(LOCK_TTL_MS, 60_000);
  assert.ok(LOCK_TTL_MS >= 5 * 60_000, "TTL must comfortably exceed observed normal sync durations");
  assert.ok(LOCK_TTL_MS <= 30 * 60_000, "TTL must not be so long that a crash blocks many cron cycles");
});
