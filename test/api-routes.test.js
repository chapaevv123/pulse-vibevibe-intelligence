import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeEmptyD1 } from "./helpers/mockD1.js";
import { PULSE_TOKEN_ADDRESS } from "../src/config.js";

const BASE = "https://demo.pulse-vibevibe-intelligence.workers.dev";

test("read-only route enforcement: POST is rejected with 405, D1 is never touched", async () => {
  const env = {}; // no DB binding — proves the handler never reaches env.DB on a rejected method
  const res = await worker.fetch(new Request(BASE + "/", { method: "POST" }), env, {});
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(body.error, "METHOD_NOT_ALLOWED");
});

for (const method of ["PUT", "PATCH", "DELETE"]) {
  test(`read-only route enforcement: ${method} is rejected with 405`, async () => {
    const res = await worker.fetch(new Request(BASE + "/api/summary", { method }), {}, {});
    assert.equal(res.status, 405);
  });
}

test("GET /api/health returns 200 with an ok boolean", async () => {
  const res = await worker.fetch(new Request(BASE + "/api/health"), { DB: makeEmptyD1() }, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ok, "boolean");
  assert.equal(body.chain_id, 46630);
});

test("GET /api/summary returns the documented response shape", async () => {
  const res = await worker.fetch(new Request(BASE + "/api/summary"), { DB: makeEmptyD1() }, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of ["total_launches", "launches_today", "status_counts", "data_source", "chain_id"]) {
    assert.ok(key in body, `summary response missing "${key}"`);
  }
  assert.equal(body.data_source, "LIVE");
});

test("GET /api/own-project reports NOT_YET_LAUNCHED (never fabricated) against an empty DB", async () => {
  const res = await worker.fetch(new Request(BASE + "/api/own-project"), { DB: makeEmptyD1() }, {});
  const body = await res.json();
  assert.equal(body.status, "NOT_YET_LAUNCHED");
  assert.equal(body.token_address, PULSE_TOKEN_ADDRESS);
});

test("GET /api/launch/:address with a malformed address is not routed (404)", async () => {
  const res = await worker.fetch(new Request(BASE + "/api/launch/not-an-address"), { DB: makeEmptyD1() }, {});
  assert.equal(res.status, 404);
});

test("GET / renders the public dashboard HTML with the required header", async () => {
  const res = await worker.fetch(new Request(BASE + "/"), { DB: makeEmptyD1() }, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /PULSE × VIBE\/VIBE/);
  assert.match(html, /LAUNCH INTELLIGENCE/);
  assert.match(html, /NOT_YET_LAUNCHED/, "own-project panel must not fabricate a launched state");
});

test("unknown path returns 404", async () => {
  const res = await worker.fetch(new Request(BASE + "/definitely-not-a-route"), { DB: makeEmptyD1() }, {});
  assert.equal(res.status, 404);
});
