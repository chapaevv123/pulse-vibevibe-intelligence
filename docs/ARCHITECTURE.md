# Architecture

**Current design (2026-09-14 onward) — two small Cloudflare Workers plus
GitHub Actions, not one Worker doing everything:**

```
Cloudflare Cron Trigger (dispatch_scheduler, cron "7,22,37,52 * * * *", UTC)
        |
        v
Cloudflare Worker: pulse-vibevibe-dispatch-scheduler
  (dispatch_scheduler/src/index.js — separate package/deploy from the
  dashboard Worker below)
  - scheduled(): sends exactly ONE authenticated POST to GitHub's
    workflow_dispatch REST API, then exits. At most one bounded retry,
    only for a network error or 5xx — never for 4xx.
  - fetch(): always 404. No public HTTP surface, no D1 binding, no
    import of sync.js/scoring.js/db.js/vibeSource.js/d1RestClient.js —
    it does NOT run sync or touch data, period.
        |
        v  POST /repos/chapaevv123/pulse-vibevibe-intelligence/actions/workflows/sync.yml/dispatches
GitHub Actions: .github/workflows/sync.yml (workflow_dispatch only —
see "Why not GitHub's native schedule?" below)
  - runs scripts/sync-cron.mjs -> src/sync.js, the SAME shared
    sync/scoring business logic the Worker used to run directly
  - writes to D1 via the D1 REST API (src/d1RestClient.js), using a
    narrowly-scoped Cloudflare API token stored as a GitHub Actions
    secret (CF_D1_API_TOKEN) — never in this repo
  - GitHub Actions' own concurrency group (pulse-vibevibe-sync) AND the
    D1 renewable lease (src/lock.js) both guard against overlapping
    writers, independent of what triggered the run
        |
        v
Cloudflare D1 (binding: env.DB on the dashboard Worker; D1 REST API from
GitHub Actions)
  - launches, market_snapshots, creators, scores,
    holder_enrichment, activity_enrichment, sync_runs, sync_state
        |
        v
Cloudflare Worker: pulse-vibevibe-intelligence (src/index.js)
  - fetch() ONLY — GET-only dashboard + read-only JSON API.
  - scheduled() is inert (kept only so a stray cron registration lands
    on a no-op); wrangler.jsonc's triggers.crons stays permanently [].
    This Worker never writes to D1.
        |
        v
Public read-only dashboard (server-rendered HTML) + JSON API
        |
        v
https://pulse-vibevibe-intelligence.sergtsopa.workers.dev
```

## Why not GitHub's native schedule?

Two earlier designs were tried and abandoned, in order:

1. **Cloudflare Cron Trigger running sync.js directly.** Workers Free's
   10ms CPU/invocation budget (Cloudflare's published, platform-enforced
   limit, same on Cron Triggers as HTTP requests) cannot fit the sync's
   real CPU cost — every scheduled run since enabling it ended stuck as
   `RUNNING` with no terminal status ever written, meaning the isolate
   was killed at the platform level before any in-process timeout
   protection could run. `wrangler.jsonc`'s `triggers.crons` stays `[]`
   permanently as a result.
2. **GitHub Actions' own `schedule:` trigger** (public repos get
   unlimited free Actions minutes, and a GitHub-hosted runner has no
   comparable CPU ceiling). This worked for CPU, but PULSE × VIBE/VIBE
   GITHUB SCHEDULER CANARY V1 (2026-09-14) confirmed
   `GITHUB_SCHEDULE_DELIVERY_FAILED` for this specific repository: three
   different cron patterns — `sync.yml`'s own `*/15` and a shifted
   `7,22,37,52`, plus an isolated canary workflow with no Pulse
   involvement at all, same shifted cadence — each missed every expected
   boundary, with zero scheduled runs ever created, despite workflow
   config independently verified correct every time (state `active`,
   Actions enabled, correct file on `main`) and a clean D1
   lock/`sync_runs` throughout (i.e. nothing was silently running or
   stuck — GitHub simply never delivered the event).

The current design routes cadence through Cloudflare's Cron Trigger
instead (which reliably fires — it drove the very first design above),
but keeps the triggered Worker's job reduced to almost nothing (one
outbound POST, no D1, no loops), comfortably inside Workers Free's 10ms
CPU budget. GitHub Actions still does 100% of the actual sync work.

## Isolation from the private Pulse repository

This package is self-contained under `public_vibe_demo/`. It does not
import, `require`, `fetch`, or otherwise reference:

- `data/pulse.db` (the private production database)
- any `pulse_fast_money_*`, `pulse_slow_money_*`, `pulse_public_telegram_*`,
  or `pulse_x_*` module
- the owner's `.env` file or any environment-variable secret
- Windows Task Scheduler / the local scheduler
- any wallet, private key, or transaction-signing code path

Everything this Worker needs is either a public HTTP API (vibe/vibe) or a
public blockchain address baked into `src/config.js` as a plain constant.
See `test/no-secret-leakage.test.js` for the automated checks that enforce
this boundary.

## Module map

`public_vibe_demo/` (dashboard Worker + shared sync/scoring logic + the
GitHub Actions entrypoint that now runs it):

| File | Responsibility |
|---|---|
| `src/config.js` | Public constants only: vibe/vibe base URL, chain id, $PULSE token/creator address. |
| `src/vibeSource.js` | Read-only fetch client for the vibe/vibe API (throttled, bounded retries). |
| `src/scoring.js` | Pure functions: status classification, Pulse Score, risk flags, holder concentration, activity metrics. No I/O — fully unit-testable. |
| `src/db.js` | D1 read/write helpers + row normalization. Every write is idempotent; hot paths (creator aggregation, launch/snapshot upserts, score writes) use batched `db.batch()` calls. |
| `src/d1RestClient.js` | D1-binding-shaped client backed by Cloudflare's D1 REST API (incl. `batch()`) — lets GitHub Actions run the exact same `sync.js`/`db.js` code the Worker's real D1 binding would. |
| `src/sync.js` | Orchestrates one sync run: fetch → normalize → write → score → bounded enrichment. Shared unchanged between the (now-inert) Worker path and the GitHub Actions path. |
| `src/lock.js` | Renewable-lease single-writer guard in D1 (`sync_lock`) — authoritative regardless of what triggered the run. |
| `src/timeouts.js` | Hard, bounded timeouts for every potentially-blocking D1/upstream operation. |
| `src/api.js` | Read-only JSON route handlers (`/api/*`). |
| `src/dashboardHtml.js` | Server-rendered HTML for `/`. |
| `src/index.js` | Dashboard Worker entry point: routes `fetch()` only. `scheduled()` is inert. Rejects any non-GET/HEAD method before touching D1. |
| `scripts/sync-cron.mjs` | GitHub Actions entrypoint — reads `CF_ACCOUNT_ID`/`CF_D1_DATABASE_ID`/`CF_D1_API_TOKEN` from the environment (CI secrets), builds a `d1RestClient`, calls the same `sync.js`. |
| `.github/workflows/sync.yml` | `workflow_dispatch`-only (no native `schedule:` — see above). Runs `scripts/sync-cron.mjs`. |

`dispatch_scheduler/` (separate package, separate Worker, separate
deploy — see "Why not GitHub's native schedule?" above):

| File | Responsibility |
|---|---|
| `dispatch_scheduler/src/index.js` | The ENTIRE Worker. `scheduled()`: one authenticated POST to GitHub's `workflow_dispatch` REST API, bounded retry, structured secret-free logging. `fetch()`: always 404 — no public dispatch trigger exists. No D1 binding, no import of any Pulse sync/business-logic module. |
| `dispatch_scheduler/wrangler.jsonc` | `triggers.crons: ["7,22,37,52 * * * *"]`. No `d1_databases`, no plaintext secrets — `GITHUB_DISPATCH_TOKEN` is a Worker secret (`wrangler secret put`). |

## Why no client-side JS framework

The dashboard is server-rendered HTML with a plain `<form method="get">` for
filters (same pattern as the local Pulse MVP's dashboard). This keeps the
Worker's bundle small, avoids a build step, and means the page works even
with JS disabled — appropriate for a lightweight Free-tier demo.

## Write path

The **only** place anything ever writes to D1 is `sync.js`, now invoked
exclusively from GitHub Actions (`scripts/sync-cron.mjs`) via the D1 REST
API — never from the dashboard Worker, and never from the dispatch
scheduler Worker (which has no D1 binding at all and never imports
`sync.js`). There is no POST/PUT/PATCH/DELETE handler anywhere in
`src/index.js`; every non-GET/HEAD request is rejected with 405 before
`env.DB` is ever touched (see `test/api-routes.test.js`).
