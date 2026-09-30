/**
 * Shared worker backoff policies.
 *
 * Defines typed failure classes and per-worker backoff strategies so that
 * oracle, creator, council, sync, and trader loops all degrade safely under
 * the same operational contract.  Funded-state safety is preserved by:
 *
 *  - never silently retrying a malformed or duplicate input,
 *  - honouring operator pauses immediately,
 *  - bounding dependency-failure retries so a storm does not pile on,
 *  - logging the reason and backoff class on every skip so an operator can
 *    reconstruct what happened from the worker log alone.
 *
 * Usage
 * -----
 * ```ts
 * import { withBackoff, oraclePolicy } from "@/lib/ops/backoff-policies";
 *
 * const wrappedPoll = withBackoff("oracle", poll, oraclePolicy);
 * // pass wrappedPoll to reportingPoll(..., poll)
 * ```
 */

// ── Typed failure classes ──────────────────────────────────────────────────────

/**
 * Base class.  `cause` is preserved for structured logging; the message is
 * intentionally short because the full detail lives in the log line that
 * throws this.
 */
export class BackoffError extends Error {
  readonly kind: string;
  readonly cause?: unknown;
  constructor(kind: string, message: string, cause?: unknown) {
    super(message);
    this.kind = kind;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  toJSON() {
    return { kind: this.kind, message: this.message };
  }
}

/**
 * The input was structurally invalid: malformed on-chain data, unparsable
 * LLM output, missing required field, bad env value.
 *
 * Backoff: **skip immediately** — retrying a malformed input cannot succeed.
 */
export class MalformedInputError extends BackoffError {
  constructor(message: string, cause?: unknown) {
    super("malformed_input", message, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The on-chain or cached state the worker needs is stale: a read-index lag,
 * an evidence snapshot older than the configured freshness window, or a claim
 * state mismatch between the contract and the local DB.
 *
 * Backoff: **short fixed delay** (configurable, default 5 s) — the stale
 * condition usually self-resolves on the next poll cycle.
 */
export class StaleStateError extends BackoffError {
  constructor(message: string, cause?: unknown) {
    super("stale_state", message, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The worker is about to perform an action it has already performed for this
 * claim/idempotency key: a duplicate challenge_claim, a duplicate resolve, or
 * a double-create detected before the on-chain call.
 *
 * Backoff: **skip immediately** — the action is idempotent and already done.
 */
export class DuplicateActionError extends BackoffError {
  constructor(message: string, cause?: unknown) {
    super("duplicate_action", message, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The operator has explicitly cancelled or paused this action or worker.
 * `pausedBy` names the controlling env var or flag so the log line is
 * actionable without a trace.
 *
 * Backoff: **skip immediately** — operator intent overrides any retry.
 */
export class CancelledByOperatorError extends BackoffError {
  readonly pausedBy: string;
  constructor(message: string, pausedBy: string, cause?: unknown) {
    super("cancelled_by_operator", message, cause);
    this.pausedBy = pausedBy;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  toJSON() {
    return { ...super.toJSON(), pausedBy: this.pausedBy };
  }
}

/**
 * The worker itself has been paused (e.g. MIMIR_PAUSE_ORACLE_SETTLEMENT).
 *
 * Backoff: **fixed retry-after** (default 300 s / 5 min) — the worker
 * remains alive and heartbeating; it will resume automatically when the flag
 * is lifted without any deploy or restart.
 */
export class PausedWorkerError extends BackoffError {
  readonly capability: string;
  readonly retryAfterMs: number;
  constructor(message: string, capability: string, retryAfterMs = 300_000) {
    super("paused_worker", message);
    this.capability = capability;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  toJSON() {
    return {
      ...super.toJSON(),
      capability: this.capability,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/**
 * An external dependency failed: Soroban RPC, Horizon, the LLM provider,
 * the x402 facilitator, or the Postgres read-index.  `dependency` is one of
 * the keys in TRACKED_DEPENDENCIES so the failure can be accounted.
 *
 * Backoff: **exponential with full jitter** (cap configurable, default 30 s).
 * Consecutive failures double the ceiling until it hits the cap, then stay
 * there.  A success resets the counter.
 */
export class DependencyFailureError extends BackoffError {
  readonly dependency: string;
  readonly retryable: boolean;
  readonly consecutiveFailures: number;
  constructor(
    message: string,
    dependency: string,
    retryable = true,
    consecutiveFailures = 0,
    cause?: unknown,
  ) {
    super("dependency_failure", message, cause);
    this.dependency = dependency;
    this.retryable = retryable;
    this.consecutiveFailures = consecutiveFailures;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  toJSON() {
    return {
      ...super.toJSON(),
      dependency: this.dependency,
      retryable: this.retryable,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

// ── Backoff delay functions ────────────────────────────────────────────────────

export interface DelayResult {
  ms: number;
  reason: string;
}

export type DelayFn = (err: BackoffError, consecutiveFailures: number) => DelayResult;

const skip: DelayFn = (_err, _consecutive) => ({ ms: 0, reason: "skip" });

const fixed = (ms: number, label: string): DelayFn =>
  () => ({ ms, reason: label });

const exponentialWithJitter = (baseMs: number, capMs: number): DelayFn =>
  (_err, consecutive) => {
    const exp = Math.min(consecutive, 10);
    const ceiling = Math.min(baseMs * Math.pow(2, exp), capMs);
    const jitter = Math.floor(Math.random() * ceiling);
    return { ms: jitter, reason: `exponential_with_jitter(consecutive=${consecutive}, ceiling=${ceiling}ms)` };
  };

// ── Policy shape ───────────────────────────────────────────────────────────────

export interface BackoffPolicy {
  /** Human-readable name for log lines. */
  label: string;
  /** The backoff class for each failure kind. */
  handlers: {
    malformed_input: DelayFn;
    stale_state: DelayFn;
    duplicate_action: DelayFn;
    cancelled_by_operator: DelayFn;
    paused_worker: DelayFn;
    dependency_failure: DelayFn;
  };
  /** Maximum consecutive dependency failures before escalating (logged as warn). */
  maxConsecutiveDependencyFailures: number;
  /** Dependency names this worker cares about (for accounting). */
  dependencies: readonly string[];
}

// ── Shared per-worker policies ────────────────────────────────────────────────

export const DEFAULT_BACKOFF: BackoffPolicy = {
  label: "default",
  maxConsecutiveDependencyFailures: 6,
  dependencies: [],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(5_000, "stale_state(5s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(1_000, 30_000),
  },
};

export const ORACLE_BACKOFF: BackoffPolicy = {
  label: "oracle",
  maxConsecutiveDependencyFailures: 6,
  dependencies: ["rpc", "llm", "facilitator", "sources"],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(5_000, "stale_state(5s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(1_000, 30_000),
  },
};

export const CREATOR_BACKOFF: BackoffPolicy = {
  label: "market-creator",
  maxConsecutiveDependencyFailures: 6,
  dependencies: ["rpc", "llm", "facilitator", "sources"],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(5_000, "stale_state(5s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(1_000, 30_000),
  },
};

export const COUNCIL_BACKOFF: BackoffPolicy = {
  label: "council",
  maxConsecutiveDependencyFailures: 8,
  dependencies: ["rpc", "llm", "facilitator"],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(5_000, "stale_state(5s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(1_500, 30_000),
  },
};

export const SYNC_BACKOFF: BackoffPolicy = {
  label: "sync",
  maxConsecutiveDependencyFailures: 4,
  dependencies: ["rpc", "postgres"],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(3_000, "stale_state(3s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(2_000, 60_000),
  },
};

export const TRADERS_BACKOFF: BackoffPolicy = {
  label: "traders",
  maxConsecutiveDependencyFailures: 6,
  dependencies: ["rpc", "llm", "facilitator"],
  handlers: {
    malformed_input:            skip,
    stale_state:                fixed(5_000, "stale_state(5s fixed)"),
    duplicate_action:           skip,
    cancelled_by_operator:      skip,
    paused_worker:              fixed(300_000, "paused_worker(5min fixed)"),
    dependency_failure:         exponentialWithJitter(1_000, 30_000),
  },
};

export const POLICIES: Record<string, BackoffPolicy> = {
  default:            DEFAULT_BACKOFF,
  oracle:             ORACLE_BACKOFF,
  market_creator:     CREATOR_BACKOFF,
  council:            COUNCIL_BACKOFF,
  sync:               SYNC_BACKOFF,
  traders:            TRADERS_BACKOFF,
};

export function policyFor(name: string): BackoffPolicy {
  return POLICIES[name] ?? DEFAULT_BACKOFF;
}

// ── Per-worker consecutive-failure counters (in-memory, process-scoped) ─────────

interface FailureCounters {
  [dependency: string]: number;
}

const counters = new Map<string, FailureCounters>();

function countersFor(worker: string): FailureCounters {
  let entry = counters.get(worker);
  if (!entry) {
    entry = {};
    counters.set(worker, entry);
  }
  return entry;
}

export function resetFailureCounters(worker: string): void {
  counters.delete(worker);
}

export function getConsecutiveFailures(worker: string, dependency: string): number {
  return countersFor(worker)[dependency] ?? 0;
}

// ── Public helpers ─────────────────────────────────────────────────────────────

/**
 * Describe a BackoffError in a single log-safe line.
 */
export function describeBackoffError(err: BackoffError): string {
  if (err instanceof CancelledByOperatorError) {
    return `${err.kind}:${err.pausedBy} ${err.message}`;
  }
  if (err instanceof PausedWorkerError) {
    return `${err.kind}:${err.capability} retryAfterMs=${err.retryAfterMs} ${err.message}`;
  }
  if (err instanceof DependencyFailureError) {
    return `${err.kind}:${err.dependency} consecutive=${err.consecutiveFailures} ${err.message}`;
  }
  return `${err.kind} ${err.message}`;
}

/**
 * Apply the matching handler, update the consecutive-failure counter, and
 * return the delay to wait before the next attempt (or 0 to skip).
 */
export function computeBackoff(
  worker: string,
  err: BackoffError,
  policy: BackoffPolicy,
): DelayResult {
  const kind = err.kind as keyof typeof policy.handlers;
  const handler = policy.handlers[kind] ?? skip;

  if (err instanceof DependencyFailureError) {
    const c = countersFor(worker);
    const prev = c[err.dependency] ?? 0;
    const next = err.retryable ? prev + 1 : 0;
    c[err.dependency] = next;

    if (next >= policy.maxConsecutiveDependencyFailures) {
      return {
        ms: handler(err, next).ms,
        reason: `${handler(err, next).reason} [consecutive=${next} >= max=${policy.maxConsecutiveDependencyFailures}]`,
      };
    }
    return handler(err, next);
  }

  // non-dependency errors do not increment the counter
  return handler(err, 0);
}

/**
 * Mark a successful dependency call so the consecutive counter resets.
 */
export function recordDependencySuccess(worker: string, dependency: string): void {
  const c = countersFor(worker);
  if (c[dependency] !== undefined) {
    delete c[dependency];
  }
}

/**
 * Wrap a poll function with backoff handling.
 *
 * On a BackoffError the wrapper:
 *   1. Logs the failure kind, reason, and delay.
 *   2. Sleeps for the computed delay.
 *   3. Resolves (the outer reportingPoll loop retries next cycle).
 *
 * Non-BackoffErrors propagate unchanged so reportingPoll's existing catch
 * can record them as beat errors.
 *
 * `onBackoff` is called after the sleep with the delay result so the caller
 * can record dependency-failure metrics (e.g. recordOutcome) without
 * coupling backoff to ops.
 */
export async function withBackoff(
  worker: string,
  poll: () => Promise<unknown>,
  opts: {
    policy?: BackoffPolicy;
    onBackoff?: (result: DelayResult, err: BackoffError) => void;
  } = {},
): Promise<unknown> {
  const policy = opts.policy ?? policyFor(worker);
  try {
    return await poll();
  } catch (err) {
    if (!(err instanceof BackoffError)) {
      throw err;
    }
    const result = computeBackoff(worker, err, policy);
    console.warn(
      `[backoff:${worker}] ${describeBackoffError(err)} — backing off ${result.ms}ms (${result.reason})`,
    );
    if (result.ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, result.ms));
    }
    opts.onBackoff?.(result, err);
    // Resolve silently: the outer reportingPoll loop retries next cycle.
    return undefined;
  }
}

/**
 * Convenience: wrap `poll` so dependency successes reset their counter and
 * reportingPoll's beat records the outcome.
 *
 * ```ts
 * const wrappedPoll = withBackoffAndMetrics("oracle", poll, ORACLE_BACKOFF, {
 *   recordOutcome: (dep, ok) => recordOutcome(dep, ok),
 * });
 * reportingPoll("oracle", "oracle", POLL_INTERVAL_MS / 1000, wrappedPoll);
 * ```
 */
export async function withBackoffAndMetrics(
  worker: string,
  poll: () => Promise<unknown>,
  policy: BackoffPolicy,
  opts: {
    recordOutcome?: (dependency: string, ok: boolean, nowMs?: number) => Promise<void> | void;
  } = {},
): Promise<unknown> {
  try {
    const result = await withBackoff(worker, poll, {
      policy,
      onBackoff: (delayResult, err) => {
        if (err instanceof DependencyFailureError && opts.recordOutcome) {
          opts.recordOutcome(err.dependency, false);
        }
      },
    });
    // A successful poll resets all dependency counters for this worker.
    for (const dep of policy.dependencies) {
      recordDependencySuccess(worker, dep);
      opts.recordOutcome?.(dep, true);
    }
    return result;
  } catch (err) {
    // Non-backoff error — report dependency failures as unknown if relevant.
    if (opts.recordOutcome) {
      for (const dep of policy.dependencies) {
        opts.recordOutcome(dep, false);
      }
    }
    throw err;
  }
}
