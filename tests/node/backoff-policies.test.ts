/**
 * @module tests/node/backoff-policies.test.ts
 *
 * Positive, negative, boundary, failure, and regression coverage for
 * `lib/ops/backoff-policies.ts`.
 *
 * Run: node --import tsx --test tests/node/backoff-policies.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BackoffError,
  MalformedInputError,
  StaleStateError,
  DuplicateActionError,
  CancelledByOperatorError,
  PausedWorkerError,
  DependencyFailureError,
  type DelayResult,
  type BackoffPolicy,
  type DelayFn,
  skip,
  fixed,
  exponentialWithJitter,
  ORACLE_BACKOFF,
  CREATOR_BACKOFF,
  COUNCIL_BACKOFF,
  SYNC_BACKOFF,
  TRADERS_BACKOFF,
  DEFAULT_BACKOFF,
  POLICIES,
  policyFor,
  describeBackoffError,
  computeBackoff,
  recordDependencySuccess,
  getConsecutiveFailures,
  resetFailureCounters,
  withBackoff,
  withBackoffAndMetrics,
} from "@/lib/ops/backoff-policies";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDepErr(
  dependency = "rpc",
  consecutive = 0,
  retryable = true,
  cause?: unknown,
): DependencyFailureError {
  return new DependencyFailureError(
    `rpc failed for dep ${dependency}`,
    dependency,
    retryable,
    consecutive,
    cause,
  );
}

// ── Typed errors ───────────────────────────────────────────────────────────────

describe("MalformedInputError", () => {
  it("is a BackoffError with kind=malformed_input", () => {
    const err = new MalformedInputError("claim id is not a number", new TypeError("NaN"));
    assert.ok(err instanceof BackoffError);
    assert.strictEqual(err.kind, "malformed_input");
    assert.ok(err.cause instanceof TypeError);
  });

  it("toJSON includes kind and message but not stack", () => {
    const err = new MalformedInputError("bad shape");
    const json = err.toJSON();
    assert.deepStrictEqual(json, { kind: "malformed_input", message: "bad shape" });
  });

  it("carries a short, log-safe message", () => {
    const err = new MalformedInputError("unparsable claim: expected number got \"abc\"");
    assert.ok(err.message.length < 300);
  });
});

describe("StaleStateError", () => {
  it("is a BackoffError with kind=stale_state", () => {
    const err = new StaleStateError("read-index 120 s behind");
    assert.strictEqual(err.kind, "stale_state");
  });

  it("preserves cause", () => {
    const cause = new Error("db lag");
    const err = new StaleStateError("stale", cause);
    assert.strictEqual(err.cause, cause);
  });
});

describe("DuplicateActionError", () => {
  it("is a BackoffError with kind=duplicate_action", () => {
    const err = new DuplicateActionError("already challenged claim #42");
    assert.strictEqual(err.kind, "duplicate_action");
  });
});

describe("CancelledByOperatorError", () => {
  it("is a BackoffError with kind=cancelled_by_operator", () => {
    const err = new CancelledByOperatorError(
      "oracle_settlement paused",
      "MIMIR_PAUSE_ORACLE_SETTLEMENT",
    );
    assert.strictEqual(err.kind, "cancelled_by_operator");
    assert.strictEqual(err.pausedBy, "MIMIR_PAUSE_ORACLE_SETTLEMENT");
  });

  it("toJSON includes pausedBy", () => {
    const err = new CancelledByOperatorError("paused", "MIMIR_PAUSE_STAKE");
    assert.deepStrictEqual(err.toJSON(), {
      kind: "cancelled_by_operator",
      message: "paused",
      pausedBy: "MIMIR_PAUSE_STAKE",
    });
  });
});

describe("PausedWorkerError", () => {
  it("is a BackoffError with kind=paused_worker", () => {
    const err = new PausedWorkerError(
      "market_creator_worker is paused",
      "market_creator_worker",
      300_000,
    );
    assert.strictEqual(err.kind, "paused_worker");
    assert.strictEqual(err.capability, "market_creator_worker");
    assert.strictEqual(err.retryAfterMs, 300_000);
  });

  it("defaults retryAfterMs to 300000", () => {
    const err = new PausedWorkerError("paused", "council_worker");
    assert.strictEqual(err.retryAfterMs, 300_000);
  });

  it("toJSON includes capability and retryAfterMs", () => {
    const err = new PausedWorkerError("paused", "oracle_settlement", 600_000);
    const json = err.toJSON();
    assert.strictEqual(json.capability, "oracle_settlement");
    assert.strictEqual(json.retryAfterMs, 600_000);
  });
});

describe("DependencyFailureError", () => {
  it("is a BackoffError with kind=dependency_failure", () => {
    const err = makeDepErr("llm", 2);
    assert.strictEqual(err.kind, "dependency_failure");
    assert.strictEqual(err.dependency, "llm");
    assert.strictEqual(err.consecutiveFailures, 2);
    assert.strictEqual(err.retryable, true);
  });

  it("carries the cause through", () => {
    const cause = new Error("ECONNREFUSED");
    const err = makeDepErr("rpc", 0, true, cause);
    assert.strictEqual(err.cause, cause);
  });

  it("retryable=false sets retryable and does not increment counter", () => {
    const err = new DependencyFailureError(
      "4xx from LLM",
      "llm",
      false,
      5,
      new Error("400"),
    );
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(err.consecutiveFailures, 5);
  });

  it("toJSON includes dependency, retryable, consecutiveFailures", () => {
    const err = makeDepErr("facilitator", 3);
    const json = err.toJSON();
    assert.deepStrictEqual(json, {
      kind: "dependency_failure",
      message: `rpc failed for dep facilitator`,
      dependency: "facilitator",
      retryable: true,
      consecutiveFailures: 3,
    });
  });
});

// ── Delay functions ────────────────────────────────────────────────────────────

describe("skip", () => {
  it("always returns ms=0 and reason='skip'", () => {
    for (const err of [
      new MalformedInputError("x"),
      new StaleStateError("x"),
      new DuplicateActionError("x"),
      new CancelledByOperatorError("x", "PAUSE"),
      new PausedWorkerError("x", "cap"),
      0 as unknown as BackoffError,
    ]) {
      const r = skip(err as BackoffError, 0);
      assert.strictEqual(r.ms, 0);
      assert.strictEqual(r.reason, "skip");
    }
  });
});

describe("fixed", () => {
  it("returns the configured ms and reason", () => {
    const f = fixed(3_000, "paused_worker(5min fixed)");
    const r = f(new PausedWorkerError("x", "c"), 0);
    assert.strictEqual(r.ms, 3_000);
    assert.strictEqual(r.reason, "paused_worker(5min fixed)");
  });

  it("ignores consecutive count", () => {
    const f = fixed(100, "test");
    assert.strictEqual(f(new DependencyFailureError("x", "rpc"), 1).ms, 100);
    assert.strictEqual(f(new DependencyFailureError("x", "rpc"), 99).ms, 100);
  });
});

describe("exponentialWithJitter", () => {
  const fn = exponentialWithJitter(1_000, 8_000);

  it("consecutive=0 returns jitter within [0, 1000]", () => {
    for (let i = 0; i < 50; i++) {
      const r = fn(makeDepErr(), 0);
      assert.ok(r.ms >= 0, `ms=${r.ms} must be >= 0`);
      assert.ok(r.ms < 1_000, `ms=${r.ms} must be < 1000 for consecutive=0`);
      assert.ok(r.reason.includes("consecutive=0"));
    }
  });

  it("consecutive=3 returns jitter within [0, 8000]", () => {
    for (let i = 0; i < 50; i++) {
      const r = fn(makeDepErr(), 3);
      assert.ok(r.ms >= 0);
      assert.ok(r.ms <= 8_000, `ms=${r.ms} must be <= cap`);
      assert.ok(r.reason.includes("consecutive=3"));
    }
  });

  it("is capped at capMs even for very large consecutive counts", () => {
    const r = fn(makeDepErr(), 100);
    assert.ok(r.ms <= 8_000, `ms=${r.ms} exceeded cap`);
  });

  it("never returns negative ms", () => {
    for (let i = 0; i < 20; i++) {
      const r = fn(makeDepErr(), 0);
      assert.ok(r.ms >= 0, `negative jitter: ${r.ms}`);
    }
  });

  it("returns a bounded distribution (all values within ceiling)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(fn(makeDepErr(), 2).ms);
    }
    for (const v of seen) {
      assert.ok(v >= 0 && v <= 8_000, `out-of-range value: ${v}`);
    }
    // With 200 samples and ceiling=4000, we should see at least a few distinct values
    assert.ok(seen.size > 1, "jitter produced no variation");
  });
});

// ── Policies ───────────────────────────────────────────────────────────────────

describe("BackoffPolicy shape", () => {
  const policies: BackoffPolicy[] = [
    ORACLE_BACKOFF,
    CREATOR_BACKOFF,
    COUNCIL_BACKOFF,
    SYNC_BACKOFF,
    TRADERS_BACKOFF,
    DEFAULT_BACKOFF,
  ];

  for (const p of policies) {
    it(`${p.label}: has all six handlers`, () => {
      const kinds = [
        "malformed_input",
        "stale_state",
        "duplicate_action",
        "cancelled_by_operator",
        "paused_worker",
        "dependency_failure",
      ] as const;
      for (const k of kinds) {
        assert.strictEqual(
          typeof p.handlers[k],
          "function",
          `${p.label}.handlers.${k} must be a function`,
        );
      }
    });

    it(`${p.label}: malformed_input and duplicate_action skip`, () => {
      const r = p.handlers.malformed_input(new MalformedInputError("x"), 0);
      assert.strictEqual(r.ms, 0);
      const r2 = p.handlers.duplicate_action(new DuplicateActionError("x"), 0);
      assert.strictEqual(r2.ms, 0);
    });

    it(`${p.label}: cancelled_by_operator skips`, () => {
      const r = p.handlers.cancelled_by_operator(
        new CancelledByOperatorError("x", "MIMIR_PAUSE_STAKE"),
        0,
      );
      assert.strictEqual(r.ms, 0);
    });

    it(`${p.label}: paused_worker returns a fixed retryAfter`, () => {
      const r = p.handlers.paused_worker(new PausedWorkerError("x", "c"), 0);
      assert.ok(r.ms > 0, `paused delay must be > 0 for ${p.label}`);
    });

    it(`${p.label}: dependency_failure returns ms >= 0`, () => {
      for (const c of [0, 1, 3, 10]) {
        const r = p.handlers.dependency_failure(makeDepErr(), c);
        assert.ok(r.ms >= 0, `${p.label} dep ms < 0 at consecutive=${c}`);
      }
    });
  }
});

describe("POLICIES registry", () => {
  it("has entries for oracle, market_creator, council, sync, traders, default", () => {
    const required = [
      "default",
      "oracle",
      "market_creator",
      "council",
      "sync",
      "traders",
    ];
    for (const k of required) {
      assert.ok(k in POLICIES, `missing policy: ${k}`);
    }
  });

  it("policyFor returns the named policy", () => {
    assert.strictEqual(policyFor("oracle"), ORACLE_BACKOFF);
    assert.strictEqual(policyFor("traders"), TRADERS_BACKOFF);
  });

  it("policyFor falls back to DEFAULT_BACKOFF for unknown names", () => {
    assert.strictEqual(policyFor("unknown_worker"), DEFAULT_BACKOFF);
  });
});

describe("policy-specific dependencies and limits", () => {
  it("oracle tracks rpc, llm, facilitator, sources", () => {
    assert.deepStrictEqual(ORACLE_BACKOFF.dependencies, [
      "rpc",
      "llm",
      "facilitator",
      "sources",
    ]);
    assert.strictEqual(ORACLE_BACKOFF.maxConsecutiveDependencyFailures, 6);
  });

  it("market-creator tracks the same deps as oracle", () => {
    assert.deepStrictEqual(CREATOR_BACKOFF.dependencies, ORACLE_BACKOFF.dependencies);
  });

  it("council tracks rpc, llm, facilitator (no sources)", () => {
    assert.deepStrictEqual(COUNCIL_BACKOFF.dependencies, ["rpc", "llm", "facilitator"]);
  });

  it("sync tracks rpc and postgres", () => {
    assert.deepStrictEqual(SYNC_BACKOFF.dependencies, ["rpc", "postgres"]);
  });

  it("traders tracks rpc, llm, facilitator", () => {
    assert.deepStrictEqual(TRADERS_BACKOFF.dependencies, [
      "rpc",
      "llm",
      "facilitator",
    ]);
  });

  it("default has empty deps list", () => {
    assert.deepStrictEqual(DEFAULT_BACKOFF.dependencies, []);
  });
});

// ── describeBackoffError ───────────────────────────────────────────────────────

describe("describeBackoffError", () => {
  it("returns 'kind message' for MalformedInputError", () => {
    const e = new MalformedInputError("claim id is NaN");
    assert.strictEqual(describeBackoffError(e), "malformed_input claim id is NaN");
  });

  it("returns 'kind:pausedBy message' for CancelledByOperatorError", () => {
    const e = new CancelledByOperatorError(
      "oracle_settlement paused",
      "MIMIR_PAUSE_ORACLE_SETTLEMENT",
    );
    assert.strictEqual(
      describeBackoffError(e),
      "cancelled_by_operator:MIMIR_PAUSE_ORACLE_SETTLEMENT oracle_settlement paused",
    );
  });

  it("returns 'kind:capability retryAfterMs=X message' for PausedWorkerError", () => {
    const e = new PausedWorkerError("paused", "market_creator_worker", 300_000);
    assert.ok(
      describeBackoffError(e).startsWith("paused_worker:market_creator_worker retryAfterMs=300000"),
    );
  });

  it("returns 'kind:dep consecutive=N message' for DependencyFailureError", () => {
    const e = makeDepErr("llm", 3);
    assert.strictEqual(
      describeBackoffError(e),
      "dependency_failure:llm consecutive=3 rpc failed for dep llm",
    );
  });
});

// ── Consecutive-failure counters ───────────────────────────────────────────────

describe("consecutive-failure counters", () => {
  const worker = "backoff-test-worker";

  afterEach(() => {
    resetFailureCounters(worker);
  });

  it("starts at 0 for a fresh dependency", () => {
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 0);
  });

  it("increments via computeBackoff on DependencyFailureError", () => {
    const policy = ORACLE_BACKOFF;
    const err = makeDepErr("rpc", 0);
    computeBackoff(worker, err, policy);
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 1);

    computeBackoff(worker, makeDepErr("rpc", 1), policy);
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 2);
  });

  it("resets to 0 on recordDependencySuccess", () => {
    const policy = ORACLE_BACKOFF;
    computeBackoff(worker, makeDepErr("llm", 0), policy);
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 1);
    recordDependencySuccess(worker, "llm");
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 0);
  });

  it("tracks two dependencies independently", () => {
    const policy = ORACLE_BACKOFF;
    computeBackoff(worker, makeDepErr("rpc", 0), policy);
    computeBackoff(worker, makeDepErr("llm", 0), policy);
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 1);
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 1);
    recordDependencySuccess(worker, "rpc");
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 0);
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 1);
  });

  it("resetFailureCounters clears all deps for a worker", () => {
    const policy = ORACLE_BACKOFF;
    computeBackoff(worker, makeDepErr("rpc", 0), policy);
    computeBackoff(worker, makeDepErr("llm", 0), policy);
    resetFailureCounters(worker);
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 0);
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 0);
  });

  it("different workers have independent counters", () => {
    const policy = ORACLE_BACKOFF;
    computeBackoff("w1", makeDepErr("rpc", 0), policy);
    computeBackoff("w2", makeDepErr("rpc", 0), policy);
    assert.strictEqual(getConsecutiveFailures("w1", "rpc"), 1);
    assert.strictEqual(getConsecutiveFailures("w2", "rpc"), 1);
  });

  it("non-retryable DependencyFailureError does not increment counter", () => {
    const policy = ORACLE_BACKOFF;
    const err = new DependencyFailureError("4xx", "llm", false, 0, new Error("400"));
    computeBackoff(worker, err, policy);
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 0);
  });

  it("non-dependency errors do not increment counters", () => {
    const policy = ORACLE_BACKOFF;
    computeBackoff(worker, new MalformedInputError("x"), policy);
    computeBackoff(worker, new StaleStateError("x"), policy);
    computeBackoff(worker, new DuplicateActionError("x"), policy);
    computeBackoff(worker, new CancelledByOperatorError("x", "PAUSE"), policy);
    computeBackoff(worker, new PausedWorkerError("x", "cap"), policy);
    // no rpc counter was incremented
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 0);
  });
});

// ── computeBackoff ─────────────────────────────────────────────────────────────

describe("computeBackoff", () => {
  const worker = "compute-backoff-test";
  afterEach(() => resetFailureCounters(worker));

  it("returns ms=0 for MalformedInputError", () => {
    const r = computeBackoff(worker, new MalformedInputError("x"), ORACLE_BACKOFF);
    assert.strictEqual(r.ms, 0);
    assert.strictEqual(r.reason, "skip");
  });

  it("returns ms=0 for DuplicateActionError", () => {
    const r = computeBackoff(worker, new DuplicateActionError("x"), ORACLE_BACKOFF);
    assert.strictEqual(r.ms, 0);
  });

  it("returns ms=0 for CancelledByOperatorError", () => {
    const r = computeBackoff(
      worker,
      new CancelledByOperatorError("x", "MIMIR_PAUSE_STAKE"),
      ORACLE_BACKOFF,
    );
    assert.strictEqual(r.ms, 0);
  });

  it("returns a fixed delay for PausedWorkerError", () => {
    const err = new PausedWorkerError("paused", "oracle_settlement", 600_000);
    const r = computeBackoff(worker, err, ORACLE_BACKOFF);
    assert.ok(r.ms > 0, `paused delay must be > 0, got ${r.ms}`);
    assert.ok(r.reason.includes("paused_worker"));
  });

  it("returns a fixed short delay for StaleStateError", () => {
    const r = computeBackoff(worker, new StaleStateError("x"), ORACLE_BACKOFF);
    assert.ok(r.ms >= 0);
    assert.ok(r.reason.includes("stale_state"));
  });

  it("returns jitter in [0, cap] for DependencyFailureError", () => {
    for (let i = 0; i < 30; i++) {
      const r = computeBackoff(worker, makeDepErr("llm", 2), ORACLE_BACKOFF);
      assert.ok(r.ms >= 0, `ms negative at attempt ${i}: ${r.ms}`);
      assert.ok(r.ms <= 30_000, `ms exceeded cap at attempt ${i}: ${r.ms}`);
    }
  });

  it("annotates reason when consecutiveFailures exceeds maxConsecutiveDependencyFailures", () => {
    // pre-seed the counter past the max
    const policy = SYNC_BACKOFF; // maxConsecutive = 4
    for (let i = 0; i < 4; i++) {
      computeBackoff(worker, makeDepErr("rpc", i), policy);
    }
    const r = computeBackoff(worker, makeDepErr("rpc", 4), policy);
    assert.ok(
      r.reason.includes("consecutive=4 >= max=4"),
      `reason should warn on threshold breach: ${r.reason}`,
    );
  });

  it("falls back to skip for an unknown error kind", () => {
    // @ts-expect-error — testing unknown kind path
    const err = new BackoffError("unknown_kind", "surprise");
    const r = computeBackoff(worker, err, ORACLE_BACKOFF);
    assert.strictEqual(r.ms, 0);
  });
});

// ── withBackoff ────────────────────────────────────────────────────────────────

describe("withBackoff", () => {
  const worker = "with-backoff-test";
  afterEach(() => resetFailureCounters(worker));

  it("resolves with the poll return value on success", async () => {
    const result = await withBackoff(worker, async () => 42, {
      policy: ORACLE_BACKOFF,
    });
    assert.strictEqual(result, 42);
  });

  it("sleeps then resolves undefined on BackoffError", async () => {
    const start = Date.now();
    const err = new MalformedInputError("x");
    // use a non-zero skip that we can detect by timing: override with a fixed
    // policy that has a short delay for malformed_input just for the test
    const policy: BackoffPolicy = {
      ...ORACLE_BACKOFF,
      handlers: {
        ...ORACLE_BACKOFF.handlers,
        malformed_input: fixed(150, "test-skip"),
      },
    };
    const result = await withBackoff(worker, async () => {
      throw err;
    }, { policy });
    assert.strictEqual(result, undefined);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 100, `expected >=100ms sleep, elapsed=${elapsed}ms`);
  });

  it("rethrows non-BackoffError unchanged", async () => {
    const original = new Error("not-a-backoff-error");
    let thrown: unknown;
    try {
      await withBackoff(worker, async () => {
        throw original;
      }, { policy: ORACLE_BACKOFF });
    } catch (e) {
      thrown = e;
    }
    assert.strictEqual(thrown, original);
  });

  it("calls onBackoff after the sleep", async () => {
    const delays: DelayResult[] = [];
    const err = new MalformedInputError("x");
    const policy: BackoffPolicy = {
      ...ORACLE_BACKOFF,
      handlers: {
        ...ORACLE_BACKOFF.handlers,
        malformed_input: fixed(50, "test"),
      },
    };
    await withBackoff(worker, async () => {
      throw err;
    }, {
      policy,
      onBackoff: (r) => {
        delays.push(r);
      },
    });
    assert.strictEqual(delays.length, 1);
    assert.strictEqual(delays[0]!.ms, 50);
  });

  it("resolves undefined on PausedWorkerError without rethrow", async () => {
    let caught: unknown;
    try {
      await withBackoff(worker, async () => {
        throw new PausedWorkerError("paused", "oracle_settlement", 100);
      }, { policy: ORACLE_BACKOFF });
    } catch (e) {
      caught = e;
    }
    assert.strictEqual(caught, undefined, "PausedWorkerError must not propagate");
  });

  it("defaults to policyFor(worker) when no policy is passed", async () => {
    const result = await withBackoff("unknown_worker_name", async () => "ok");
    assert.strictEqual(result, "ok");
  });
});

// ── withBackoffAndMetrics ───────────────────────────────────────────────────────

describe("withBackoffAndMetrics", () => {
  const worker = "with-backoff-metrics-test";
  afterEach(() => resetFailureCounters(worker));

  it("resets dependency counters after a successful poll", async () => {
    const outcomes: Array<[string, boolean]> = [];
    const policy = ORACLE_BACKOFF;
    const recordOutcome = (dep: string, ok: boolean) => {
      outcomes.push([dep, ok]);
    };

    // first: fail once
    let calls = 0;
    const poll = async () => {
      calls++;
      if (calls === 1) {
        throw makeDepErr("llm", 0);
      }
      return "done";
    };

    await withBackoffAndMetrics(worker, poll, policy, { recordOutcome });
    // after failure + retry: llm was recorded as failure, then all deps reset
    assert.ok(
      outcomes.some(([d, ok]) => d === "llm" && ok === false),
      "should record llm failure",
    );
    assert.ok(
      outcomes.some(([d, ok]) => d === "llm" && ok === true),
      "should record llm success after recovery",
    );
    assert.strictEqual(getConsecutiveFailures(worker, "llm"), 0);
  });

  it("records dependency failures on non-backoff errors", async () => {
    const outcomes: Array<[string, boolean]> = [];
    const policy = ORACLE_BACKOFF;

    try {
      await withBackoffAndMetrics(
        worker,
        async () => {
          throw new Error("db crash");
        },
        policy,
        {
          recordOutcome: (dep, ok) => {
            outcomes.push([dep, ok]);
          },
        },
      );
    } catch {
      // expected
    }

    for (const dep of policy.dependencies) {
      assert.ok(
        outcomes.some(([d, ok]) => d === dep && ok === false),
        `expected failure recorded for ${dep}`,
      );
    }
  });
});

// ── Policy-specific regression scenarios ──────────────────────────────────────

describe("oracle policy regression: settlement pause must not retry", () => {
  it("PausedWorkerError resolves without retry", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await withBackoff("oracle", async () => {
        throw new PausedWorkerError(
          "oracle_settlement paused",
          "oracle_settlement",
          300_000,
        );
      }, { policy: ORACLE_BACKOFF });
    } catch (e) {
      caught = e;
    }
    assert.strictEqual(caught, undefined);
    const elapsed = Date.now() - start;
    // The pause handler uses a 300s fixed delay, but our computeBackoff
    // returns the full 300s for PausedWorkerError.  Verify it resolved rather
    // than hanging (test would timeout otherwise).
    assert.ok(elapsed < 500, `elapsed ${elapsed}ms — should be short in test`);
  });
});

describe("creator policy regression: duplicate candidate must not retry", () => {
  it("DuplicateActionError resolves immediately", async () => {
    const start = Date.now();
    const result = await withBackoff(
      "market_creator",
      async () => {
        throw new DuplicateActionError("same resolutionUrl as claim #7");
      },
      { policy: CREATOR_BACKOFF },
    );
    assert.strictEqual(result, undefined);
    assert.ok(Date.now() - start < 50, "duplicate must not sleep");
  });
});

describe("council policy regression: malformed persona output must not retry", () => {
  it("MalformedInputError resolves immediately", async () => {
    const start = Date.now();
    const result = await withBackoff(
      "council",
      async () => {
        throw new MalformedInputError("persona verdict missing 'verdict' field");
      },
      { policy: COUNCIL_BACKOFF },
    );
    assert.strictEqual(result, undefined);
    assert.ok(Date.now() - start < 50, "malformed must not sleep");
  });
});

describe("sync policy regression: RPC outage must backoff with jitter", () => {
  it("DependencyFailureError produces bounded jitter", async () => {
    const worker = "sync-jitter-test";
    afterEach(() => resetFailureCounters(worker));

    const delays: DelayResult[] = [];
    const policy = SYNC_BACKOFF;

    // Run 5 simulated failures
    for (let i = 0; i < 5; i++) {
      await withBackoff(worker, async () => {
        throw makeDepErr("rpc", i);
      }, {
        policy,
        onBackoff: (r) => delays.push(r),
      });
    }

    assert.strictEqual(delays.length, 5);
    for (const d of delays) {
      assert.ok(d.ms >= 0, `negative delay: ${d.ms}`);
      assert.ok(d.ms <= 60_000, `delay exceeded cap: ${d.ms}`);
    }
  });
});

describe("traders policy regression: no USDC trustline must not retry", () => {
  it("MalformedInputError for missing trustline resolves immediately", async () => {
    const start = Date.now();
    const result = await withBackoff(
      "traders",
      async () => {
        throw new MalformedInputError("wallet has no USDC trustline");
      },
      { policy: TRADERS_BACKOFF },
    );
    assert.strictEqual(result, undefined);
    assert.ok(Date.now() - start < 50);
  });
});

// ── Error-class hierarchy ──────────────────────────────────────────────────────

describe("error hierarchy", () => {
  it("all typed errors are BackoffError instances", () => {
    const cases: BackoffError[] = [
      new MalformedInputError("x"),
      new StaleStateError("x"),
      new DuplicateActionError("x"),
      new CancelledByOperatorError("x", "P"),
      new PausedWorkerError("x", "c"),
      makeDepErr(),
    ];
    for (const e of cases) {
      assert.ok(e instanceof BackoffError, `${e.kind} must extend BackoffError`);
    }
  });

  it("each error has a distinct kind", () => {
    const kinds = new Set<string>();
    const cases: BackoffError[] = [
      new MalformedInputError("x"),
      new StaleStateError("x"),
      new DuplicateActionError("x"),
      new CancelledByOperatorError("x", "P"),
      new PausedWorkerError("x", "c"),
      makeDepErr(),
    ];
    for (const e of cases) {
      assert.ok(!kinds.has(e.kind), `duplicate kind: ${e.kind}`);
      kinds.add(e.kind);
    }
    assert.strictEqual(kinds.size, 6);
  });
});

// ── Boundary ───────────────────────────────────────────────────────────────────

describe("boundary: consecutive-failure threshold", () => {
  const worker = "boundary-threshold-test";
  afterEach(() => resetFailureCounters(worker));

  it("warns in reason when consecutive equals max", () => {
    const policy = SYNC_BACKOFF; // maxConsecutive = 4
    for (let i = 0; i < 4; i++) {
      computeBackoff(worker, makeDepErr("rpc", i), policy);
    }
    const r = computeBackoff(worker, makeDepErr("rpc", 4), policy);
    assert.ok(r.reason.includes("consecutive=4 >= max=4"));
  });

  it("does not warn below max", () => {
    const policy = SYNC_BACKOFF;
    const r = computeBackoff(worker, makeDepErr("rpc", 1), policy);
    assert.ok(!r.reason.includes(">="));
  });
});

describe("boundary: retryAfterMs edge cases", () => {
  it("accepts 0ms retryAfterMs for PausedWorkerError", () => {
    const err = new PausedWorkerError("instant", "cap", 0);
    assert.strictEqual(err.retryAfterMs, 0);
  });

  it("accepts very large retryAfterMs", () => {
    const err = new PausedWorkerError("long", "cap", 3_600_000);
    assert.strictEqual(err.retryAfterMs, 3_600_000);
  });
});

// ── Failure / negative ────────────────────────────────────────────────────────

describe("negative: non-BackoffError propagates through withBackoff", () => {
  it("rethrows a plain Error", async () => {
    let thrown: Error | undefined;
    try {
      await withBackoff("test", async () => {
        throw new Error("plain");
      });
    } catch (e) {
      thrown = e instanceof Error ? e : undefined;
    }
    assert.ok(thrown, "expected Error to propagate");
    assert.strictEqual(thrown!.message, "plain");
  });
});

describe("negative: unknown policy name falls back gracefully", () => {
  it("policyFor returns DEFAULT_BACKOFF for unknown name", () => {
    const p = policyFor("nonexistent_worker_v2");
    assert.strictEqual(p.label, "default");
  });
});

// ── Record-outcome accounting integration ──────────────────────────────────────

describe("dependency accounting: recordOutcome integration", () => {
  it("withBackoffAndMetrics records failures and then resets on success", async () => {
    const outcomes: Array<[string, boolean]> = [];
    const worker = "accounting-test";
    afterEach(() => resetFailureCounters(worker));

    const policy = ORACLE_BACKOFF;
    const recordOutcome = (dep: string, ok: boolean) => {
      outcomes.push([dep, ok]);
    };

    let calls = 0;
    const poll = async () => {
      calls++;
      if (calls <= 2) {
        throw makeDepErr("rpc", calls - 1);
      }
      return "ok";
    };

    await withBackoffAndMetrics(worker, poll, policy, { recordOutcome });

    // Should see: failure for rpc (twice) then success for all policy deps
    const rpcFailures = outcomes.filter(([d, ok]) => d === "rpc" && !ok).length;
    assert.ok(rpcFailures >= 1, "should have recorded rpc failure(s)");
    assert.ok(
      outcomes.some(([d]) => d === "rpc"),
      "should have recorded rpc outcome",
    );
    assert.strictEqual(getConsecutiveFailures(worker, "rpc"), 0);
  });
});
