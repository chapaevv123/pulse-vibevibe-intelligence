/**
 * PULSE x VIBE/VIBE PUBLIC DEMO — CLOUDFLARE WORKER ENTRY POINT
 * =================================================================
 * GET-only public surface (dashboard + read-only JSON API). AUTO_SAFE-
 * equivalent for this demo: no wallet, no private key, no signature, no
 * on-chain write, ever.
 *
 * FREE-TIER REDESIGN (2026-09-14): this Worker no longer performs sync.
 * Workers Free's Cron Trigger CPU budget (10ms/invocation, per Cloudflare's
 * published limits) cannot fit the sync's real CPU cost — see
 * docs/DEPLOYMENT.md for the full incident/root-cause writeup. The sync
 * now runs on a schedule via GitHub Actions (.github/workflows/sync.yml +
 * scripts/sync-cron.mjs), writing to the SAME D1 database through the D1
 * REST API (src/d1RestClient.js), using the exact same shared sync/scoring
 * logic (src/sync.js) — no forked/duplicate business logic. This Worker's
 * role is now permanently read-only: dashboard + GET-only JSON API + D1
 * read layer. wrangler.jsonc's `triggers.crons` stays `[]` permanently.
 */
import { renderDashboard } from "./dashboardHtml.js";
import * as api from "./api.js";

function notFound() {
  return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function methodNotAllowed() {
  return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED", note: "This API is read-only (GET only)." }), {
    status: 405,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed();
    }

    if (url.pathname === "/" || url.pathname === "") {
      const html = await renderDashboard(env.DB, url.searchParams);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/summary") return api.handleSummary(env.DB);
    if (url.pathname === "/api/launches") return api.handleLaunches(env.DB, url);
    if (url.pathname === "/api/creators") return api.handleCreators(env.DB);
    if (url.pathname === "/api/own-project") return api.handleOwnProject(env.DB);
    if (url.pathname === "/api/health") return api.handleHealth(env.DB, env);

    const launchMatch = url.pathname.match(/^\/api\/launch\/(0x[a-fA-F0-9]{40})$/);
    if (launchMatch) return api.handleLaunchDetail(env.DB, launchMatch[1]);

    return notFound();
  },

  // Deliberately NOT wired to sync.js anymore — see the file-header note
  // above. wrangler.jsonc's `triggers.crons` is permanently `[]`, so
  // Cloudflare never invokes this handler in production; it's kept only so
  // a stray/legacy cron registration (if one ever existed) would land on
  // an inert no-op rather than a silent 500.
  async scheduled() {},
};
