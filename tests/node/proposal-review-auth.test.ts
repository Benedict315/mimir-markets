/**
 * Authorization tests for the proposal review queue.
 *
 * The queue is an operator tool, so both routes demand the shared worker secret.
 * The regression these guard against is the one that shipped first: a `Bearer`
 * header of any value was enough to read the queue and drive the state machine,
 * and the mark-stale cron ran with no check at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";

const CRON_SECRET = "test-cron-secret-value";

interface RecordedQuery {
  sql: string;
  args: unknown[];
}

const recorded: RecordedQuery[] = [];

function installFakePool(): void {
  const record = async (sql: string, args: unknown[] = []) => {
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      recorded.push({ sql, args });
    }
    return { rows: [] as Array<Record<string, unknown>>, rowCount: 1 };
  };

  const pool = {
    query: (sql: string, args: unknown[] = []) => record(sql, args),
    connect: async () => ({
      query: (sql: string, args: unknown[] = []) => record(sql, args),
      release: () => {},
    }),
  };

  process.env.DATABASE_URL = "postgres://fake/mimir";
  const g = globalThis as unknown as Record<string, unknown>;
  g.__mimirDbPool = pool;
  g.__mimirDbReady = Promise.resolve(pool);
}

installFakePool();

process.env.CRON_SECRET = CRON_SECRET;

import { GET, POST, PATCH } from "../../app/api/proposals/review/route";
import { POST as runMarkStale } from "../../app/api/cron/proposals/mark-stale/route";

function request(url: string, method: string, body?: unknown, token?: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function reset(): void {
  recorded.length = 0;
}

test("GET /api/proposals/review: refuses a request with no Authorization header", async () => {
  reset();
  const res = await GET(request("http://localhost/api/proposals/review", "GET", undefined, null));
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0, "must not query the queue without credentials");
});

test("GET /api/proposals/review: refuses an arbitrary bearer token", async () => {
  reset();
  const res = await GET(request("http://localhost/api/proposals/review", "GET", undefined, "not-the-secret"));
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0, "must not query the queue on a wrong token");
});

test("GET /api/proposals/review: refuses a token that is a prefix of the secret", async () => {
  reset();
  const res = await GET(
    request("http://localhost/api/proposals/review", "GET", undefined, CRON_SECRET.slice(0, -1)),
  );
  assert.equal(res.status, 401);
});

test("GET /api/proposals/review: serves the queue to the worker secret", async () => {
  reset();
  const res = await GET(request("http://localhost/api/proposals/review", "GET", undefined, CRON_SECRET));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.proposals));
  assert.ok(recorded.some((q) => /FROM market_proposals/.test(q.sql)));
});

test("POST /api/proposals/review: refuses state transitions without the secret", async () => {
  reset();
  const res = await POST(
    request("http://localhost/api/proposals/review", "POST", { action: "claim", proposalId: "p1", reviewer: "r1" }, "anything"),
  );
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0, "no proposal may be claimed without credentials");
});

test("POST /api/proposals/review: allows mark_stale only for the worker secret", async () => {
  reset();
  const denied = await POST(
    request("http://localhost/api/proposals/review", "POST", { action: "mark_stale" }, "anything"),
  );
  assert.equal(denied.status, 401);
  assert.equal(recorded.length, 0);

  const allowed = await POST(
    request("http://localhost/api/proposals/review", "POST", { action: "mark_stale" }, CRON_SECRET),
  );
  assert.equal(allowed.status, 200);
  assert.ok(recorded.some((q) => /review_status = 'stale'/.test(q.sql)));
});

test("PATCH /api/proposals/review: refuses status rewrites without the secret", async () => {
  reset();
  const res = await PATCH(
    request("http://localhost/api/proposals/review", "PATCH", { proposalId: "p1", status: "approved" }, "anything"),
  );
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0, "must not rewrite review_status without credentials");
});

test("POST /api/cron/proposals/mark-stale: refuses a request with no Authorization header", async () => {
  reset();
  const res = await runMarkStale(new Request("http://localhost/api/cron/proposals/mark-stale", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0, "the cron sweep must not run unauthenticated");
});

test("POST /api/cron/proposals/mark-stale: refuses an arbitrary bearer token", async () => {
  reset();
  const res = await runMarkStale(
    new Request("http://localhost/api/cron/proposals/mark-stale", {
      method: "POST",
      headers: { authorization: "Bearer anything" },
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(recorded.length, 0);
});

test("POST /api/cron/proposals/mark-stale: runs for the worker secret", async () => {
  reset();
  const res = await runMarkStale(
    new Request("http://localhost/api/cron/proposals/mark-stale", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(recorded.some((q) => /review_status = 'stale'/.test(q.sql)));
});

test("both routes fail closed when CRON_SECRET is unset", async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  reset();
  try {
    // A configured-looking secret is still refused: with no secret to compare
    // against, the route must not become an open endpoint.
    const cron = await runMarkStale(
      new Request("http://localhost/api/cron/proposals/mark-stale", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    assert.equal(cron.status, 403);

    const review = await GET(
      request("http://localhost/api/proposals/review", "GET", undefined, CRON_SECRET),
    );
    assert.equal(review.status, 403);
    assert.equal(recorded.length, 0);
  } finally {
    process.env.CRON_SECRET = previous;
  }
});
