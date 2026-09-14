/**
 * CLOUDFLARE D1 REST API CLIENT (GitHub Actions redesign)
 * ============================================================
 * Implements the SAME shape as the Cloudflare Workers D1 binding —
 * `prepare(sql).bind(...args).run()/.all()/.first()` — so every existing,
 * tested piece of business logic (db.js, sync.js, scoring.js) runs
 * COMPLETELY UNCHANGED whether it's invoked from the deployed Worker (via
 * the real binding) or from a GitHub Actions script (via this REST
 * client). One shared source of truth — see sync.js and scripts/sync-cron.mjs.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  async function execute(sql, params) {
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
            body: JSON.stringify({ sql, params: params || [] }),
          }),
          timeoutMs,
          "d1_rest_query"
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          // 4xx (bad SQL, auth failure, permission denied) is never
          // retried — retrying an auth failure risks needlessly tripping
          // Cloudflare's own abuse/rate-limiting, and it will just fail
          // identically again regardless.
          throw new D1RestError(`D1_REST_HTTP_${resp.status}: ${text.slice(0, 500)}`);
        }

        const body = await withTimeout(resp.json(), timeoutMs, "d1_rest_body_parse");
        if (!body.success) {
          const msg = (body.errors || []).map((e) => e.message || JSON.stringify(e)).join("; ");
          // An API-level failure is a clear, explicit error — never
          // silently treated as an empty/successful result.
          throw new D1RestError(`D1_REST_API_ERROR: ${msg || "unknown (no error message returned)"}`);
        }

        const result = Array.isArray(body.result) ? body.result[0] : body.result;
        return {
          results: result?.results || [],
          success: true,
          meta: result?.meta || {},
        };
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
      };
      return stmt;
    },
  };
}
