/**
 * CLOUDFLARE D1 REST API CLIENT (GitHub Actions redesign)
 * ============================================================
 * Implements the SAME shape as the Cloudflare Workers D1 binding —
 * `prepare(sql).bind(...args).run()/.all()/.first()`, plus `batch()` — so
 * every existing, tested piece of business logic (db.js, sync.js,
 * scoring.js) runs COMPLETELY UNCHANGED whether it's invoked from the
 * deployed Worker (via the real binding) or from a GitHub Actions script
 * (via this REST client). One shared source of truth — see sync.js and
 * scripts/sync-cron.mjs.
 *
 * INCIDENT (2026-09-14): the first real GitHub Actions run ended
 * FAILED_OPERATION_TIMEOUT inside creator aggregation. Root cause: every
 * D1 operation was one individual HTTPS round-trip (~200-300ms real
 * internet latency GitHub-runner -> Cloudflare, vs. the Workers binding's
 * near-instant internal call) with NO batching — a phase touching ~150
 * rows cost ~150 sequential round-trips, comfortably exceeding even the
 * generous 30s heavy-operation bound. batch() (below) sends many
 * statements in ONE HTTPS round-trip instead, and db.js's write-heavy
 * hot-path functions now use it when available (see db.js's runBatch()).
 *
 * Auth: `Authorization: Bearer <apiToken>` — a narrowly-scoped Cloudflare
 * API Token (D1 Edit permission only), never the account's global API
 * key. The token is read from the process environment by the caller
 * (scripts/sync-cron.mjs) and passed in here; this module never reads the
 * environment directly itself, never logs the token, and never includes it
 * in any thrown error message — only non-secret request/response details
 * (SQL, HTTP status, a truncated response body) ever appear in errors.
 */
import { withTimeout, OperationTimeoutError } from "./timeouts.js";

export class D1RestError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000; // one REST call — generous but bounded, never infinite
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
// Cloudflare doesn't publish an explicit max-statements-per-batch figure;
// this reuses the same conservative chunk size already proven safe
// elsewhere in this codebase (see db.js's D1_SAFE_IN_CHUNK).
const MAX_BATCH_STATEMENTS = 90;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Creates a D1-binding-shaped client backed by Cloudflare's D1 REST API.
 * `fetchImpl` is injectable for tests (defaults to the global fetch, which
 * exists natively in modern Node — no extra dependency needed).
 */
export function createD1RestClient({ accountId, databaseId, apiToken, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!accountId) throw new D1RestError("CF_ACCOUNT_ID is required to create a D1 REST client");
  if (!databaseId) throw new D1RestError("CF_D1_DATABASE_ID is required to create a D1 REST client");
  if (!apiToken) throw new D1RestError("CF_D1_API_TOKEN is required to create a D1 REST client");

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function post(body, label) {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await withTimeout(
          fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // The ONLY place the token is ever used — never logged,
              // never included in an error message below.
              authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify(body),
          }),
          timeoutMs,
          label
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          // 4xx (bad SQL, auth failure, permission denied) is never
          // retried — retrying an auth failure risks needlessly tripping
          // Cloudflare's own abuse/rate-limiting, and it will just fail
          // identically again regardless.
          throw new D1RestError(`D1_REST_HTTP_${resp.status}: ${text.slice(0, 500)}`);
        }

        const respBody = await withTimeout(resp.json(), timeoutMs, `${label}_body_parse`);
        if (!respBody.success) {
          const msg = (respBody.errors || []).map((e) => e.message || JSON.stringify(e)).join("; ");
          // An API-level failure is a clear, explicit error — never
          // silently treated as an empty/successful result.
          throw new D1RestError(`D1_REST_API_ERROR: ${msg || "unknown (no error message returned)"}`);
        }
        return respBody;
      } catch (e) {
        const wrapped =
          e instanceof D1RestError
            ? e
            : new D1RestError(`D1_REST_FETCH_ERROR: ${e instanceof OperationTimeoutError ? e.message : String(e?.message || e)}`);
        lastErr = wrapped;
        // Retry ONLY network/timeout-shaped failures and 5xx — never a
        // confirmed 4xx/API-level error (those are deterministic and
        // retrying wastes the bounded retry budget on a certain failure).
        const retryable = /^D1_REST_FETCH_ERROR/.test(wrapped.message) || /^D1_REST_HTTP_5\d\d/.test(wrapped.message);
        if (!retryable || attempt === MAX_RETRIES) break;
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async function execute(sql, params) {
    const body = await post({ sql, params: params || [] }, "d1_rest_query");
    const result = Array.isArray(body.result) ? body.result[0] : body.result;
    return { results: result?.results || [], success: true, meta: result?.meta || {} };
  }

  /** Executes many statements as one or more REST batch calls (chunked at
   * MAX_BATCH_STATEMENTS). Each entry is `{sql, params}`; returns one
   * `{results, meta}` per entry, in the same order. NOT necessarily
   * cross-chunk-atomic (each chunk is its own HTTP call), but every
   * caller in this codebase writes idempotently, so a chunk boundary
   * failure is always safely retryable/resumable, never a correctness
   * hazard. */
  async function executeBatch(entries) {
    const out = [];
    for (const part of chunk(entries, MAX_BATCH_STATEMENTS)) {
      const body = await post({ batch: part.map((e) => ({ sql: e.sql, params: e.params || [] })) }, "d1_rest_batch");
      const results = Array.isArray(body.result) ? body.result : [body.result];
      for (const r of results) out.push({ results: r?.results || [], meta: r?.meta || {} });
    }
    return out;
  }

  return {
    prepare(sql) {
      let boundArgs = [];
      const stmt = {
        bind(...args) {
          boundArgs = args;
          return stmt;
        },
        async run() {
          const r = await execute(sql, boundArgs);
          return { meta: r.meta };
        },
        async all() {
          const r = await execute(sql, boundArgs);
          return { results: r.results };
        },
        async first() {
          const r = await execute(sql, boundArgs);
          return r.results[0] || null;
        },
        // Internal accessor for this module's own batch() — not part of
        // the public D1-binding-compatible surface other code relies on.
        _entry() {
          return { sql, params: boundArgs };
        },
      };
      return stmt;
    },
    /** Matches the Workers D1Database.batch() shape: takes an array of
     * prepared+bound statements (from .prepare().bind()) and returns an
     * array of .run()-shaped results, one per statement, in order. */
    async batch(statements) {
      const entries = statements.map((s) => s._entry());
      return executeBatch(entries);
    },
  };
}
