/**
 * PULSE x VIBE/VIBE DISPATCH SCHEDULER — CLOUDFLARE WORKER ENTRY POINT
 * =======================================================================
 * The ENTIRE job of this Worker, every ~15 minutes: POST one authenticated
 * request to GitHub's workflow_dispatch REST API for
 * chapaevv123/pulse-vibevibe-intelligence's sync.yml (ref=main), then exit.
 *
 * This file MUST NEVER import sync.js, scoring.js, db.js, vibeSource.js,
 * d1RestClient.js, or any other Pulse sync/business logic, and this Worker
 * has NO D1 binding at all (see wrangler.jsonc) — GitHub Actions' own
 * sync.yml remains the sole writer to D1, completely unchanged. This
 * Worker exists ONLY because GitHub's native `schedule:` trigger failed a
 * canary test (PULSE × VIBE/VIBE GITHUB SCHEDULER CANARY V1, 2026-09-14):
 * zero scheduled events ever fired across 3 different cron patterns and 6
 * expected boundaries, despite workflow config being independently
 * verified correct every time. GitHub Actions' own concurrency group
 * (pulse-vibevibe-sync) and the D1 renewable lease (src/lock.js, in the
 * main public_vibe_demo package) remain the AUTHORITATIVE protection
 * against overlapping sync runs — this Worker deliberately holds no state
 * and makes no attempt to deduplicate dispatches itself.
 *
 * There is deliberately NO public HTTP endpoint that can trigger a
 * dispatch — fetch() below 404s unconditionally. The only way to invoke
 * dispatchSync() is the scheduled() handler (real Cron Trigger) or a
 * local-only `wrangler dev` scheduled-event simulation, run by the repo
 * owner, never a publicly reachable route.
 */

export const GITHUB_API_VERSION = "2022-11-28";
export const OWNER = "chapaevv123";
export const REPO = "pulse-vibevibe-intelligence";
export const WORKFLOW_FILE = "sync.yml";
export const REF = "main";
export const DISPATCH_URL = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

const RETRY_BACKOFF_MS = 1000;

function classifyStatus(status) {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "UNPROCESSABLE";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN_ERROR";
}

function isRetryableStatus(status) {
  return status >= 500;
}

// A structured, secret-free log line — this is the ONLY place dispatch
// outcomes are ever logged, and it deliberately takes named fields
// (never the raw request/response) so a future edit here can't
// accidentally start logging the Authorization header or token.
function logOutcome({ scheduledAt, result, status, retried }) {
  console.log(
    JSON.stringify({
      scheduled_at: scheduledAt,
      result,
      status: status ?? null,
      retried: Boolean(retried),
    })
  );
}

async function postDispatch(token, fetchImpl) {
  return fetchImpl(DISPATCH_URL, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": GITHUB_API_VERSION,
      "content-type": "application/json",
      "user-agent": "pulse-vibevibe-dispatch-scheduler",
    },
    body: JSON.stringify({ ref: REF }),
  });
}

/**
 * Sends exactly one GitHub workflow_dispatch request, with AT MOST one
 * bounded retry and ONLY for a network failure or a 5xx response — never
 * for a 4xx (deterministic, retrying wastes the bound and risks
 * needlessly tripping GitHub's own abuse/rate-limiting). Never reads the
 * response body beyond the status code — the documented success response
 * is 204 with no body, so there's nothing useful to parse either way.
 */
export async function dispatchSync(env, { fetchImpl = fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => new Date().toISOString() } = {}) {
  const scheduledAt = now();
  const token = env && env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    logOutcome({ scheduledAt, result: "CONFIG_ERROR" });
    return { ok: false, classification: "CONFIG_ERROR" };
  }

  let resp;
  try {
    resp = await postDispatch(token, fetchImpl);
  } catch {
    // Network-shaped failure: one bounded retry.
    await sleepImpl(RETRY_BACKOFF_MS);
    try {
      resp = await postDispatch(token, fetchImpl);
    } catch {
      logOutcome({ scheduledAt, result: "NETWORK_ERROR", retried: true });
      return { ok: false, classification: "NETWORK_ERROR" };
    }
  }

  if (resp.ok) {
    logOutcome({ scheduledAt, result: "SUCCESS", status: resp.status });
    return { ok: true, status: resp.status };
  }

  if (isRetryableStatus(resp.status)) {
    await sleepImpl(RETRY_BACKOFF_MS);
    let retryResp;
    try {
      retryResp = await postDispatch(token, fetchImpl);
    } catch {
      logOutcome({ scheduledAt, result: "NETWORK_ERROR", retried: true });
      return { ok: false, classification: "NETWORK_ERROR" };
    }
    if (retryResp.ok) {
      logOutcome({ scheduledAt, result: "SUCCESS", status: retryResp.status, retried: true });
      return { ok: true, status: retryResp.status, retried: true };
    }
    logOutcome({ scheduledAt, result: classifyStatus(retryResp.status), status: retryResp.status, retried: true });
    return { ok: false, classification: classifyStatus(retryResp.status), status: retryResp.status };
  }

  // 4xx (or any other non-retryable, non-2xx status) — no retry.
  logOutcome({ scheduledAt, result: classifyStatus(resp.status), status: resp.status });
  return { ok: false, classification: classifyStatus(resp.status), status: resp.status };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchSync(env, { now: () => new Date(event.scheduledTime).toISOString() }));
  },

  // No public HTTP surface at all — this Worker's only job is the
  // scheduled() handler above. Every request 404s, deliberately: there is
  // no route, authenticated or not, that can trigger a dispatch over
  // HTTP.
  async fetch() {
    return new Response("Not Found", { status: 404 });
  },
};
