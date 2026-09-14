import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLaunch } from "../src/db.js";
import { PULSE_TOKEN_ADDRESS, PULSE_CREATOR_ADDRESS, VIBE_CHAIN_ID } from "../src/config.js";

test("public-address correctness: PULSE_TOKEN_ADDRESS matches the task-issued address (case-insensitive)", () => {
  assert.equal(PULSE_TOKEN_ADDRESS, "0x983762a5487d36dcf371ef7e3949e1d7d9e7454b".toLowerCase());
});

test("public-address correctness: PULSE_CREATOR_ADDRESS matches the task-issued address (case-insensitive)", () => {
  assert.equal(PULSE_CREATOR_ADDRESS, "0x765fb7e6a0bdddc29f57eece34aeda0fb318805d".toLowerCase());
});

test("own-project recognition: a launch whose tokenAddress matches PULSE_TOKEN_ADDRESS is flagged is_own_project", () => {
  const raw = { tokenAddress: PULSE_TOKEN_ADDRESS.toUpperCase(), creatorAddress: "0xsomeoneelse" };
  const row = normalizeLaunch(raw, "run_test", VIBE_CHAIN_ID);
  assert.equal(row.is_own_project, 1);
});

test("own-project recognition: a launch whose creatorAddress matches PULSE_CREATOR_ADDRESS is flagged is_own_project", () => {
  const raw = { tokenAddress: "0xnotpulsetoken000000000000000000000000", creatorAddress: PULSE_CREATOR_ADDRESS };
  const row = normalizeLaunch(raw, "run_test", VIBE_CHAIN_ID);
  assert.equal(row.is_own_project, 1);
});

test("own-project recognition: an unrelated launch is never flagged is_own_project", () => {
  const raw = { tokenAddress: "0xdeadbeef00000000000000000000000000dead", creatorAddress: "0xsomeoneelse00000000000000000000000000" };
  const row = normalizeLaunch(raw, "run_test", VIBE_CHAIN_ID);
  assert.equal(row.is_own_project, 0);
});

test("normalizeLaunch is idempotent for launch dedupe: same raw input produces the same token_address key", () => {
  const raw = { tokenAddress: "0xAAAA000000000000000000000000000000AAAA", creatorAddress: "0xbbbb" };
  const a = normalizeLaunch(raw, "run1", VIBE_CHAIN_ID);
  const b = normalizeLaunch(raw, "run2", VIBE_CHAIN_ID);
  assert.equal(a.token_address, b.token_address);
  assert.equal(a.token_address, raw.tokenAddress.toLowerCase());
});

test("normalizeLaunch never marks a public-demo row as anything other than LIVE source", () => {
  const raw = { tokenAddress: "0xcccc000000000000000000000000000000cccc" };
  const row = normalizeLaunch(raw, "run1", VIBE_CHAIN_ID);
  assert.equal(row.source, "LIVE", "the public demo ships no fixture fallback, unlike the local MVP");
});
