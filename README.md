# Pulse Intelligence × vibe/vibe

Live, read-only launch intelligence for **vibe/vibe** (Seedify Launchpad) on
**Robinhood Chain Testnet** — a public Cloudflare Worker + D1 demo built for
the vibe/vibe Builder Season.

**Demo URL:** `<TODO — filled in after deploy, see docs/DEPLOYMENT.md>`

---

## What this is

Pulse Intelligence watches every launch on vibe/vibe's public bonding-curve
API and computes, from public data only:

- a deterministic **status** (`NEW` / `EARLY` / `HEATING` / `CROWDED` /
  `UNKNOWN`)
- an explainable **Pulse Score** (0-100, bucketed, no ML)
- evidence-only **risk flags** (never a scam/buy/sell verdict)
- bounded **holder concentration** and **trade activity** enrichment for the
  most interesting launches

It also tracks its own project, **$PULSE** (`PULSE`), the same way it
tracks every other launch — no special-cased data, just the same public
pipeline pointed at a public address.

This is a **separate, public-safe rebuild** of a private local research tool
(Pulse). It ships zero private credentials, zero private infrastructure, and
zero connection to any production trading system. See **Safety &
disclaimers** below.

## vibe/vibe Builder Season context

vibe/vibe is Seedify Launchpad's bonding-curve launch product, deployed on
**Robinhood Chain Testnet** (`chainId 46630` — distinct from Robinhood
mainnet). The Builder Season invites developers to build on top of its
public JSON API. This project is one such build: a public, always-on
intelligence layer over the live launch feed.

## Feature list

- Live sync of the vibe/vibe launch feed, builder leaderboards, and
  per-token bonding-curve/market data
- Deterministic status classification and an explainable Pulse Score
  (component breakdown included in every API response)
- Evidence-only risk flags (metadata gaps, extreme buy/sell imbalance,
  high-launch-count creators, low-confidence data)
- Bounded holder-concentration and trade-activity enrichment for top-scoring
  and hot (NEW/EARLY/HEATING) launches
- A dedicated **PULSE INTELLIGENCE / $PULSE** panel tracking Pulse's own
  token exactly like any other launch
- A public, filterable dashboard and a read-only JSON API
- Runs entirely on Cloudflare's Free tier (Workers + D1 + Cron Triggers)

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full module map.
Short version:

```
vibe/vibe public API → Cloudflare Worker (cron sync) → D1 → dashboard + API
```

The only write path is the scheduled sync job — there is no public
POST/PUT/PATCH/DELETE route anywhere in this Worker.

## Public data sources (and only these)

- vibe/vibe public JSON API: `https://testnet.vibevibe.fun/api/v1/chains/46630/*`
  (no API key required)
- Public Robinhood Chain Testnet on-chain data, as surfaced by that API
- Public vibe/vibe builder leaderboard (`/builders`, `/season/builders`)
- Two public blockchain addresses (see below)

No Telegram, no X/Twitter API, no private keys, no local paths, no
production Pulse configuration, and no private database are part of this
package.

## Scoring

Fully documented in [`docs/SCORING.md`](docs/SCORING.md): status rules,
Pulse Score component breakdown (true ceiling is **97**, not 100 — documented,
not hidden), risk flags, and holder-concentration thresholds. Ported
faithfully from the local Pulse MVP — thresholds are not silently redesigned
for this public release.

## Own project — $PULSE

| | |
|---|---|
| Name | Pulse Intelligence |
| Ticker | `PULSE` |
| Token address | `0x983762a5487D36DCF371ef7e3949e1D7D9E7454b` |
| Creator address | `0x765fb7e6a0BdDDc29f57eeCE34AEda0Fb318805d` |
| Network | Robinhood Chain Testnet (chainId 46630) |

Both addresses are public on-chain identifiers — safe to publish, and the
only project-specific values hardcoded anywhere in this repository.

## Running locally

```
npm install
npx wrangler d1 create pulse-vibe-demo        # first time only
# copy the printed database_id into wrangler.jsonc
npx wrangler d1 migrations apply pulse-vibe-demo --local
npx wrangler dev
```

Then open the printed `http://localhost:8787`. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full command sequence,
including how to trigger a sync manually in dev.

## Deploying to Cloudflare

Exact commands (Worker deploy, D1 creation/migration, and enabling the cron
trigger) are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Recommended
sync cadence and the Free-tier usage math behind it are in
[`docs/FREE_TIER_AUDIT.md`](docs/FREE_TIER_AUDIT.md) — **10 minutes**.

## Tests

```
npm test
```

Runs `node --test` over `test/` — score/status parity, risk-flag behavior,
holder-concentration edge cases, own-project recognition, D1 schema shape,
read-only route enforcement, and a static no-secret-leakage scan. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for how these are structured.

## Safety & disclaimers

- **Testnet only.** Robinhood Chain Testnet, vibe/vibe testnet API. No
  mainnet interaction of any kind.
- **Read-only, always.** This Worker never connects a wallet, never
  requests or holds a private key, never signs or broadcasts a transaction,
  never approves/buys/sells/mints/claims anything. It only issues `GET`
  requests to a public JSON API and reads/writes its own isolated D1
  database.
- **Not trading advice.** Pulse Score and status are research/demo
  intelligence signals, not a recommendation to trade.
- **No secrets required.** Every value this Worker needs is a public
  constant. Deployment credentials (Cloudflare login) are supplied via
  `wrangler login` outside this repository and are never committed.

## License

MIT — see [`LICENSE`](LICENSE).

---

Built by **@MagnatSV** for the vibe/vibe Builder Season.
