/**
 * PULSE x VIBE/VIBE PUBLIC DEMO — CONFIG
 * =======================================
 * Every value here is PUBLIC: a public HTTP API base, a public chain id, and
 * two public blockchain addresses (token contract + creator wallet). Nothing
 * in this file is a secret and nothing here is read from an environment
 * variable that could carry a credential.
 *
 * This is a SEPARATE, isolated demo. It does not import, read, or write any
 * file from the private Pulse repository, and it has no path back to
 * data/pulse.db, Telegram, X/Twitter, or any wallet/private key.
 */

// vibe/vibe (Seedify Launchpad) public JSON API on Robinhood Chain TESTNET.
// Discovered and verified read-only in the local Pulse MVP
// (pulse_vibe_robinhood_sources_v1.py) on 2026-09-12.
export const VIBE_BASE_URL = "https://testnet.vibevibe.fun";
export const VIBE_API_PREFIX = "/api/v1/chains";
export const VIBE_CHAIN_ID = 46630; // Robinhood Chain TESTNET (NOT mainnet 4663 — never conflate)
export const VIBE_CHAIN_NAME = "Robinhood Chain Testnet";

export const NATIVE_QUOTE_ADDRESS = "0x0000000000000000000000000000000000000000";

// Constant observed from GET /api/v1/chains/46630/config on 2026-09-12
// (protocol.totalSupplyBaseUnits = 1e27 base units / 1e18 decimals = 1e9
// whole tokens). Used only to derive an approximate market cap for
// native-ETH-quoted launches; never applied to non-native-quoted launches.
export const PROTOCOL_TOTAL_SUPPLY_TOKENS = 1_000_000_000;

// --- PUBLIC $PULSE identifiers -----------------------------------------
// These are public on-chain addresses on Robinhood Chain Testnet — safe to
// publish. They are used only to flag the matching launch row as
// is_own_project=1 for the dashboard's highlighted "OWN PROJECT" section.
export const PULSE_TOKEN_ADDRESS = "0x983762a5487d36dcf371ef7e3949e1d7d9e7454b".toLowerCase();
export const PULSE_CREATOR_ADDRESS = "0x765fb7e6a0bdddc29f57eece34aeda0fb318805d".toLowerCase();
export const PULSE_PROJECT_NAME = "Pulse Intelligence";
export const PULSE_PROJECT_TICKER = "PULSE";

// --- Bounded enrichment / sync knobs (mirrors the local MVP's caps) ----
export const ENRICHMENT_CAP = 20;
export const ENRICHMENT_MIN_SCORE = 75;
export const SYNC_PAGE_LIMIT = 50;
export const SYNC_MAX_PAGES = 3;

export const PROJECT_URL = (tokenAddress) => `${VIBE_BASE_URL}/token/${tokenAddress}`;
