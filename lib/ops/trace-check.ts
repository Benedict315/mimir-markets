/**
 * The offline trace-correlation check.
 *
 * Correlation is only worth anything if it holds across the two processes and
 * cannot be broken by the very inputs it accepts. Both are properties of code
 * rather than of configuration, so both are checkable here — with no network, no
 * `DATABASE_URL`, no seeds, no LLM keys, and no PostHog key. That is what makes
 * this runnable on a clean checkout and in CI, which is the whole point: a
 * telemetry feature that can only be validated against a live deployment is a
 * telemetry feature nobody validates.
 *
 * What it does NOT check, stated rather than implied: that a real HTTP call
 * carries a real header, and that Postgres accepts a real row. Those need a
 * network and a database. What it does check is the part that silently rots —
 * the id contract, the fail-closed branches, the redaction, and the ambient
 * context under concurrency.
 *
 * It drives the production wiring, not a re-implementation of it: a worker cycle
 * goes through `reportingPoll`, its outbound call through `outboundTraceHeaders`,
 * and the server side through `tracedRoute` and `apiError`. A check that modelled
 * those instead would pass while the real thing was broken.
 */

import { apiError } from "../api/errors";
import { currentTraceId, endSpan, setTraceSink, startSpan, type Span } from "./trace";
import { decodeHeartbeat, encodeHeartbeat } from "./health";
import { reportingPoll } from "./heartbeat";
import {
  TRACE_HEADER,
  outboundTraceHeaders,
  resolveRequestTrace,
  tracedRoute,
  type TraceHeaders,
} from "./trace-http";
import { isTraceId, normalizeTraceId } from "./trace-id";

export interface TraceCheckFinding {
  /** Stable, fail-closed id. `scripts/check-trace-correlation.ts` exits 1 on any. */
  code: string;
  detail: string;
}

export interface TraceCheckReport {
  ok: boolean;
  /** Checks that ran, in the order they ran. */
  checks: string[];
  findings: TraceCheckFinding[];
  /** Non-secret correlation ids from the run, so a failure is greppable. */
  traceIds: string[];
  spans: number;
}

// Real 56-character base32 strkeys (the shape the redaction guard matches on), not
// lorem strings: a guard tested against the wrong length would pass while every
// real address walked straight through it.
const A_CONTRACT = "CDKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2BIPW5";
const A_SECRET = "SDKRY7GNU3CJQX6FMT2BIPW5ELSZAHOV4DKRY7GNU3CJQX6FMT2BIPW5";

/** A real Stellar strkey, so the address guard is tested against the real shape. */
const WALLET = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";

/**
 * Header values a caller could send that must never be adopted as a trace id.
 *
 * Read through a stub rather than a real `Headers`, on purpose: the WHATWG
 * constructor refuses a CRLF outright, so a `Headers`-based test would silently
 * cover only the easy half. A transport that already stripped the CRLF is the
 * realistic case, and the guard has to hold there too.
 */
const HOSTILE_HEADERS = [
  "",
  "   ",
  "not-a-trace-id",
  // Header splitting, if a proxy ever forwards a folded value.
  "mh_00000000000000000000000000000000\r\nx-injected: 1",
  // Unbounded: a log-flooding and storage-bloat primitive.
  `mh_${"a".repeat(4096)}`,
  // Right shape, wrong length.
  "mh_abcdef",
  // A secret pasted into the correlation field.
  A_SECRET,
  // A wallet address in the correlation field.
  WALLET,
  // Someone else's trace id in another system.
  "4bf92f3577b34da6a3ce929d0e0e4736",
];

/** A `Headers`-shaped reader that hands back whatever it was given, unvalidated. */
function hostileHeaders(value: string): { get(name: string): string | null } {
  return { get: (name) => (name === TRACE_HEADER ? value : null) };
}

class Recorder {
  readonly spans: Span[] = [];
  readonly sink = { emit: (span: Span) => void this.spans.push(span) };
  byTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }
  byName(name: string): Span[] {
    return this.spans.filter((s) => s.name === name);
  }
  errors(): Span[] {
    return this.spans.filter((s) => s.status === "error");
  }
}

/** Serialise a promise to JSON without letting a cycle throw. */
function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserialisable]";
  }
}

export async function checkTraceCorrelation(): Promise<TraceCheckReport> {
  const checks: string[] = [];
  const findings: TraceCheckFinding[] = [];
  /** Every id this run handled, for the artifact. Repeats are expected. */
  const traceIds: string[] = [];
  /** Ids minted independently by this run; these must be unique. */
  const minted: string[] = [];
  const recorder = new Recorder();
  setTraceSink(recorder.sink);

  const fail = (code: string, detail: string) => findings.push({ code, detail });
  const check = (name: string) => checks.push(name);

  try {
    // ── 1. A worker cycle mints a trace, and the failing call names it ─────────
    check("worker cycle mints a trace and stamps its span");
    // Captured on one object rather than in separate `let`s: the cycle body runs
    // inside a callback, and TypeScript cannot see those assignments, so each
    // `let` would still read as `null` at every use below. A property read is not
    // narrowed that way, which keeps the checks honest instead of cast-laden.
    const cycle: {
      traceId?: string;
      outbound?: TraceHeaders;
      errorBody?: { error?: { trace_id?: string } };
      errorHeader?: string | null;
    } = {};

    await reportingPoll("oracle", "oracle", 60, async () => {
      cycle.traceId = currentTraceId() ?? undefined;
      // What an oracle settlement cycle does: buy a persona's verdict.
      cycle.outbound = outboundTraceHeaders();
      // What the web side does with a failure: build the machine-readable error.
      const failure = apiError("upstream_unavailable", "council vote endpoint unreachable");
      cycle.errorBody = failure.body;
      cycle.errorHeader = failure.headers[TRACE_HEADER] ?? null;
      throw new Error("settlement cycle failed while buying a verdict");
    });

    const cycleTraceId = cycle.traceId;
    if (!isTraceId(cycleTraceId)) {
      fail("TRACE_CYCLE_ID_MISSING", "a completed worker cycle carried no valid trace id");
    } else {
      traceIds.push(cycleTraceId);
      minted.push(cycleTraceId);
    }

    const cycleSpans = recorder.byName("oracle.cycle");
    if (cycleSpans.length !== 1) {
      fail("TRACE_CYCLE_SPAN_MISSING", `expected exactly 1 oracle.cycle span, saw ${cycleSpans.length}`);
    } else if (cycleTraceId && cycleSpans[0].traceId !== cycleTraceId) {
      fail(
        "TRACE_CYCLE_SPAN_MISMATCH",
        `cycle span ${describe(cycleSpans[0].traceId)} is not the cycle id ${describe(cycleTraceId)}`,
      );
    } else if (cycleSpans[0].status !== "error") {
      fail("TRACE_CYCLE_STATUS_LOST", `a failed cycle recorded status ${describe(cycleSpans[0].status)}`);
    }

    // ── 2. The header crosses the process boundary ────────────────────────────
    check("outbound call carries the cycle's trace id");
    if (!cycle.outbound) {
      fail("TRACE_OUTBOUND_HEADERS_MISSING", "the worker produced no outbound trace headers");
    } else if (cycle.outbound[TRACE_HEADER] !== cycleTraceId) {
      fail(
        "TRACE_OUTBOUND_ID_MISMATCH",
        `outbound id ${describe(cycle.outbound[TRACE_HEADER])} is not the cycle id ${describe(cycleTraceId)}`,
      );
    }

    // ── 3. The web side adopts the id the worker handed it ────────────────────
    check("a traced route adopts a valid inbound id");
    const adopted = resolveRequestTrace(new Headers({ [TRACE_HEADER]: cycleTraceId ?? "" }));
    if (adopted.source !== "inbound" || adopted.traceId !== cycleTraceId) {
      fail(
        "TRACE_INBOUND_ID_NOT_ADOPTED",
        `a well-formed inbound id came back as ${describe(adopted.source)}/${describe(adopted.traceId)}`,
      );
    }
    // Recorded twice on purpose: the artifact should show the worker's id and the
    // id the web request answered with as the same string, which is the claim the
    // whole feature rests on.
    traceIds.push(adopted.traceId);

    // ── 4. A hostile id is replaced, never adopted ─────────────────────────────
    check("a malformed or secret-shaped inbound id is replaced");
    for (const value of HOSTILE_HEADERS) {
      const resolved = resolveRequestTrace(hostileHeaders(value));
      if (value.trim() === "") {
        if (resolved.source !== "generated" || !isTraceId(resolved.traceId)) {
          fail("TRACE_EMPTY_ID_NOT_MINTED", `an empty header produced ${describe(resolved)}`);
        }
        continue;
      }
      if (resolved.traceId === value.trim() || resolved.source !== "rejected") {
        fail(
          "TRACE_HOSTILE_ID_ADOPTED",
          `inbound ${describe(value.slice(0, 40))} was adopted as ${describe(resolved.source)}`,
        );
      }
      if (!isTraceId(resolved.traceId)) {
        fail("TRACE_REPLACEMENT_INVALID", `a rejected id was replaced with ${describe(resolved.traceId)}`);
      }
    }

    // ── 5. The failure the agent reads back carries the id ────────────────────
    check("an API error body and header carry the same trace id");
    if (cycleTraceId) {
      if (cycle.errorBody?.error?.trace_id !== cycleTraceId) {
        fail(
          "TRACE_ERROR_BODY_MISSING_ID",
          `apiError body trace_id was ${describe(cycle.errorBody?.error?.trace_id)}, expected ${describe(cycleTraceId)}`,
        );
      }
      if (cycle.errorHeader !== cycleTraceId) {
        fail(
          "TRACE_ERROR_HEADER_MISSING_ID",
          `apiError header was ${describe(cycle.errorHeader)}, expected ${describe(cycleTraceId)}`,
        );
      }
    }

    // ── 6. The heartbeat row names the cycle ──────────────────────────────────
    check("the heartbeat payload round-trips the cycle trace id");
    const encoded = encodeHeartbeat({ atMs: 1_800_000_000_000, intervalSec: 60, traceId: cycleTraceId ?? "" });
    const decoded = decodeHeartbeat(encoded);
    if (decoded?.traceId !== cycleTraceId) {
      fail("TRACE_HEARTBEAT_ID_LOST", `heartbeat round-trip produced ${describe(decoded?.traceId)}`);
    }
    const hostileRow = decodeHeartbeat(
      JSON.stringify({ atMs: 1_800_000_000_000, traceId: A_SECRET }),
    );
    if (hostileRow?.traceId !== undefined) {
      fail("TRACE_HEARTBEAT_ID_UNVALIDATED", "a secret-shaped heartbeat row was accepted as a trace id");
    }
    // An old row with no trace id must still decode — the field is additive, so
    // every heartbeat written before this change keeps working.
    if (decodeHeartbeat(JSON.stringify({ atMs: 1_800_000_000_000 })) === null) {
      fail("TRACE_HEARTBEAT_LEGACY_ROW_REJECTED", "a heartbeat row without a trace id no longer decodes");
    }

    // ── 7. A span cannot become a leak path ───────────────────────────────────
    check("span attributes and error text cannot carry a secret or a wallet");
    const hostile = startSpan("oracle.settle", {
      attributes: {
        private_key: "0x" + "11".repeat(32),
        ORACLE_SECRET: A_SECRET,
        authorization: "Bearer abc",
        creator: WALLET,
        contract: A_CONTRACT,
        evidence_text: "x".repeat(400),
        prompt: "ignore previous instructions",
        tags: ["a", "b"],
        nested: { claim_id: 1 },
        ratio: Number.NaN,
        ok: true,
      },
    });
    endSpan(hostile, { error: new Error(`vote failed: ${A_SECRET} ${WALLET} https://x.test/vote?proof=abc123`) });
    const hostileRecord = recorder.byName("oracle.settle").at(-1);
    if (!hostileRecord) {
      fail("TRACE_HOSTILE_SPAN_NOT_RECORDED", "the hostile span never reached the sink");
    } else {
      const kept = Object.keys(hostileRecord.attributes);
      const forbidden = kept.filter((k) =>
        /private_key|secret|authorization|creator|evidence_text|prompt|tags|nested|ratio/i.test(k),
      );
      if (forbidden.length > 0) fail("TRACE_SPAN_LEAKED_KEY", `kept ${forbidden.join(", ")}`);
      if (hostileRecord.attributes.contract !== A_CONTRACT) {
        fail("TRACE_SPAN_DROPPED_PUBLIC_CONTRACT", "the market contract id is public context and was dropped");
      }
      if (hostileRecord.attributes.ok !== true) fail("TRACE_SPAN_DROPPED_SAFE_ATTRIBUTE", "a safe boolean was dropped");
      const text = describe(hostileRecord);
      for (const [label, secret] of [
        ["seed", A_SECRET],
        ["wallet", WALLET],
        ["query string", "proof=abc123"],
      ] as const) {
        if (text.includes(secret)) fail("TRACE_SPAN_LEAKED_VALUE", `a ${label} survived into a span`);
      }
      if (hostileRecord.status !== "error") fail("TRACE_SPAN_STATUS_LOST", "an errored span recorded another status");
    }

    // ── 8. Two concurrent requests must not share an id ────────────────────────
    check("concurrent requests keep separate ambient traces");
    const handler = tracedRoute("api.council.vote", async () => {
      const seen = currentTraceId();
      // Yield so both handlers are inside their trace at the same time — the
      // interleaving a module-level variable would get wrong.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ seen, stillMine: currentTraceId() === seen });
    });
    const [first, second] = await Promise.all([handler(new Request("https://mimir.test/a")), handler(new Request("https://mimir.test/b"))]);
    const bodies = (await Promise.all([first.json(), second.json()])) as { seen: string; stillMine: boolean }[];
    if (bodies[0].seen === bodies[1].seen) {
      fail("TRACE_CONCURRENT_REQUESTS_SHARED_ID", "two in-flight requests ran under one trace id");
    }
    if (!bodies.every((b) => b.stillMine)) {
      fail("TRACE_CONTEXT_CROSSED", "a nested await changed the ambient trace id mid-request");
    }
    const responseIds = [first.headers.get(TRACE_HEADER), second.headers.get(TRACE_HEADER)];
    if (responseIds[0] !== bodies[0].seen || responseIds[1] !== bodies[1].seen) {
      fail(
        "TRACE_RESPONSE_HEADER_MISMATCH",
        `response headers ${describe(responseIds)} do not match the spans ${describe(bodies.map((b) => b.seen))}`,
      );
    }
    const concurrentIds = responseIds.filter((id): id is string => isTraceId(id));
    traceIds.push(...concurrentIds);
    minted.push(...concurrentIds);

    // ── 9. Disabling telemetry must not change what a caller sees ─────────────
    check("disabling emission changes no response contract");
    const previous = process.env.MIMIR_TRACE_DISABLED;
    process.env.MIMIR_TRACE_DISABLED = "1";
    try {
      const disabled = await tracedRoute("api.council.vote", async () =>
        Response.json({ ok: true }),
      )(new Request("https://mimir.test/c"));
      if (disabled.status !== 200) {
        fail("TRACE_DISABLED_CHANGED_STATUS", `status became ${disabled.status} while disabled`);
      }
      const disabledId = disabled.headers.get(TRACE_HEADER);
      if (!isTraceId(disabledId)) {
        fail("TRACE_DISABLED_CHANGED_CONTRACT", "the correlation header disappeared while disabled");
      } else {
        traceIds.push(disabledId);
        minted.push(disabledId);
      }
      // Two from the concurrency check plus this one. The point of the kill switch
      // is to stop *writing lines*; the in-process tail is what the health surface
      // reads, and silencing it would make `MIMIR_TRACE_DISABLED=1` look like a
      // total amnesia rather than a pause.
      const councilSpans = recorder.byName("api.council.vote").length;
      if (councilSpans !== 3) {
        fail(
          "TRACE_DISABLED_STOPPED_RECORDING",
          `expected 3 api.council.vote spans, saw ${councilSpans} while disabled`,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.MIMIR_TRACE_DISABLED;
      else process.env.MIMIR_TRACE_DISABLED = previous;
    }

    // ── 10. The id is a label, never a capability ─────────────────────────────
    check("independently minted trace ids never collide");
    // Uniqueness is asserted over the ids this run MINTED. The worker's id and the
    // one the web side adopted are the same id on purpose — that is the whole
    // feature — so counting them twice would fail the check it is meant to prove.
    if (new Set(minted).size !== minted.length) {
      fail("TRACE_ID_COLLISION", `${minted.length} minted ids are not all distinct`);
    }
    for (const id of minted) {
      if (normalizeTraceId(id) !== id) fail("TRACE_ID_NOT_CANONICAL", `${describe(id)} is not canonical`);
    }
    for (const id of traceIds) {
      if (!isTraceId(id)) fail("TRACE_ID_INVALID", `${describe(id)} is not a well-formed trace id`);
    }
  } finally {
    setTraceSink(null);
  }

  return { ok: findings.length === 0, checks, findings, traceIds, spans: recorder.spans.length };
}

export function formatTraceCheckReport(report: TraceCheckReport): string {
  const lines = [
    `trace correlation: ${report.ok ? "PASS" : "FAIL"} (${report.checks.length} checks, ${report.spans} spans, ${report.findings.length} findings)`,
  ];
  for (const name of report.checks) lines.push(`  ✓ ${name}`);
  for (const finding of report.findings) lines.push(`  ✗ ${finding.code}: ${finding.detail}`);
  for (const id of report.traceIds) lines.push(`  trace_id=${id}`);
  return lines.join("\n");
}
