/**
 * HARD OPERATION TIMEOUTS (public demo)
 * =========================================
 * Added after a real incident: a scheduled sync acquired its lease, renewed
 * once, then never checkpointed again and sat as RUNNING past the 15-minute
 * phase-level time budget without self-aborting. Root-cause inspection of
 * src/vibeSource.js found a provable gap: the AbortController timer guarding
 * a fetch was cleared as soon as HTTP headers arrived, BEFORE `resp.json()`
 * (body read + parse) — so a stalled response body had zero bound. The
 * phase-level time budget in sync.js only gets a chance to fire AT a
 * checkpoint; a single hung await between checkpoints defeats it entirely.
 *
 * This module makes every potentially-blocking operation in the sync path
 * fail within a bounded time, so a hang can never again masquerade as
 * "still legitimately running."
 */

export class OperationTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`OPERATION_TIMEOUT: "${label}" exceeded ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

// Conservative, not multi-minute. Chosen so that any single normal
// operation (one upstream call, one D1 statement) has generous headroom
// under real observed latency, while a genuine hang is caught in seconds,
// not minutes — see docs/DEPLOYMENT.md for the incident this addresses.
export const UPSTREAM_FETCH_TIMEOUT_MS = 20_000; // time to receive HTTP headers
export const UPSTREAM_BODY_TIMEOUT_MS = 10_000; // time to read+parse the JSON body, separately
export const D1_QUERY_TIMEOUT_MS = 20_000; // a single D1 read
export const D1_WRITE_TIMEOUT_MS = 20_000; // a single D1 write/upsert
// For an operation that is legitimately allowed to touch many rows in one
// logical step (creator aggregation, a chunked batched-lookup cluster,
// the enrichment-candidate scan) — still bounded, just with more headroom
// than a single-row D1 call.
export const MAX_HEAVY_DB_OPERATION_MS = 30_000;

/**
 * Bounds any promise (or promise-returning factory, evaluated lazily so the
 * timer doesn't start ticking before the operation itself begins) to
 * timeoutMs. Rejects with OperationTimeoutError on timeout; on a normal
 * failure of the underlying operation, the ORIGINAL error propagates
 * unchanged (Promise.race semantics — whichever settles first wins, and a
 * real rejection is never relabeled as a timeout). Does not (cannot, for a
 * D1 call) cancel the underlying operation — a `.catch(() => {})` is
 * attached to the original promise so a late settlement after we've moved
 * on never surfaces as an unhandled rejection. Never leaks the timer: it is
 * cleared in a `finally` regardless of which side of the race wins.
 */
export function withTimeout(promiseOrFactory, timeoutMs, label) {
  const promise = typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory;
  Promise.resolve(promise).catch(() => {});
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Fetch bounded by AbortController (real cancellation of the in-flight
 * request, preferred over withTimeout's race-without-cancellation for
 * anything that supports AbortSignal). Only covers header arrival — body
 * reading gets its own SEPARATE withTimeout(resp.json(), ...) call by
 * design (see vibeSource.js), because clearing this abort timer as soon as
 * headers arrive is exactly the incident this module exists to prevent:
 * the timer must be cleared then (the request itself is done), but the
 * BODY read that follows must never be left unbounded as a result.
 */
export async function fetchWithAbort(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new OperationTimeoutError(label, timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
