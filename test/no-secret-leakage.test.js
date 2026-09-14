import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXCLUDED_DIRS = new Set(["node_modules", ".wrangler", ".git"]);
const TEXT_EXTENSIONS = new Set([".js", ".json", ".jsonc", ".sql", ".md", ".txt", ".html", ".css"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

// This file itself intentionally contains the forbidden keywords/paths as
// regex source text (to check for them) — exclude it from its own scan.
const SELF = fileURLToPath(import.meta.url);
const files = walk(ROOT).filter((f) => f !== SELF);

// A private key (32 raw bytes) rendered as hex is 64 hex characters — longer
// than any address (40 hex chars) used in this repo. Flag any such literal.
const PRIVATE_KEY_LIKE = /\b0x[a-fA-F0-9]{64}\b/;
const FORBIDDEN_KEYWORDS = [
  /TELEGRAM_BOT_TOKEN/i,
  /TWITTER_(API|BEARER)/i,
  /\bX_API_KEY\b/i,
  /PRIVATE_KEY\s*=/i,
  /FOMOAPI_KEY/i,
  /process\.env\.\w*SECRET/i,
];

test("no file in public_vibe_demo/ contains a 64-hex-char literal (private-key shaped value)", () => {
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (PRIVATE_KEY_LIKE.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("no file references a Telegram/X/private-key/FomoAPI secret keyword", () => {
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const pattern of FORBIDDEN_KEYWORDS) {
      if (pattern.test(text)) {
        offenders.push(`${f}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("no source file reads a .env FILE (dotenv-style loading); only scripts/ may read process.env for CI-injected secrets", () => {
  // The Worker side (src/) hardcodes only public addresses and reads no
  // secret loader at all — unchanged invariant. The GitHub Actions
  // entrypoint (scripts/sync-cron.mjs) is a DELIBERATE, sole exception:
  // reading process.env is its whole job (receiving CF_D1_API_TOKEN from
  // GitHub's encrypted secrets store, the standard/correct way to consume
  // CI secrets) — fundamentally different from a dotenv-style .env FILE
  // read off disk, which remains forbidden everywhere.
  const offenders = [];
  for (const f of files) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    const text = readFileSync(f, "utf8");
    if (/require\(['"]dotenv['"]\)|from ['"]dotenv['"]|readFileSync\([^)]*['"`]\.env['"`]?\)/.test(text)) {
      offenders.push(`${f}: reads a .env file`);
    }
    // scripts/ (the real entrypoint, receiving CI secrets) and test/ (test
    // setup/teardown legitimately sets/restores fake env vars — never a
    // real secret, and never shipped/executed in production) are both
    // allowed. src/ stays strict: nothing there should read the process
    // environment directly at all.
    const normalized = f.replace(/\\/g, "/");
    const isAllowed = normalized.includes("/scripts/") || normalized.includes("/test/");
    if (!isAllowed && /\bprocess\.env\b/.test(text)) {
      offenders.push(`${f}: reads process.env directly outside the designated scripts/ entrypoint`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("wrangler.jsonc database_id is either the placeholder or a real D1 UUID — never empty/malformed", () => {
  // A D1 database_id is a resource identifier, not a credential (same
  // category as an AWS ARN) — safe to commit once the database exists.
  // Before provisioning it must still be the documented placeholder.
  const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  const m = wrangler.match(/"database_id":\s*"([^"]+)"/);
  assert.ok(m, "database_id field not found in wrangler.jsonc");
  const isPlaceholder = m[1] === "REPLACE_WITH_D1_DATABASE_ID";
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[1]);
  assert.ok(isPlaceholder || isUuid, `database_id is neither the placeholder nor a UUID: "${m[1]}"`);
});

test("wrangler.jsonc contains no Cloudflare API token or account-secret pattern", () => {
  const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  assert.doesNotMatch(wrangler, /CLOUDFLARE_API_TOKEN/i);
  assert.doesNotMatch(wrangler, /\bapi_token\b/i);
});

test("no source file actually imports/opens the private Pulse repository's production modules or DB", () => {
  // Comments are allowed to document the isolation boundary by name (e.g.
  // "never touches data/pulse.db") — only flag live code: an import/require
  // of a forbidden module, or an fs/sqlite open call naming pulse.db.
  const offenders = [];
  const forbiddenImports = [/pulse_fast_money/i, /pulse_slow_money/i, /pulse_public_telegram/i, /pulse_x_/i];
  const codeLinePattern = /^\s*(import|.*=\s*require\(|.*require\()/;
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (const line of lines) {
      const isCommentLine = /^\s*(\/\/|\*|\/\*|--)/.test(line);
      if (isCommentLine) continue;
      for (const pattern of forbiddenImports) {
        if (pattern.test(line) && codeLinePattern.test(line)) offenders.push(`${f}: ${pattern} in "${line.trim()}"`);
      }
      if (/data\/pulse\.db/i.test(line) && /(readFileSync|createConnection|new Database|sqlite3\.connect|fetch\(|open\()/i.test(line)) {
        offenders.push(`${f}: live reference to data/pulse.db in "${line.trim()}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
