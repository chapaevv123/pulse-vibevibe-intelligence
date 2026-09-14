/**
 * PUBLIC DASHBOARD (server-rendered HTML, public demo)
 * ========================================================
 * Visual direction ported from the local Pulse MVP's read-only dashboard
 * (pulse_vibe_dashboard_v1.py): dark, clean, technical, readable. No client
 * JS is required to see data — filters are a plain GET form, same pattern
 * as the local MVP.
 */
import * as db from "./db.js";
import { STATUSES } from "./scoring.js";
import { PULSE_TOKEN_ADDRESS, PULSE_CREATOR_ADDRESS, PULSE_PROJECT_NAME, PULSE_PROJECT_TICKER, VIBE_CHAIN_ID } from "./config.js";

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ageStr(createdAt) {
  if (!createdAt) return "UNKNOWN";
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "UNKNOWN";
  const mins = (Date.now() - t) / 60000;
  if (mins < 60) return `${mins.toFixed(0)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

function weiToEth(v) {
  if (v === null || v === undefined) return null;
  try {
    const eth = Number(BigInt(v)) / 1e18;
    return eth.toFixed(15).replace(/0+$/, "").replace(/\.$/, "") || "0";
  } catch {
    return null;
  }
}

const PAGE_CSS = `
<style>
  :root{color-scheme:dark;}
  body{background:#0b0e11;color:#d7dce1;font-family:Consolas,'JetBrains Mono',monospace;margin:0;padding:0 16px 32px;}
  h1{font-size:20px;letter-spacing:.04em;color:#f2f5f7;margin:20px 0 4px;}
  h1 small{display:block;font-size:12px;color:#7c8894;font-weight:normal;margin-top:2px;}
  h2{font-size:14px;color:#9fb0bd;margin:0 0 8px;text-transform:uppercase;letter-spacing:.05em;}
  .summary{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0;}
  .tile{background:#12161b;border:1px solid #1f262d;border-radius:6px;padding:10px 14px;min-width:96px;}
  .tile b{display:block;font-size:20px;color:#f2f5f7;}
  .tile span{font-size:11px;color:#7c8894;text-transform:uppercase;}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px;}
  th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #1c2126;white-space:nowrap;}
  th{color:#7c8894;text-transform:uppercase;font-size:10px;letter-spacing:.05em;position:sticky;top:0;background:#0b0e11;}
  tr:hover{background:#12161b;}
  .status{padding:2px 6px;border-radius:4px;font-size:10px;font-weight:bold;}
  .NEW{background:#0f3d2e;color:#4ee9a5;} .EARLY{background:#12324d;color:#5fb6ff;}
  .HEATING{background:#4d2e0f;color:#ffb347;} .CROWDED{background:#3d0f2b;color:#ff7ab8;}
  .UNKNOWN{background:#22262b;color:#8b95a0;}
  .flag{display:inline-block;background:#22262b;color:#c7ccd1;border-radius:3px;padding:1px 5px;font-size:9px;margin:1px;}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;}
  .badge.live{background:#0f3d2e;color:#4ee9a5;} .badge.waiting{background:#22262b;color:#8b95a0;}
  form.filters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;}
  form.filters input,form.filters select{background:#12161b;border:1px solid #1f262d;color:#d7dce1;
    padding:5px 8px;border-radius:4px;font-size:12px;}
  form.filters button{background:#1c2126;border:1px solid #2a323a;color:#d7dce1;padding:5px 12px;
    border-radius:4px;cursor:pointer;}
  a{color:#5fb6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#7c8894;font-size:12px;} .panel{background:#12161b;border:1px solid #1f262d;
    border-radius:6px;padding:12px 16px;margin:14px 0;}
  .own{border-color:#5fb6ff;}
  .enriched{background:#0f2d3d;color:#5fd0ff;border-radius:3px;padding:1px 5px;font-size:9px;margin-left:4px;}
  .official{color:#ffd76a;} .pulse-derived{color:#8b95a0;}
  .footer{margin-top:28px;color:#5f6971;font-size:11px;}
  details.legend{background:#12161b;border:1px solid #1f262d;border-radius:6px;padding:8px 14px;margin:10px 0;font-size:12px;}
  details.legend summary{cursor:pointer;color:#9fb0bd;text-transform:uppercase;font-size:11px;letter-spacing:.05em;}
  details.legend dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:8px 0 0;}
  details.legend dt{color:#d7dce1;font-weight:bold;} details.legend dd{margin:0;color:#9fb0bd;}
  @media (max-width:640px){ table{display:block;overflow-x:auto;} }
</style>`;

const LEGEND_HTML = `
<details class="legend">
  <summary>Legend — statuses, score, OFFICIAL vs PULSE-derived data</summary>
  <dl>
    <dt>NEW</dt><dd>launch age &lt; 15 minutes.</dd>
    <dt>EARLY</dt><dd>age &lt; 180 minutes with some observed signal (&gt;=1 buy/hour OR &gt;=2 holders).</dd>
    <dt>HEATING</dt><dd>&gt;=5 buys/hour AND buys &gt;= 2x sells/hour.</dd>
    <dt>CROWDED</dt><dd>&gt;=50 holders OR &gt;=50% bonding-curve progress.</dd>
    <dt>UNKNOWN</dt><dd>no live market data yet, or no rule matched.</dd>
    <dt>Pulse Score</dt><dd>0-100 (true reachable ceiling 97): earlyness(25) + momentum(25) + activity(20) + creator(0-12) + confidence(15). Deterministic buckets, never ML.</dd>
    <dt class="official">OFFICIAL</dt><dd>sourced directly from vibe/vibe's /builders and /season/builders leaderboard.</dd>
    <dt class="pulse-derived">PULSE</dt><dd>derived locally by this demo from what it has itself observed.</dd>
    <dt>ENRICHED</dt><dd>bounded holder/activity detail (top 20 by score, or score&gt;=75 NEW/EARLY/HEATING).</dd>
  </dl>
</details>`;

async function ownProjectSection(D1) {
  const launch = await D1.prepare("SELECT * FROM launches WHERE token_address=?").bind(PULSE_TOKEN_ADDRESS).first();
  if (!launch) {
    return `<div class="panel own"><h2>PULSE INTELLIGENCE / $PULSE — OWN PROJECT</h2>
      <p class="badge waiting">NOT_YET_LAUNCHED</p>
      <p class="muted">Token <code>${esc(PULSE_TOKEN_ADDRESS)}</code> / creator <code>${esc(PULSE_CREATOR_ADDRESS)}</code> — no matching launch observed on vibe/vibe yet. No fabricated data is shown.</p></div>`;
  }
  const score = await db.latestScore(D1, PULSE_TOKEN_ADDRESS);
  const snap = await db.latestSnapshot(D1, PULSE_TOKEN_ADDRESS);
  const holders = await db.latestHolderEnrichment(D1, PULSE_TOKEN_ADDRESS);
  const activity = await db.latestActivityEnrichment(D1, PULSE_TOKEN_ADDRESS);
  const priceEth = snap ? weiToEth(snap.last_price_wei_per_token) : null;
  const prices = await db.allPriceHistory(D1, PULSE_TOKEN_ADDRESS);
  const athEth = prices.length ? weiToEth((prices.reduce((a, b) => (a > b ? a : b))).toString()) : null;

  return `<div class="panel own"><h2>PULSE INTELLIGENCE / $PULSE — OWN PROJECT</h2>
    <p class="badge live">LAUNCHED</p>
    <p><b>${esc(launch.name || PULSE_PROJECT_NAME)}</b> (${esc(launch.symbol || PULSE_PROJECT_TICKER)})</p>
    <p>Token: <code>${esc(PULSE_TOKEN_ADDRESS)}</code><br>Creator: <code>${esc(PULSE_CREATOR_ADDRESS)}</code></p>
    <p>Age: ${ageStr(launch.created_at)} | Price: ${esc(priceEth ?? "UNKNOWN")} ETH | Pulse-observed ATH: ${esc(athEth ?? "UNKNOWN")} ETH</p>
    <p>Curve: ${esc(snap?.lifecycle ?? "UNKNOWN")}${snap?.progress_bps !== null && snap?.progress_bps !== undefined ? ` (${(snap.progress_bps / 100).toFixed(1)}%)` : ""}
       | Activity 1h: B:${snap?.buy_count_1h ?? "?"} S:${snap?.sell_count_1h ?? "?"} | Holders: ${snap?.holder_count ?? "?"}</p>
    ${holders ? `<p>Holder concentration — Top1: ${(holders.top_nonprotocol_share_bps / 100).toFixed(1)}% Top3: ${(holders.top3_nonprotocol_share_bps / 100).toFixed(1)}%</p>` : ""}
    ${activity ? `<p>Activity enrichment — Buys: ${activity.buy_count} Sells: ${activity.sell_count} Unique buyers: ${activity.unique_buyers}</p>` : ""}
    <p>Pulse Score: <b>${score ? score.score : "UNKNOWN"}</b> | Status: <span class="status ${score ? score.status : "UNKNOWN"}">${score ? score.status : "UNKNOWN"}</span></p>
    <p><a href="${esc(launch.project_url || "#")}" target="_blank" rel="noopener">Project page on vibe/vibe →</a></p></div>`;
}

export async function renderDashboard(D1, searchParams) {
  const statusFilter = (searchParams.get("status") || "").toUpperCase();
  const q = (searchParams.get("q") || "").toLowerCase();
  const creatorQ = (searchParams.get("creator") || "").toLowerCase();
  const minScore = searchParams.get("min_score");
  const maxAgeMinutes = searchParams.get("max_age_minutes");

  const { results: launches } = await D1.prepare("SELECT * FROM launches ORDER BY created_at DESC LIMIT 500").all();
  const tokenAddresses = launches.map((l) => l.token_address);
  const creatorAddresses = launches.map((l) => l.creator_address);
  // Batched, not per-row: a page with hundreds of launches must not issue
  // hundreds x5 separate D1 round-trips — that blows Cloudflare's
  // per-invocation subrequest ceiling (see db.js latestPerTokenBatch).
  const [snapshots, scoresMap, creators, holdersMap, activityMap] = await Promise.all([
    db.latestSnapshotsFor(D1, tokenAddresses),
    db.latestScoresFor(D1, tokenAddresses),
    db.creatorsFor(D1, creatorAddresses),
    db.latestHolderEnrichmentsFor(D1, tokenAddresses),
    db.latestActivityEnrichmentsFor(D1, tokenAddresses),
  ]);

  const rows = [];
  for (const l of launches) {
    const snap = snapshots.get(l.token_address) || null;
    const score = scoresMap.get(l.token_address) || null;
    const creator = creators.get(l.creator_address) || null;
    const holders = holdersMap.get(l.token_address) || null;
    const activity = activityMap.get(l.token_address) || null;
    const t = l.created_at ? Date.parse(l.created_at) : NaN;
    const ageMinutes = Number.isNaN(t) ? null : (Date.now() - t) / 60000;
    rows.push({
      token_address: l.token_address,
      name: l.name || "UNKNOWN",
      symbol: l.symbol || "UNKNOWN",
      creator_address: l.creator_address || "UNKNOWN",
      created_at: l.created_at,
      age_minutes: ageMinutes,
      status: score ? score.status : "UNKNOWN",
      score: score ? score.score : null,
      flags: score?.flags_json ? JSON.parse(score.flags_json) : [],
      price_eth: snap ? weiToEth(snap.last_price_wei_per_token) : null,
      buy1h: snap?.buy_count_1h ?? null,
      sell1h: snap?.sell_count_1h ?? null,
      holder_count: snap?.holder_count ?? null,
      lifecycle: snap?.lifecycle || "UNKNOWN",
      progress_bps: snap?.progress_bps ?? null,
      project_url: l.project_url,
      is_own_project: !!l.is_own_project,
      official_rank_alltime: creator?.official_rank_alltime ?? null,
      launches_by_creator: creator ? creator.official_launch_count_alltime || creator.total_launches_tracked : null,
      holder_enriched: !!holders,
      top1_pct: holders ? holders.top_nonprotocol_share_bps / 100 : null,
      top3_pct: holders ? holders.top3_nonprotocol_share_bps / 100 : null,
      conc_flags: holders?.concentration_flags_json ? JSON.parse(holders.concentration_flags_json) : [],
      activity_enriched: !!activity,
      activity_buy: activity?.buy_count ?? null,
      activity_sell: activity?.sell_count ?? null,
      activity_unique_buyers: activity?.unique_buyers ?? null,
    });
  }

  let filtered = rows;
  if (statusFilter) filtered = filtered.filter((r) => r.status === statusFilter);
  if (q) filtered = filtered.filter((r) => r.name.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q));
  if (creatorQ) filtered = filtered.filter((r) => (r.creator_address || "").toLowerCase().includes(creatorQ));
  if (minScore) filtered = filtered.filter((r) => (r.score || 0) >= Number(minScore));
  if (maxAgeMinutes) filtered = filtered.filter((r) => r.age_minutes !== null && r.age_minutes <= Number(maxAgeMinutes));

  const counts = { NEW: 0, EARLY: 0, HEATING: 0, CROWDED: 0, UNKNOWN: 0 };
  const scores = [];
  const today = new Date().toISOString().slice(0, 10);
  let todayN = 0;
  let enrichedN = 0;
  for (const r of rows) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if ((r.created_at || "").slice(0, 10) === today) todayN++;
    if (r.holder_enriched || r.activity_enriched) enrichedN++;
    if (r.score !== null) scores.push(r.score);
  }
  scores.sort((a, b) => a - b);
  const scoreMean = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  const scoreMedian = scores.length ? scores[Math.floor(scores.length / 2)] : null;
  const lastSync = await D1.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1").first();

  const tiles = [
    ["Total launches", rows.length],
    ["Launches today", todayN],
    ...STATUSES.map((s) => [s, counts[s] || 0]),
    ["Score mean", scoreMean ?? "—"],
    ["Score median", scoreMedian ?? "—"],
    ["Last sync", lastSync?.finished_at || "NEVER"],
    ["Data source", "LIVE"],
  ]
    .map(([label, val]) => `<div class="tile"><b>${esc(val)}</b><span>${esc(label)}</span></div>`)
    .join("");

  function opt(name, val) {
    const sel = searchParams.get(name) === val ? "selected" : "";
    return `<option value="${esc(val)}" ${sel}>${esc(val) || "(any)"}</option>`;
  }

  const filters = `<form class="filters" method="get">
    <input type="text" name="q" placeholder="ticker / name" value="${esc(searchParams.get("q") || "")}">
    <input type="text" name="creator" placeholder="creator address" value="${esc(searchParams.get("creator") || "")}">
    <select name="status">${opt("status", "")}${STATUSES.map((s) => opt("status", s)).join("")}</select>
    <input type="number" name="min_score" placeholder="min score" value="${esc(searchParams.get("min_score") || "")}">
    <input type="number" name="max_age_minutes" placeholder="max age (min)" value="${esc(searchParams.get("max_age_minutes") || "")}">
    <button type="submit">Filter</button>
    <a href="/">Reset</a>
  </form>`;

  const trs = filtered
    .slice(0, 300)
    .map((r) => {
      const own = r.is_own_project ? " ⭐OWN" : "";
      const flagsHtml = r.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("");
      const enrichedBadge = r.holder_enriched || r.activity_enriched ? ' <span class="enriched">ENRICHED</span>' : "";
      const creatorRank = r.official_rank_alltime
        ? ` <span class="official">(#${r.official_rank_alltime} official)</span>`
        : r.launches_by_creator
        ? ` <span class="pulse-derived">(${r.launches_by_creator} tracked)</span>`
        : "";
      const holderCell = r.holder_enriched
        ? `Top1:${r.top1_pct?.toFixed(1)}% Top3:${r.top3_pct?.toFixed(1)}%<br>${r.conc_flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}`
        : "—";
      const activityCell = r.activity_enriched ? `B:${r.activity_buy} S:${r.activity_sell} U:${r.activity_unique_buyers}` : "—";
      return `<tr>
        <td>${esc(r.symbol)}${own}${enrichedBadge}<br><span class="muted">${esc(r.name)}</span></td>
        <td>${esc((r.creator_address || "").slice(0, 10))}…${creatorRank}</td>
        <td>${ageStr(r.created_at)}</td>
        <td><span class="status ${r.status}">${r.status}</span></td>
        <td>${esc(r.price_eth ?? "UNKNOWN")}</td>
        <td>B:${r.buy1h ?? "?"} S:${r.sell1h ?? "?"} H:${r.holder_count ?? "?"}</td>
        <td>${esc(r.lifecycle)}${r.progress_bps !== null ? ` (${(r.progress_bps / 100).toFixed(1)}%)` : ""}</td>
        <td>${r.score ?? "UNKNOWN"}</td>
        <td>${flagsHtml}</td>
        <td>${holderCell}</td>
        <td>${activityCell}</td>
        <td>${r.project_url ? `<a href="${esc(r.project_url)}" target="_blank" rel="noopener">open</a>` : "UNKNOWN"}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse × vibe/vibe — Launch Intelligence</title>${PAGE_CSS}</head><body>
<h1>PULSE × VIBE/VIBE<br>LAUNCH INTELLIGENCE<small>Live intelligence for vibe/vibe on Robinhood Chain Testnet (chainId ${VIBE_CHAIN_ID})</small></h1>
<div class="summary">${tiles}</div>
${LEGEND_HTML}
${await ownProjectSection(D1)}
<h2>Launch feed (${filtered.length} of ${rows.length})</h2>
${filters}
<table><thead><tr>
  <th>Ticker / Name</th><th>Creator</th><th>Age</th><th>Status</th><th>Price (ETH)</th>
  <th>Activity (1h)</th><th>Curve</th><th>Pulse Score</th><th>Flags</th>
  <th>Holders (enriched)</th><th>Activity (enriched)</th><th>Link</th>
</tr></thead><tbody>${trs}</tbody></table>
<div class="footer">Public read-only demo · testnet only · no wallet connection, no trading · data refreshed on a bounded cron cycle · built by @MagnatSV</div>
</body></html>`;
}
