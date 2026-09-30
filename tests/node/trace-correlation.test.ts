import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSpan,
  currentTraceId,
  endSpan,
  mintSpanId,
  mintTraceId,
  runWithTrace,
  sanitizeErrorText,
  setTraceSink,
  startSpan,
  type Span,
} from "../../lib/ops/trace";
import {
  TRACE_HEADER,
  outboundTraceHeaders,
  resolveRequestTrace,
  traceHeaders,
  tracedRoute,
} from "../../lib/ops/trace-http";
import { isTraceId, isSpanId, normalizeTraceId } from "../../lib/ops/trace-id";
import { checkTraceCorrelation } from "../../lib/ops/trace-check";

// Valid 56-character base32 strkeys. The redaction guard is only meaningful if it
// is tested against the real length — a 40-character stand-in would pass while
// every real address walked straight through.
const CONTRACT = "CDKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2BIPW5";
const SEED = "SDKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2BIPW5";
const WALLET = "GDKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2BIPW5";

function collect(): { spans: Span[]; sink: { emit(span: Span): void } } {
  const spans: Span[] = [];
  return { spans, sink: { emit: (span) => void spans.push(span) } };
}

// ── Identity ──────────────────────────────────────────────────────────────────

test("minted ids are well formed, unique and canonical", () => {
  const ids = new Set(Array.from({ length: 500 }, () => mintTraceId()));
  assert.equal(ids.size, 500, "minted trace ids collided");
  for (const id of ids) {
    assert.equal(isTraceId(id), true);
    assert.equal(normalizeTraceId(id), id);
  }
  const spans = new Set(Array.from({ length: 500 }, () => mintSpanId()));
  assert.equal(spans.size, 500, "minted span ids collided");
  for (const id of spans) assert.equal(isSpanId(id), true);
});

test("only a canonical mh_ id is accepted as a trace id", () => {
  const id = mintTraceId();
  assert.equal(isTraceId(id), true);
  for (const bad of [
    id.toUpperCase(), // case is not folded: the minted form is lowercase
    id.slice(0, -1), // too short
    `${id}0`, // too long
    id.slice(3), // missing prefix
    `xx_${id.slice(3)}`, // wrong prefix
    "mh_" + "0".repeat(16), // right alphabet, wrong length
    "mh_" + "g".repeat(32), // not hex
    "sp_" + id.slice(3), // a span id is not a trace id
    42,
    null,
    undefined,
  ]) {
    assert.equal(isTraceId(bad), false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(normalizeTraceId(bad), null, `normalised ${JSON.stringify(bad)}`);
  }
  // Surrounding whitespace is trimmed, not trusted, and the result is canonical.
  assert.equal(normalizeTraceId(` ${id}\n`), id);
});

// ── Context ───────────────────────────────────────────────────────────────────

test("runWithTrace scopes a trace and restores the outer one", () => {
  assert.equal(currentTraceId(), null, "a trace leaked outside any scope");
  const outer = mintTraceId();
  runWithTrace(outer, () => {
    assert.equal(currentTraceId(), outer);
    const inner = mintTraceId();
    runWithTrace(inner, () => {
      assert.equal(currentTraceId(), inner);
    });
    assert.equal(currentTraceId(), outer, "the inner trace was not popped");
  });
  assert.equal(currentTraceId(), null);
});

test("an untraced caller gets no trace rather than a shared one", () => {
  assert.equal(currentTraceId(), null);
  assert.equal(currentSpan(), null);
});

test("a failed span still ends, records the error, and rethrows", () => {
  const recorder = collect();
  setTraceSink(recorder.sink);
  try {
    const traceId = mintTraceId();
    assert.throws(() =>
      runWithTrace(traceId, () => {
        const span = startSpan("worker.step");
        throw new Error("boom");
      }),
    );
    assert.equal(recorder.spans.length, 0, "an unfinished span was emitted");

    runWithTrace(traceId, () => {
      const span = startSpan("worker.step");
      try {
        throw new Error(`upstream ${SEED}`);
      } catch (error) {
        endSpan(span, { error });
      }
    });
    const [span] = recorder.spans;
    assert.equal(span.status, "error");
    assert.equal(span.traceId, traceId);
    assert.equal((span.error ?? "").includes(SEED), false, "a seed reached the span error");
  } finally {
    setTraceSink(null);
  }
});

test("a sink that throws cannot break the caller", () => {
  setTraceSink({
    emit: () => {
      throw new Error("telemetry backend down");
    },
  });
  try {
    assert.doesNotThrow(() =>
      runWithTrace(mintTraceId(), () => {
        endSpan(startSpan("worker.step"));
      }),
    );
  } finally {
    setTraceSink(null);
  }
});

// ── Redaction ─────────────────────────────────────────────────────────────────

test("a span keeps operational context and drops everything that could leak", () => {
  const recorder = collect();
  setTraceSink(recorder.sink);
  try {
    const span = startSpan("oracle.settle", {
      attributes: {
        contract: CONTRACT, // public market id: kept
        ok: true,
        count: 3,
        claim_id: 7,
        // Every one of these is dropped:
        private_key: "0x" + "11".repeat(32),
        ORACLE_SECRET: SEED,
        authorization: "Bearer abc",
        creator: WALLET,
        evidence_text: "x".repeat(400),
        tags: ["a"],
        nested: { a: 1 },
        ratio: Number.NaN,
        ratio2: Infinity,
        wallet: WALLET, // a strkey value under a non-exempt key
      },
    });
    endSpan(span);

    const { attributes } = recorder.spans[0];
    assert.deepEqual(Object.keys(attributes).sort(), ["claim_id", "contract", "count", "ok"]);
    assert.equal(attributes.contract, CONTRACT, "the public market id is the context an incident needs");
    const serialised = JSON.stringify(recorder.spans[0]);
    for (const secret of [SEED, WALLET, "Bearer abc", "0x1111"]) {
      assert.equal(serialised.includes(secret), false, `${secret.slice(0, 6)} survived into a span`);
    }
  } finally {
    setTraceSink(null);
  }
});

test("an error message cannot smuggle a secret, an address, or a query string", () => {
  const cases = [
    `keygen failed for ${SEED}`,
    `cannot sign as ${WALLET}`,
    `market ${CONTRACT} has no quorum`,
    "vote failed: https://mimir.test/api/council/vote?proof=abc123&sig=deadbeef",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1",
    "seed " + SEED + " wallet " + WALLET, // several, in one message
  ];
  for (const message of cases) {
    const safe = sanitizeErrorText(message);
    assert.equal(/[GSCM][A-Z2-7]{55}/.test(safe), false, `a strkey survived: ${safe}`);
    assert.equal(/0x[0-9a-f]{64}/i.test(safe), false, `a private key survived: ${safe}`);
    assert.equal(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(safe), false, `a token survived: ${safe}`);
    assert.equal(safe.includes("proof=abc123"), false, `a query string survived: ${safe}`);
  }
  // The path is what identifies the endpoint in an incident; only the query goes.
  assert.equal(
    sanitizeErrorText("POST https://mimir.test/api/council/vote?proof=abc123 failed"),
    "POST https://mimir.test/api/council/vote?<redacted> failed",
  );
  // An ordinary message is untouched, because a redacted error helps nobody.
  assert.equal(sanitizeErrorText(new Error("council vote endpoint unreachable")), "council vote endpoint unreachable");
});

// ── HTTP ──────────────────────────────────────────────────────────────────────

test("a valid inbound id is adopted and anything else is replaced", () => {
  const inbound = mintTraceId();
  const adopted = resolveRequestTrace(new Headers({ [TRACE_HEADER]: inbound }));
  assert.deepEqual(adopted, { traceId: inbound, source: "inbound" });

  const generated = resolveRequestTrace(new Headers());
  assert.equal(generated.source, "generated");
  assert.equal(isTraceId(generated.traceId), true);

  for (const hostile of [SEED, WALLET, "abc", `${inbound}x`]) {
    const resolved = resolveRequestTrace({ get: () => hostile });
    assert.equal(resolved.source, "rejected", `adopted ${JSON.stringify(hostile.slice(0, 12))}`);
    assert.equal(isTraceId(resolved.traceId), true);
  }
  // A blank header is the absence of a header, not a bad one: "generated" rather
  // than "rejected", so a client that sends an empty value is not reported as
  // hostile for it.
  for (const blank of ["", "   "]) {
    assert.equal(resolveRequestTrace({ get: () => blank }).source, "generated");
  }
});

test("outbound headers carry the ambient trace, or a fresh one", () => {
  assert.equal(isTraceId(outboundTraceHeaders()[TRACE_HEADER]), true);
  const traceId = mintTraceId();
  runWithTrace(traceId, () => {
    assert.equal(outboundTraceHeaders()[TRACE_HEADER], traceId);
    assert.equal(traceHeaders(traceId)[TRACE_HEADER], traceId);
    assert.equal(traceHeaders("garbage")[TRACE_HEADER].length, 35, "a bad id was passed through");
  });
});

test("a traced route adopts, answers with, and survives a throwing handler", async () => {
  const inbound = mintTraceId();
  const ok = await tracedRoute("api.test", async () => Response.json({ seen: currentTraceId() }))(
    new Request("https://mimir.test/x", { headers: { [TRACE_HEADER]: inbound } }),
  );
  assert.equal(ok.headers.get(TRACE_HEADER), inbound);
  assert.deepEqual(await ok.json(), { seen: inbound });
  assert.equal(currentTraceId(), null, "the request trace outlived the request");

  // A 500 is where an operator starts, so it must be correlatable — which means
  // the wrapper answers rather than rethrowing into a boundary that owns the
  // headers. The response body carries no message: the throw may hold the very
  // value that must not reach a client.
  const broken = await tracedRoute("api.test", async () => {
    throw new Error(`handler exploded for ${SEED}`);
  })(new Request("https://mimir.test/y"));
  assert.equal(broken.status, 500);
  const brokenId = broken.headers.get(TRACE_HEADER);
  assert.equal(isTraceId(brokenId), true, "a 500 must still be correlatable");
  const body = (await broken.json()) as { error: { code: string; trace_id: string } };
  assert.equal(body.error.trace_id, brokenId);
  assert.equal(JSON.stringify(body).includes(SEED), false, "a seed reached a 500 response body");
  assert.equal(currentTraceId(), null);
});

test("the wrapper's id wins over one a handler set, and requests do not cross", async () => {
  // A route that proxies an upstream response inherits that response's headers, and
  // the upstream's id belongs to a different trace. Overwriting is the point.
  const handlerSets = mintTraceId();
  const response = await tracedRoute("api.test", async () =>
    Response.json({}, { headers: { [TRACE_HEADER]: handlerSets } }),
  )(new Request("https://mimir.test/z"));
  assert.notEqual(response.headers.get(TRACE_HEADER), handlerSets);

  const handler = tracedRoute("api.test", async () => {
    const seen = currentTraceId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ seen, same: currentTraceId() === seen });
  });
  const [a, b] = await Promise.all([
    handler(new Request("https://mimir.test/a")),
    handler(new Request("https://mimir.test/b")),
  ]);
  const [ja, jb] = [await a.json(), await b.json()] as { seen: string; same: boolean }[];
  assert.notEqual(ja.seen, jb.seen, "two in-flight requests shared a trace id");
  assert.equal(ja.same && jb.same, true);
});

test("disabling emission changes no response and keeps spans in memory", async () => {
  const recorder = collect();
  setTraceSink(recorder.sink);
  const previous = process.env.MIMIR_TRACE_DISABLED;
  process.env.MIMIR_TRACE_DISABLED = "1";
  try {
    const response = await tracedRoute("api.test", async () => Response.json({ ok: true }))(
      new Request("https://mimir.test/a"),
    );
    assert.equal(response.status, 200);
    assert.equal(isTraceId(response.headers.get(TRACE_HEADER)), true);
    assert.equal(recorder.spans.length, 1, "the in-process record must survive the kill switch");
  } finally {
    if (previous === undefined) delete process.env.MIMIR_TRACE_DISABLED;
    else process.env.MIMIR_TRACE_DISABLED = previous;
    setTraceSink(null);
  }
});

// ── The offline check itself ──────────────────────────────────────────────────

test("the offline trace check passes on a clean checkout", async () => {
  const report = await checkTraceCorrelation();
  assert.deepEqual(report.findings, [], `check:trace reported ${report.findings.length} findings`);
  assert.equal(report.ok, true);
  assert.ok(report.checks.length >= 10, "the check silently lost its checks");
});
