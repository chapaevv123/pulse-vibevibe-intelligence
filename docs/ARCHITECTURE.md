# Architecture

```
vibe/vibe public JSON API (testnet.vibevibe.fun)
        |  GET only, no key, paced ~1.1s/call
        v
Cloudflare Worker (src/index.js)
  - scheduled(): calls sync.js directly (cron trigger, NOT a public route)
  - fetch(): GET-only dashboard + read-only JSON API
        |
        v
Cloudflare D1 (binding: env.DB)
  - launches, market_snapshots, creators, scores,
    holder_enrichment, activity_enrichment, sync_runs
        |
        v
Public read-only dashboard (server-rendered HTML) + JSON API
        |
        v
https://pulse-vibevibe-intelligence.<subdomain>.workers.dev
```

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

| File | Responsibility |
|---|---|
| `src/config.js` | Public constants only: vibe/vibe base URL, chain id, $PULSE token/creator address. |
| `src/vibeSource.js` | Read-only fetch client for the vibe/vibe API (throttled, bounded retries). |
| `src/scoring.js` | Pure functions: status classification, Pulse Score, risk flags, holder concentration, activity metrics. No I/O — fully unit-testable. |
| `src/db.js` | D1 read/write helpers + row normalization. Every write is idempotent. |
| `src/sync.js` | Orchestrates one sync run: fetch → normalize → write → score → bounded enrichment. Called only from `scheduled()`. |
| `src/api.js` | Read-only JSON route handlers (`/api/*`). |
| `src/dashboardHtml.js` | Server-rendered HTML for `/`. |
| `src/index.js` | Worker entry point: routes `fetch()`, wires `scheduled()` to `sync.js`. Rejects any non-GET/HEAD method before touching D1. |

## Why no client-side JS framework

The dashboard is server-rendered HTML with a plain `<form method="get">` for
filters (same pattern as the local Pulse MVP's dashboard). This keeps the
Worker's bundle small, avoids a build step, and means the page works even
with JS disabled — appropriate for a lightweight Free-tier demo.

## Write path

The **only** place this Worker ever writes to D1 is `sync.js`, invoked from
`scheduled(event, env, ctx)` — a Cloudflare Cron Trigger, not an HTTP route.
There is no POST/PUT/PATCH/DELETE handler anywhere in `src/index.js`; every
non-GET/HEAD request is rejected with 405 before `env.DB` is ever touched
(see `test/api-routes.test.js`).
