import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const schemaSql = readFileSync(path.join(ROOT, "schema.sql"), "utf8");
const migrationSql = readFileSync(path.join(ROOT, "migrations", "0001_init.sql"), "utf8");

const REQUIRED_TABLES = ["launches", "market_snapshots", "creators", "scores", "holder_enrichment", "activity_enrichment", "sync_runs"];

for (const table of REQUIRED_TABLES) {
  test(`schema.sql defines table "${table}"`, () => {
    assert.match(schemaSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  });
  test(`migrations/0001_init.sql defines table "${table}" (kept in sync with schema.sql)`, () => {
    assert.match(migrationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
  });
}

test("schema.sql contains no INSERT statements (fixture/seed exclusion — the demo builds its own live dataset)", () => {
  assert.doesNotMatch(schemaSql.toUpperCase(), /INSERT\s+INTO/);
});

test("migrations/0001_init.sql contains no INSERT statements", () => {
  assert.doesNotMatch(migrationSql.toUpperCase(), /INSERT\s+INTO/);
});

test("launches table has token_address as its primary key (dedupe key)", () => {
  const m = schemaSql.match(/CREATE TABLE IF NOT EXISTS launches\s*\(([\s\S]*?)\);/);
  assert.ok(m, "launches table not found");
  assert.match(m[1], /token_address\s+TEXT PRIMARY KEY/);
});

test("market_snapshots has a UNIQUE(token_address, as_of_block) constraint (idempotent sync writes)", () => {
  const m = schemaSql.match(/CREATE TABLE IF NOT EXISTS market_snapshots\s*\(([\s\S]*?)\);/);
  assert.ok(m, "market_snapshots table not found");
  assert.match(m[1], /UNIQUE\(token_address,\s*as_of_block\)/);
});
