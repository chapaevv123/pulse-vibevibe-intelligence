/**
 * RENEWABLE SYNC LEASE (public demo)
 * ======================================
 * V1 (fixed-TTL-only) was added after a production incident: an overlapping
 * cron trigger stacked concurrent syncs for ~40 minutes before being caught.
 * V1's guard worked exactly as designed — and that's how it caught a SECOND
 * incident: the fixed 8-minute TTL was sized against duration data from
 * when the database was smaller. As the database grew, sync duration grew
 * with it (an unrelated bug, since fixed — see docs/DEPLOYMENT.md), blew
 * past the fixed TTL while the sync was still genuinely alive, and the next
 * cron tick legitimately "recovered" the expired lock and ran concurrently.
 *
 * This V2 replaces "acquire once, trust a fixed expiry" with a renewable
 * LEASE: the lease has a long ceiling (LOCK_TTL_MS), but the running sync
 * extends it at natural phase checkpoints via renewLock(). A crashed or
 * hung Worker simply stops renewing, and the lease still expires and
 * becomes recoverable — but a genuinely long-but-alive sync is never
 * evicted out from under itself just because a fixed clock ran out.
 *
 * Mechanism (acquisition, unchanged from V1): one atomic SQL statement —
 *
 *   INSERT INTO sync_lock (...) VALUES (...)
 *   ON CONFLICT(lock_name) DO UPDATE SET ...
 *   WHERE sync_lock.expires_at < <now>
 *
 * D1 (SQLite) serializes writes to a given row, so this is atomic: the
 * UPDATE branch only fires if the existing lock has already expired: if it
 * doesn't fire, the INSERT is also suppressed by the conflict, so the
 * statement touches zero rows. `meta.changes > 0` is an unambiguous signal
 * that THIS caller now holds the lease — no read-then-write race window.
 *
 * Renewal (new): `UPDATE sync_lock SET expires_at=? WHERE lock_name=? AND
 * owner_id=?` — also a single atomic statement, and critically scoped to
 * BOTH lock_name and owner_id, so a different owner can never renew (or
 * silently overwrite) a lease it doesn't hold. `meta.changes > 0` means the
 * renewal succeeded and this caller still owns the lease; `0` means
 * ownership has been lost (the lease expired and someone else took it, or
 * the row was otherwise deleted) and the caller MUST abort immediately.
 *
 * LEASE TTL REASONING: base ceiling raised from 8 to 20 minutes.
 *   - measured real sync duration after the scaling fix: ~156 seconds
 *   - planned cron cadence: every 10 minutes
 *   - if a sync unexpectedly exceeds 10 minutes, the NEXT cron tick must
 *     cleanly SKIP (find an unexpired, actively-renewed lease) rather than
 *     race to "recover" it — a 20-minute ceiling comfortably covers two
 *     full cron cycles of anomalous slowness before ever falling back to
 *     TTL-based recovery, while renewal means a healthy sync's actual
 *     20-minute exposure window never matters in practice: it re-extends
 *     the lease every checkpoint long before the ceiling is ever reached.
 *   - the ceiling still exists (not infinite) so a genuinely crashed
 *     Worker's lease is always eventually recoverable — it just stops being
 *     renewed and expires on schedule.
 *   Not 8 minutes anymore: 8 minutes is exactly the value that failed
 *   during the incident this rewrite exists to prevent.
 */

export const LOCK_NAME = "vibe_sync";
export const LOCK_TTL_MS = 20 * 60 * 1000; // 20 minutes — see reasoning above. Not 8, not 1.

export function newOwnerId() {
  return `owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Attempts to atomically acquire the global sync lease. Returns true iff
 * this call now holds it (either the lease was free, or a prior one had
 * expired and was recovered). Returns false if another owner currently
 * holds an unexpired lease — callers MUST treat false as "do not proceed."
 */
export async function tryAcquireLock(D1, ownerId, ttlMs = LOCK_TTL_MS, nowMs = Date.now()) {
  const acquiredAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const res = await D1.prepare(
    `INSERT INTO sync_lock (lock_name, owner_id, acquired_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(lock_name) DO UPDATE SET
       owner_id = excluded.owner_id,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at
     WHERE sync_lock.expires_at < ?`
  )
    .bind(LOCK_NAME, ownerId, acquiredAt, expiresAt, acquiredAt)
    .run();
  return (res.meta?.changes || 0) > 0;
}

/**
 * Atomically extends the lease's expiry — ONLY if lock_name AND owner_id
 * both still match. Returns true if this caller still owns the lease
 * (renewal applied); false means ownership has been lost and the caller
 * MUST abort immediately (never continue upstream calls or writes).
 */
export async function renewLock(D1, ownerId, ttlMs = LOCK_TTL_MS, nowMs = Date.now()) {
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const res = await D1.prepare("UPDATE sync_lock SET expires_at=? WHERE lock_name=? AND owner_id=?")
    .bind(expiresAt, LOCK_NAME, ownerId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

/** Releases the lease ONLY if the caller still owns it (defensive: never
 * releases a lease acquired by someone else, e.g. if ownership was already
 * lost and another invocation took over while this one was still finishing
 * its abort path). */
export async function releaseLock(D1, ownerId) {
  await D1.prepare("DELETE FROM sync_lock WHERE lock_name=? AND owner_id=?").bind(LOCK_NAME, ownerId).run();
}

/** Read-only lease inspection for /api/health and diagnostics — never used
 * for acquisition/renewal decisions (those are tryAcquireLock's and
 * renewLock's own atomic statements). */
export async function getLockState(D1, nowMs = Date.now()) {
  const row = await D1.prepare("SELECT * FROM sync_lock WHERE lock_name=?").bind(LOCK_NAME).first();
  if (!row) return { active: false, owner_id: null, acquired_at: null, expires_at: null };
  const expiresMs = Date.parse(row.expires_at);
  const active = !Number.isNaN(expiresMs) && expiresMs >= nowMs;
  return { active, owner_id: row.owner_id, acquired_at: row.acquired_at, expires_at: row.expires_at };
}
