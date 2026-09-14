# Free-tier usage audit (cron not yet enabled)

`wrangler.jsonc` ships with `triggers.crons: []` — **no cron is deployed by
this package**. This audit estimates load at three candidate cadences so the
owner can pick one deliberately before it's turned on.

## Per-sync-run cost (worst case, enrichment cap fully saturated)

| Call type | Count | Notes |
|---|---|---|
| `GET /launches` (paginated) | 1-3 | stops early once `hasMore=false`; worst case 3 (`SYNC_MAX_PAGES`) |
| `GET /builders`, `GET /season/builders` | 2 | leaderboard refresh, every sync |
| `GET /launches/:addr/holders` + `/activity` | up to 40 | 2 calls × up to 20 enriched tokens (`ENRICHMENT_CAP`) |
| **Total vibe/vibe upstream calls** | **≈45 worst case** | client paces itself at ≥1.1s between calls (matches the local MVP's `MIN_SECONDS_BETWEEN_CALLS`, staying under vibe/vibe's observed `x-ratelimit-limit: 60` per short window) — a full worst-case sync takes ~50s wall-clock |

D1 operations per sync (worst case, ~20 touched tokens):
- **Writes**: ~20 launch upserts + ~20 snapshot inserts + ~20 score inserts + ~5 creator upserts + ~40 enrichment inserts ≈ **105 rows written**
- **Reads**: ~5 SELECTs per touched token (snapshot/creator/score lookups) + aggregate queries ≈ **~120 rows read**

In practice, most syncs after the initial backfill touch far fewer than 20
tokens (Builder Season launch volume permitting) and most `market_snapshots`
writes hit the `UNIQUE(token_address, as_of_block)` constraint as a no-op
(`INSERT OR IGNORE`) rather than a real new row — the numbers above are a
deliberately conservative upper bound, not a typical-case estimate.

## Projected daily/monthly load by cadence

| Cadence | Worker (cron) invocations/day | vibe/vibe upstream requests/day (worst case) | D1 writes/day (worst case) | D1 reads/day (worst case) | D1 storage growth/month (worst case, ≈300 bytes/appended row × ~80 append-only rows/sync — `launches`/`creators` are upserts, not appends) |
|---|---|---|---|---|---|
| 5 min  | 288 | ~12,960 | ~30,240 | ~34,560 | ~200 MB |
| 10 min | 144 | ~6,480  | ~15,120 | ~17,280 | ~100 MB |
| 15 min | 96  | ~4,320  | ~10,080 | ~11,520 | ~65 MB |

(Dashboard/API GET traffic from visitors is separate and, for a Builder
Season demo, expected to be far smaller than the cron load above — each page
view issues its own D1 reads via the Worker, not extra vibe/vibe calls.)

## Headroom against Cloudflare's published Free-tier limits

*(Confirm exact current figures on Cloudflare's pricing page before enabling
cron — these limits have changed before and this audit is not a substitute
for reading them at deploy time.)*

- **D1 writes**: Free tier is on the order of 100k rows written/day. Even the
  5-minute worst case (~30k/day) leaves comfortable headroom (~70% free).
- **D1 reads**: Free tier is on the order of millions of rows read/day — all
  three cadences are trivially within budget.
- **D1 storage**: Free tier is multi-GB (on the order of 5 GB). At the
  recommended 10-minute cadence (~100 MB/month worst case), storage stays
  comfortably bounded for well over a year; at 5-minute worst case
  (~200 MB/month) a year of unpruned growth (~2.4 GB) starts to matter.
  **Not implemented in this package**: no row-pruning/retention job. If this
  demo runs for many months, add one (e.g. drop `market_snapshots` older
  than N days) before storage becomes a concern — flagged here, not silently
  deferred.
- **Worker subrequests per invocation**: the Free plan bounds subrequests per
  invocation; a worst-case sync issuing ~45 external `fetch()` calls is close
  enough to matter if the enrichment cap or page count is ever raised —
  **do not raise `ENRICHMENT_CAP` or `SYNC_MAX_PAGES` without re-checking
  this budget.**
- **vibe/vibe's own rate limit**: observed `x-ratelimit-limit: 60` on a short
  rolling window is the real constraint, not Cloudflare's quota. The 1.1s
  inter-call throttle keeps a worst-case ~45-call sync under that window
  regardless of cadence; a 5-minute cadence with heavy enrichment is the
  tightest fit (a ~50s sync running every 5 minutes has no overlap risk, but
  leaves the least slack if vibe/vibe's own limit tightens).

## Recommendation

**10-minute cadence.** It is comfortably inside every Cloudflare free-tier
quota at the worst case, keeps meaningful distance from vibe/vibe's own
observed rate limit, and is more than fresh enough for a Builder Season demo
(no one needs 5-minute-fresh testnet bonding-curve data). 15 minutes is the
safer fallback if vibe/vibe's upstream ever shows signs of throttling under
real traffic; 5 minutes is technically survivable on Cloudflare's side but is
not recommended as a starting point.

Cron is **not enabled** in this package (`triggers.crons: []`). Enabling it
is an explicit, separate, owner-approved step — see `docs/DEPLOYMENT.md`.
