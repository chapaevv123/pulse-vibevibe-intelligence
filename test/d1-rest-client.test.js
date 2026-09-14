import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1RestClient, D1RestError } from "../src/d1RestClient.js";

const ACCOUNT_ID = "acct123";
const DATABASE_ID = "db456";
const API_TOKEN = "fake-token-never-a-real-secret-abc123";

function makeFakeFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("1. missing required config throws immediately (before any fetch)", () => {
  assert.throws(() => createD1RestClient({ databaseId: DATABASE_ID, apiToken: API_TOKEN }), D1RestError);
  assert.throws(() => createD1RestClient({ accountId: ACCOUNT_ID, apiToken: API_TOKEN }), D1RestError);
  assert.throws(() => createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID }), D1RestError);
});

test("2. a successful query response is parsed into the D1-binding shape (results/meta)", async () => {
  const fetchImpl = makeFakeFetch(() =>
    jsonResponse(200, {
      success: true,
      errors: [],
      result: [{ results: [{ token_address: "0xabc" }], success: true, meta: { changes: 0, last_row_id: 0 } }],
    })
  );
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  const row = await d1.prepare("SELECT * FROM launches WHERE token_address=?").bind("0xabc").first();
  assert.deepEqual(row, { token_address: "0xabc" });

  const all = await d1.prepare("SELECT * FROM launches").all();
  assert.deepEqual(all.results, [{ token_address: "0xabc" }]);
});

test("2b. .run() surfaces meta (changes/last_row_id) for writes", async () => {
  const fetchImpl = makeFakeFetch(() =>
    jsonResponse(200, { success: true, errors: [], result: [{ results: [], success: true, meta: { changes: 1, last_row_id: 42 } }] })
  );
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });
  const res = await d1.prepare("INSERT INTO x VALUES (?)").bind(1).run();
  assert.equal(res.meta.changes, 1);
  assert.equal(res.meta.last_row_id, 42);
});

test("HTTP error response (4xx) throws a clear D1RestError and is NOT retried", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(403, "Forbidden: invalid or missing token"));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  await assert.rejects(() => d1.prepare("SELECT 1").run(), D1RestError);
  assert.equal(fetchImpl.calls.length, 1, "a 4xx must not be retried");
});

test("API-level error (success:false) throws a clear D1RestError, never silently returns empty", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { success: false, errors: [{ code: 7500, message: "syntax error near X" }] }));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  await assert.rejects(() => d1.prepare("SELECT bad sql").all(), /syntax error near X/);
});

test("4. a hung/never-resolving fetch times out within the configured bound, not indefinitely", async () => {
  const fetchImpl = () => new Promise(() => {}); // never resolves
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl, timeoutMs: 30 });

  const start = Date.now();
  // A timeout is correctly classified as retryable (same treatment as a
  // 5xx), so this bounded 30ms-per-attempt timeout still costs ~3s total
  // across 3 attempts + backoff — the assertion here is "eventually gives
  // up in bounded time," not "immediately," which is a separate,
  // already-covered case (see "5b. retries are bounded").
  await assert.rejects(() => d1.prepare("SELECT 1").run());
  assert.ok(Date.now() - start < 6000, "must not hang indefinitely, even accounting for bounded retry backoff");
});

test("5. a 5xx response IS retried (bounded), and a subsequent success is returned", async () => {
  const fetchImpl = makeFakeFetch((url, options, callNum) => {
    if (callNum < 2) return jsonResponse(500, "internal error");
    return jsonResponse(200, { success: true, errors: [], result: [{ results: [{ ok: 1 }], success: true, meta: {} }] });
  });
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  const row = await d1.prepare("SELECT 1").first();
  assert.deepEqual(row, { ok: 1 });
  assert.equal(fetchImpl.calls.length, 2, "should have retried once before succeeding");
});

test("5b. retries are bounded — never an infinite retry loop", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(500, "always failing"));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  await assert.rejects(() => d1.prepare("SELECT 1").run());
  assert.ok(fetchImpl.calls.length <= 3, `expected at most 3 attempts (1 + 2 retries), got ${fetchImpl.calls.length}`);
});

test("3. the Authorization header carries the token correctly, and the token never appears in a thrown error", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(403, "Forbidden"));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  let caught = null;
  try {
    await d1.prepare("SELECT 1").run();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected a rejection");
  assert.ok(!caught.message.includes(API_TOKEN), "the token must never appear in an error message");

  const sentHeader = fetchImpl.calls[0].options.headers.authorization;
  assert.equal(sentHeader, `Bearer ${API_TOKEN}`, "the header itself must still be correct — only errors must never echo it");
});

test("request body correctly encodes SQL + bound params", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { success: true, errors: [], result: [{ results: [], success: true, meta: {} }] }));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });
  await d1.prepare("SELECT * FROM launches WHERE token_address=? AND source=?").bind("0xabc", "LIVE").all();

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.sql, "SELECT * FROM launches WHERE token_address=? AND source=?");
  assert.deepEqual(body.params, ["0xabc", "LIVE"]);
});

test("endpoint URL is correctly scoped to the given account and database", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { success: true, errors: [], result: [{ results: [], success: true, meta: {} }] }));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });
  await d1.prepare("SELECT 1").run();
  assert.equal(fetchImpl.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`);
});

// ---------------------------------------------------------------------------
// batch() — added after the first live GitHub Actions run timed out inside
// creator aggregation (one REST round-trip per row, no batching). These
// prove batch() sends many statements in ONE HTTP call instead of N.
// ---------------------------------------------------------------------------

test("batch() sends multiple statements in ONE HTTP request, not one per statement", async () => {
  const fetchImpl = makeFakeFetch(() =>
    jsonResponse(200, {
      success: true,
      errors: [],
      result: [
        { results: [], success: true, meta: { changes: 1 } },
        { results: [], success: true, meta: { changes: 1 } },
        { results: [], success: true, meta: { changes: 1 } },
      ],
    })
  );
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  const statements = [
    d1.prepare("INSERT INTO creators VALUES (?)").bind("0xa"),
    d1.prepare("INSERT INTO creators VALUES (?)").bind("0xb"),
    d1.prepare("INSERT INTO creators VALUES (?)").bind("0xc"),
  ];
  const results = await d1.batch(statements);

  assert.equal(fetchImpl.calls.length, 1, "3 statements must cost exactly 1 HTTP round-trip");
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.meta.changes),
    [1, 1, 1]
  );

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.ok(Array.isArray(body.batch), "request body must use the batch field");
  assert.equal(body.batch.length, 3);
  assert.deepEqual(body.batch[1].params, ["0xb"]);
});

test("batch() chunks large statement sets to stay under the per-request statement cap", async () => {
  const fetchImpl = makeFakeFetch((url, options) => {
    const body = JSON.parse(options.body);
    const n = body.batch.length;
    return jsonResponse(200, {
      success: true,
      errors: [],
      result: Array.from({ length: n }, () => ({ results: [], success: true, meta: { changes: 1 } })),
    });
  });
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  const statements = Array.from({ length: 200 }, (_, i) => d1.prepare("INSERT INTO x VALUES (?)").bind(i));
  const results = await d1.batch(statements);

  assert.equal(results.length, 200);
  assert.ok(fetchImpl.calls.length >= 3, `200 statements at a 90-per-chunk cap should need >=3 requests, got ${fetchImpl.calls.length}`);
});

test("batch() propagates an API-level error clearly (never silently drops a failed statement)", async () => {
  const fetchImpl = makeFakeFetch(() => jsonResponse(200, { success: false, errors: [{ message: "batch statement failed" }] }));
  const d1 = createD1RestClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID, apiToken: API_TOKEN, fetchImpl });

  const statements = [d1.prepare("INSERT INTO x VALUES (?)").bind(1)];
  await assert.rejects(() => d1.batch(statements), /batch statement failed/);
});
