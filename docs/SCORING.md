# Scoring — Pulse Score, status, and risk flags

This demo ports the scoring logic of the local Pulse MVP
(`pulse_vibe_robinhood_intelligence_v1.py`, `THRESHOLDS_VERSION =
"VIBE_MVP_THRESHOLDS_V1"`) **faithfully** — the same thresholds, the same
bucket values, no silent redesign. If the local MVP's thresholds ever change,
`src/scoring.js` must be re-synced deliberately.

All scoring is deterministic and bucketed. **There is no ML anywhere in this
pipeline.**

## OFFICIAL vs PULSE-derived data

Every field surfaced by this demo is one of exactly two kinds:

- **OFFICIAL** — read directly from a vibe/vibe public API response
  (`/builders`, `/season/builders` leaderboard rank, launch count, pace).
- **PULSE-derived** — computed locally by this Worker from what it has
  itself observed (status, Pulse Score, risk flags, holder concentration
  shares, activity deltas, tracked launch counts).

The dashboard and API responses keep these visually/structurally separate —
an OFFICIAL rank is never presented as if Pulse computed it, and a
PULSE-derived count is never presented as an official leaderboard position.

## Status classification (`classifyStatus`)

No live market data → **UNKNOWN** (`NO_MARKET_DATA`).
No parseable `created_at` → **UNKNOWN** (`AGE_UNKNOWN`).

Otherwise, in this exact priority order:

1. `age_minutes < 15` → **NEW**
2. `holder_count >= 50` OR `progress_bps >= 5000` (50%) → **CROWDED**
3. `buy_count_1h >= 5` AND `buy_count_1h >= 2 × sell_count_1h` → **HEATING**
4. `age_minutes < 180` AND (`buy_count_1h >= 1` OR `holder_count >= 2`) → **EARLY**
5. otherwise → **UNKNOWN**

Note: because a fresh bonding-curve launch usually has near-zero sells, the
HEATING buy/sell ratio is easy to satisfy once there is any meaningful
buying — HEATING is common by construction here, not a bug.

## Pulse Score (`computeScore`) — 0-100, true reachable ceiling **97**

Five components, summed and clamped to `[0, 100]`:

| Component  | Declared max | Actual reachable max | Rule |
|---|---|---|---|
| `earlyness`   | 25 | 25 | age<15→25, <60→18, <180→10, <1440→4, else 0. Capped at 5 if `progress_bps >= 5000`. |
| `momentum`    | 25 | 25 | buy1h≥10 & ratio≥3→25; buy1h≥5 & ratio≥2→18; buy1h≥1 & ratio≥1→10; else 0. +3 (capped 25) if `abs(price_change_1h_bps) >= 500`. |
| `activity`    | 20 | 20 | holders≥20 or trades≥15→20; holders≥8 or trades≥6→12; holders≥2 or trades≥1→6; else 0. |
| `creator`     | 15 (declared) | **12** | unknown creator→7 (neutral); 0 launches→7; 1-3→10; 4-10→12; >10→8. |
| `confidence`  | 15 | 15 | starts at 15; -8 if `source != "LIVE"`; -6 if no AVAILABLE market data; floored at 0. |

**Sum of maxima = 25+25+20+12+15 = 97, not 100** — the creator branch never
awards its originally-declared 15, matching the local MVP's own
`QUALITY PASS V1.1` metadata correction. This is documented, not hidden: a
score of 97 is the ceiling a viewer should expect to ever see.

## Risk flags (`riskFlags`) — evidence only, never a verdict

`VERY_NEW`, `NO_MARKET_DATA`, `NO_ACTIVITY`, `EXTREME_BUY_SELL_IMBALANCE`,
`MISSING_METADATA`, `HIGH_CREATOR_LAUNCH_COUNT` (≥10 tracked/official
launches), `LOW_DATA_CONFIDENCE` (non-LIVE source).

None of these flags is or implies "SCAM" — they are raw evidence for a
human to weigh, exactly as in the local MVP.

## Holder concentration (`computeHolderConcentration`)

A holder is excluded from "non-protocol" share totals **only** when the
vibe/vibe `/holders` API explicitly returns `excludedAsProtocol: true`.
A missing/`null` flag is treated as **not excluded** — ambiguous data is
never silently dropped. Flags: `HIGH_TOP1_CONCENTRATION` (≥20%),
`HIGH_TOP3_CONCENTRATION` (≥40%), `HIGH_TOP5_CONCENTRATION` (≥50%),
`NO_NONPROTOCOL_HOLDERS_RETURNED`.

## Bounded enrichment

Holder + activity detail (2 extra API calls per token) is pulled only for a
bounded candidate set: the top 20 tokens by current Pulse Score, unioned
with any NEW/EARLY/HEATING token scoring ≥75, capped at 20 total per sync.
This mirrors `VIBE_ENRICHMENT_CAP_V1` / `VIBE_ENRICHMENT_MIN_SCORE_V1` in the
local MVP exactly.
