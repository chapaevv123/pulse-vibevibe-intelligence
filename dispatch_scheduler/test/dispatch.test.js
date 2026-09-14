import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import worker, { dispatchSync, DISPATCH_URL, OWNER, REPO, WORKFLOW_FILE, REF } from "../src/index.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_TOKEN = "github_pat_fake_never_a_real_secret_abcXYZ123";

function makeFakeFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status) {
  return { ok: status >= 200 && status < 300, status };
}

function noSleep() {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// 1-5. request shape
// ---------------------------------------------------------------------------

test("1. dispatchSync sends exactly ONE HTTP request on success", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.ok, true);
});

test("2. request targets the correct repo (chapaevv123/pulse-vibevibe-intelligence)", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(OWNER, "chapaevv123");
  assert.equal(REPO, "pulse-vibevibe-intelligence");
  assert.ok(fetchImpl.calls[0].url.includes("/repos/chapaevv123/pulse-vibevibe-intelligence/"));
});

test("3. request targets the correct workflow file (sync.yml)", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(WORKFLOW_FILE, "sync.yml");
  assert.equal(fetchImpl.calls[0].url, DISPATCH_URL);
  assert.ok(fetchImpl.calls[0].url.endsWith("/actions/workflows/sync.yml/dispatches"));
});

test("4. request body specifies ref=main", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(REF, "main");
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.ref, "main");
});

test("5. request carries an Authorization header with the token", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(fetchImpl.calls[0].options.headers.authorization, `Bearer ${FAKE_TOKEN}`);
});

// ---------------------------------------------------------------------------
// 6. token never logged
// ---------------------------------------------------------------------------

test("6. the token never appears in any logged output, success or failure", async (t) => {
  const logged = [];
  const originalLog = console.log;
  console.log = (...args) => logged.push(args.join(" "));
  t.after(() => {
    console.log = originalLog;
  });

  const okFetch = makeFakeFetch(() => jsonResponse(204));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl: okFetch, sleepImpl: noSleep });

  const failFetch = makeFakeFetch(() => jsonResponse(401));
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl: failFetch, sleepImpl: noSleep });

  const networkFailFetch = async () => {
    throw new Error("network down");
  };
  await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl: networkFailFetch, sleepImpl: noSleep });

  assert.ok(logged.length > 0, "expected at least some log output to check");
  for (const line of logged) {
    assert.ok(!line.includes(FAKE_TOKEN), `log line must never contain the token: "${line}"`);
    assert.ok(!line.toLowerCase().includes("bearer "), `log line must never contain an Authorization header value: "${line}"`);
  }
});

// ---------------------------------------------------------------------------
// 7. success classification
// ---------------------------------------------------------------------------

test("7. a 2xx / the documented 204 response is treated as success", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
});

// ---------------------------------------------------------------------------
// 8-11. 4xx statuses: no retry, classified, never treated as success
// ---------------------------------------------------------------------------

for (const status of [401, 403, 404, 422]) {
  test(`${status === 401 ? 8 : status === 403 ? 9 : status === 404 ? 10 : 11}. a ${status} response is classified correctly and NEVER retried`, async () => {
    const fetchImpl = makeFakeFetch(() => jsonResponse(status));
    const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(fetchImpl.calls.length, 1, `a ${status} must not be retried`);
  });
}

// ---------------------------------------------------------------------------
// 12. 5xx — at most one retry
// ---------------------------------------------------------------------------

test("12. a 5xx response IS retried once, and a subsequent success is returned", async () => {
  const fetchImpl = makeFakeFetch((url, options, callNum) => (callNum < 2 ? jsonResponse(503) : jsonResponse(204)));
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 2, "should have retried once before succeeding");
});

test("12b. a persistently-failing 5xx is retried AT MOST once, never in a loop", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(500));
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 2, "expected exactly 1 initial attempt + 1 retry, never more");
});

// ---------------------------------------------------------------------------
// 13. network failure — bounded (at most one retry, never hangs/loops)
// ---------------------------------------------------------------------------

test("13. a network failure (fetch throws) is retried at most once, never in a loop", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("ECONNRESET");
  };
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.classification, "NETWORK_ERROR");
  assert.equal(calls, 2, "expected exactly 1 initial attempt + 1 retry, never more");
});

test("13b. a network failure followed by success on retry is reported as success", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return jsonResponse(204);
  };
  const result = await dispatchSync({ GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("missing token is a CONFIG_ERROR and performs zero HTTP calls", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  const result = await dispatchSync({}, { fetchImpl, sleepImpl: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.classification, "CONFIG_ERROR");
  assert.equal(fetchImpl.calls.length, 0);
});

test("the scheduled() handler drives dispatchSync exactly once via ctx.waitUntil", async (t) => {
  const originalFetch = global.fetch;
  const fetchImpl = makeFakeFetch(() => jsonResponse(204));
  global.fetch = fetchImpl;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  await worker.scheduled({ scheduledTime: Date.now() }, { GITHUB_DISPATCH_TOKEN: FAKE_TOKEN }, ctx);
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(fetchImpl.calls.length, 1, "scheduled() must trigger exactly one dispatch request");
});

test("the fetch() handler never exposes a public dispatch endpoint — every request 404s", async () => {
  const resp1 = await worker.fetch(new Request("https://example.invalid/"));
  const resp2 = await worker.fetch(new Request("https://example.invalid/dispatch"));
  const resp3 = await worker.fetch(new Request("https://example.invalid/api/trigger", { method: "POST" }));
  assert.equal(resp1.status, 404);
  assert.equal(resp2.status, 404);
  assert.equal(resp3.status, 404);
});

// ---------------------------------------------------------------------------
// 14-16. structural isolation guards (read the actual files, not mocks)
// ---------------------------------------------------------------------------

test("14. wrangler.jsonc declares NO D1 binding for this Worker", () => {
  const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  assert.doesNotMatch(wrangler, /d1_databases/, "the dispatch scheduler must never bind to D1");
});

test("15. src/index.js imports NO Pulse sync/business-logic modules", () => {
  // Only check actual `import ... from "..."` lines — this file's own
  // header comment deliberately NAMES these forbidden modules to document
  // the isolation boundary, which would otherwise false-positive.
  const src = readFileSync(path.join(ROOT, "src", "index.js"), "utf8");
  const importLines = src
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line))
    .join("\n");
  const forbidden = [/sync\.js/, /scoring\.js/, /\bdb\.js/, /vibeSource\.js/, /d1RestClient\.js/, /dashboardHtml\.js/, /api\.js/];
  for (const pattern of forbidden) {
    assert.doesNotMatch(importLines, pattern, `must not import ${pattern}`);
  }
});

test("16. no secret literal (real-looking GitHub token shape) appears in source or config", () => {
  const files = [path.join(ROOT, "src", "index.js"), path.join(ROOT, "wrangler.jsonc"), path.join(ROOT, "package.json")];
  // GitHub fine-grained PATs look like github_pat_<82 alphanumeric/underscore chars>;
  // classic PATs look like ghp_<36 chars>. Flag either shape.
  const TOKEN_SHAPED = /\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b/;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, TOKEN_SHAPED, `${f} must not contain a token-shaped literal`);
    assert.doesNotMatch(text, /GITHUB_DISPATCH_TOKEN\s*[:=]\s*["'][^"']+["']/, `${f} must not hardcode GITHUB_DISPATCH_TOKEN's value`);
  }
});

// ---------------------------------------------------------------------------
// 17. cron expression
// ---------------------------------------------------------------------------

test("17. wrangler.jsonc declares the correct shifted 15-minute cron expression", () => {
  const wrangler = readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"crons":\s*\[\s*"7,22,37,52 \* \* \* \*"\s*\]/);
});
