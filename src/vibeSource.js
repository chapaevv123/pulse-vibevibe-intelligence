/**
 * VIBE/VIBE SOURCE CLIENT (public demo)
 * ======================================
 * Read-only fetch client for the vibe/vibe public JSON API. Ported 1:1 in
 * spirit from the local Pulse MVP's pulse_vibe_robinhood_sources_v1.py:
 * GET-only, no key required, bounded retries with backoff on 429/5xx, never
 * writes, never signs, never touches a wallet.
 */
import { VIBE_BASE_URL, VIBE_API_PREFIX, VIBE_CHAIN_ID } from "./config.js";
import { withTimeout, fetchWithAbort, OperationTimeoutError, UPSTREAM_FETCH_TIMEOUT_MS, UPSTREAM_BODY_TIMEOUT_MS } from "./timeouts.js";

export class VibeSourceError extends Error {}
export class VibeRateLimited extends VibeSourceError {}

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1500;
const UA = "PulseVibeRobinhoodIntelligence-PublicDemo/1.0 (+research-only; read-only)";

// vibe/vibe was observed to advertise x-ratelimit-limit: 60 on a short
// rolling window (see pulse_vibe_robinhood_sources_v1.py). A single sync can
// issue dozens of calls (launches pages + builders + up to 20 enriched
// tokens x2), so this Worker paces itself the same conservative way the
// local Python client does, rather than relying on 429 retries alone.
const MIN_MS_BETWEEN_CALLS = 1100;
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_MS_BETWEEN_CALLS) {
    await sleep(MIN_MS_BETWEEN_CALLS - elapsed);
  }
}

async function get(path, params = {}) {
  const url = new URL(`${VIBE_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    try {
      lastCallAt = Date.now();
      // Bounds header arrival only (real cancellation via AbortController).
      // INCIDENT FIX: the previous version cleared this same timer right
      // here and left `resp.json()` completely unbounded — a stalled
      // response body could then hang forever with no error, defeating
      // even the sync-level time budget (which only checks at checkpoints,
      // and a hung await never reaches one). Body parsing now gets its
      // OWN separate, explicit bound below.
      const resp = await fetchWithAbort(
        url.toString(),
        { headers: { accept: "application/json", "User-Agent": UA } },
        UPSTREAM_FETCH_TIMEOUT_MS,
        `fetch_headers:${path}`
      );
      if (resp.status === 429) {
        lastErr = new VibeRateLimited(`HTTP_429:${url}`);
      } else if (resp.status >= 500 && resp.status < 600) {
        lastErr = new VibeSourceError(`HTTP_${resp.status}:${url}`);
      } else if (!resp.ok) {
        throw new VibeSourceError(`HTTP_${resp.status}:${url}`);
      } else {
        return await withTimeout(resp.json(), UPSTREAM_BODY_TIMEOUT_MS, `body_parse:${path}`);
      }
    } catch (e) {
      if (e instanceof OperationTimeoutError) {
        lastErr = new VibeSourceError(`TIMEOUT:${e.message}:${url}`);
      } else if (e instanceof VibeSourceError) {
        throw e;
      } else {
        lastErr = new VibeSourceError(`FETCH_ERROR:${url}:${e}`);
      }
    }
    if (attempt < MAX_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
  }
  throw lastErr || new VibeSourceError(`UNKNOWN_FAILURE:${url}`);
}

export const fetchConfig = () => get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/config`);

export const fetchLaunches = (cursor, limit = 50) =>
  get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/launches`, { cursor, limit });

export const fetchLaunchDetail = (tokenAddress) =>
  get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/launches/${encodeURIComponent(tokenAddress)}`);

export const fetchLaunchHolders = (tokenAddress, limit = 10) =>
  get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/launches/${encodeURIComponent(tokenAddress)}/holders`, { limit });

export const fetchLaunchActivity = (tokenAddress, limit = 25, cursor) =>
  get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/launches/${encodeURIComponent(tokenAddress)}/activity`, {
    limit,
    cursor,
  });

export const fetchBuilders = (limit = 100) => get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/builders`, { limit });

export const fetchSeasonBuilders = (limit = 100) =>
  get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/season/builders`, { limit });

export const fetchAnalyticsSummary = () => get(`${VIBE_API_PREFIX}/${VIBE_CHAIN_ID}/analytics/summary`);
