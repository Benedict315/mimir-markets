/**
 * Health signals → alarms.
 *
 * A pure evaluator, deliberately separate from the code that collects the
 * signals, so the thresholds can be tested without a database or a chain.
 *
 * Three rules learned the hard way, each encoded below:
 *
 *  1. **Absence of signal is not health.** A worker that has never reported is
 *     `critical`, not `unknown`. The classic monitoring failure is a dashboard
 *     that goes green when the reporter dies.
 *  2. **A rate needs a sample size.** One failed RPC call out of one is a 100%
 *     failure rate and pages someone at 3am for nothing. Rates below
 *     `MIN_SAMPLES` are reported but never alarm.
 *  3. **Latency is measured on what has NOT finished.** An average over settled
 *     markets looks best exactly when settlement is stuck, because the stuck ones
 *     are not in the average. So the settlement alarm reads the age of the oldest
 *     overdue market instead.
 */

import { isTraceId } from "./trace-id";

export type Severity = "ok" | "warn" | "critical";

/** Re-exported so a collector can validate an id it did not mint itself. */
export { isTraceId };

export interface Alarm {
  /** Stable id so an alert route can dedupe and route it. */
  id: string;
  severity: Severity;
  /** What is wrong, in one line, for a pager. */
  message: string;
  /** The measured value and the threshold it crossed, for the graph. */
  observed: number;
  threshold: number;
  unit: "seconds" | "blocks" | "count" | "ratio";
}

export interface WorkerBeat {
  name: string;
  /** Epoch ms of the last heartbeat, or null if the worker has never reported. */
  lastBeatAtMs: number | null;
  /** Set when the worker reported a beat but with an error attached. */
  lastError?: string;
  /**
   * How often this worker is supposed to report.
   *
   * Required for anything slower than the default bar: the market creator runs
   * every six hours, so judging it against a three-minute staleness threshold
   * would alarm permanently and train everyone to ignore worker alarms.
   */
  expectedIntervalSec?: number;
  /**
   * Trace id of the cycle that produced this beat, when it ran inside one.
   *
   * This is what makes the alarm actionable: "the oracle is failing" becomes
   * "the oracle is failing, cycle `mh_…`, here are its spans" without reconstructing
   * a time window. Absent for a beat written outside a cycle, which is the honest
   * reading — an invented id would point an operator at the wrong logs.
   */
  lastTraceId?: string;
}

export interface FailureWindow {
  attempts: number;
  failures: number;
}

export interface HealthSnapshot {
  workers: WorkerBeat[];
  /**
   * Seconds since the read-index last completed a sync, or null if it never has.
   *
   * Freshness rather than block lag, because the index syncs by claim count and
   * has no block cursor to compare against a chain head. Freshness is also the
   * signal that survives a change of sync strategy.
   */
  indexLastSyncAgeSec: number | null;
  /** Age of the oldest job still waiting in a worker queue. */
  oldestQueuedJobAgeSec: number;
  /** Age of the oldest market whose deadline has passed and is still unsettled. */
  oldestOverdueSettlementSec: number;
  /** Markets past deadline awaiting the oracle. */
  oracleBacklog: number;
  rpc: FailureWindow;
  facilitator: FailureWindow;
  /** Research source fetches — a soft dependency, so warn only. */
  sources: FailureWindow;
  /**
   * Decimal USDC balances for the worker agents.
   * Keyed by the worker role (e.g., "oracle").
   */
  agentBalancesUsdc: Record<string, number | null>;
}

export interface Thresholds {
  workerStaleWarnSec: number;
  workerStaleCriticalSec: number;
  indexStaleWarnSec: number;
  indexStaleCriticalSec: number;
  queueLagWarnSec: number;
  queueLagCriticalSec: number;
  settlementWarnSec: number;
  settlementCriticalSec: number;
  oracleBacklogWarn: number;
  oracleBacklogCritical: number;
  rpcFailureWarn: number;
  rpcFailureCritical: number;
  facilitatorFailureWarn: number;
  facilitatorFailureCritical: number;
  sourceFailureWarn: number;
  agentBalanceWarnUsdc: number;
  agentBalanceCriticalUsdc: number;
}

/**
 * The index syncs about once a minute, so five minutes stale is noticeable but
 * survivable and half an hour means the explorer is visibly wrong.
 *
 * Settlement thresholds are generous because the oracle batches: 15 minutes past
 * a deadline is late, an hour means a human should look.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  workerStaleWarnSec: 180,
  workerStaleCriticalSec: 900,
  indexStaleWarnSec: 300,
  indexStaleCriticalSec: 1800,
  queueLagWarnSec: 300,
  queueLagCriticalSec: 1800,
  settlementWarnSec: 900,
  settlementCriticalSec: 3600,
  oracleBacklogWarn: 10,
  oracleBacklogCritical: 50,
  rpcFailureWarn: 0.1,
  rpcFailureCritical: 0.5,
  facilitatorFailureWarn: 0.05,
  facilitatorFailureCritical: 0.25,
  sourceFailureWarn: 0.3,
  agentBalanceWarnUsdc: 1,
  agentBalanceCriticalUsdc: 0.1,
};

/**
 * Below this, a failure ratio is noise. Rule 2: one failure out of one is not a
 * 100% outage, and paging on it trains people to ignore the pager.
 */
export const MIN_SAMPLES = 20;

/** Ratio of a window, or 0 when nothing was attempted. */
export function failureRatio(window: FailureWindow): number {
  if (window.attempts <= 0) return 0;
  return window.failures / window.attempts;
}

function threshold(
  id: string,
  observed: number,
  warn: number,
  critical: number,
  unit: Alarm["unit"],
  message: (level: Severity) => string,
): Alarm | null {
  if (observed >= critical) {
    return { id, severity: "critical", message: message("critical"), observed, threshold: critical, unit };
  }
  if (observed >= warn) {
    return { id, severity: "warn", message: message("warn"), observed, threshold: warn, unit };
  }
  return null;
}

function rateAlarm(
  id: string,
  window: FailureWindow,
  warn: number,
  critical: number,
  label: string,
): Alarm | null {
  // Rule 2: too small a sample cannot alarm, however bad the ratio looks.
  if (window.attempts < MIN_SAMPLES) return null;
  const ratio = failureRatio(window);
  return threshold(id, ratio, warn, critical, "ratio", (level) =>
    `${label} failure rate ${(ratio * 100).toFixed(1)}% over ${window.attempts} attempts (${level})`,
  );
}

/** The worst severity present. Empty means ok. */
export function worstSeverity(alarms: Alarm[]): Severity {
  if (alarms.some((a) => a.severity === "critical")) return "critical";
  if (alarms.some((a) => a.severity === "warn")) return "warn";
  return "ok";
}

export interface HealthReport {
  status: Severity;
  alarms: Alarm[];
  /** Every measurement, alarming or not, so a graph has data before an incident. */
  measurements: {
    indexLastSyncAgeSec: number | null;
    oldestQueuedJobAgeSec: number;
    oldestOverdueSettlementSec: number;
    oracleBacklog: number;
    rpcFailureRatio: number;
    facilitatorFailureRatio: number;
    sourceFailureRatio: number;
    workerAgesSec: Record<string, number | null>;
    /**
     * Trace id of each worker's last cycle, so the endpoint names the logs an
     * operator should open. Null where there is none to name — a beat written
     * outside a cycle, or a worker that has never reported.
     */
    workerTraceIds: Record<string, string | null>;
  };
}

export function evaluateHealth(
  snapshot: HealthSnapshot,
  nowMs: number,
  overrides: Partial<Thresholds> = {},
): HealthReport {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const alarms: Alarm[] = [];
  const workerAgesSec: Record<string, number | null> = {};
  const workerTraceIds: Record<string, string | null> = {};

  for (const worker of snapshot.workers) {
    // Validated again here rather than trusted from the snapshot: this function
    // is the one place the id reaches a public, unauthenticated response.
    workerTraceIds[worker.name] = isTraceId(worker.lastTraceId) ? worker.lastTraceId : null;
    if (worker.lastBeatAtMs === null) {
      // Rule 1: never reported is the worst case, not an unknown to ignore.
      workerAgesSec[worker.name] = null;
      alarms.push({
        id: `worker.${worker.name}.missing`,
        severity: "critical",
        message: `worker ${worker.name} has never reported a heartbeat`,
        observed: 0,
        threshold: t.workerStaleCriticalSec,
        unit: "seconds",
      });
      continue;
    }
    // A clock skew that puts a beat in the future must not read as "very fresh"
    // and it must not go negative either; treat it as fresh-but-clamped.
    const ageSec = Math.max(0, Math.round((nowMs - worker.lastBeatAtMs) / 1000));
    workerAgesSec[worker.name] = ageSec;
    // A slow worker sets its own bar: two missed cycles warn, four are critical.
    // Never tighter than the global default, so declaring a short interval cannot
    // make a worker alarm-happy.
    const interval = worker.expectedIntervalSec ?? 0;
    const stale = threshold(
      `worker.${worker.name}.stale`,
      ageSec,
      Math.max(t.workerStaleWarnSec, interval * 2),
      Math.max(t.workerStaleCriticalSec, interval * 4),
      "seconds",
      (level) => `worker ${worker.name} last reported ${ageSec}s ago (${level})`,
    );
    if (stale) alarms.push(stale);
    if (worker.lastError) {
      // A worker that beats while failing is alive and broken, which a staleness
      // check alone would call healthy.
      alarms.push({
        id: `worker.${worker.name}.error`,
        severity: "warn",
        message: `worker ${worker.name} reported an error: ${worker.lastError}`,
        observed: 1,
        threshold: 1,
        unit: "count",
      });
    }
  }

  if (snapshot.indexLastSyncAgeSec === null) {
    // Rule 1 again: an index that has never synced is empty, not fresh.
    alarms.push({
      id: "index.never_synced",
      severity: "critical",
      message: "read-index has never completed a sync",
      observed: 0,
      threshold: t.indexStaleCriticalSec,
      unit: "seconds",
    });
  } else {
    const stale = threshold(
      "index.stale",
      snapshot.indexLastSyncAgeSec,
      t.indexStaleWarnSec,
      t.indexStaleCriticalSec,
      "seconds",
      (level) => `read-index last synced ${snapshot.indexLastSyncAgeSec}s ago (${level})`,
    );
    if (stale) alarms.push(stale);
  }

  const queue = threshold(
    "queue.lag",
    snapshot.oldestQueuedJobAgeSec,
    t.queueLagWarnSec,
    t.queueLagCriticalSec,
    "seconds",
    (level) => `oldest queued job is ${snapshot.oldestQueuedJobAgeSec}s old (${level})`,
  );
  if (queue) alarms.push(queue);

  // Rule 3: the age of the oldest UNSETTLED market, not the average of settled
  // ones — the latter improves as things get stuck.
  const settlement = threshold(
    "settlement.overdue",
    snapshot.oldestOverdueSettlementSec,
    t.settlementWarnSec,
    t.settlementCriticalSec,
    "seconds",
    (level) =>
      `a market has been awaiting settlement for ${snapshot.oldestOverdueSettlementSec}s past its deadline (${level})`,
  );
  if (settlement) alarms.push(settlement);

  const backlog = threshold(
    "oracle.backlog",
    snapshot.oracleBacklog,
    t.oracleBacklogWarn,
    t.oracleBacklogCritical,
    "count",
    (level) => `${snapshot.oracleBacklog} markets are past deadline awaiting the oracle (${level})`,
  );
  if (backlog) alarms.push(backlog);

  const rpc = rateAlarm("rpc.failures", snapshot.rpc, t.rpcFailureWarn, t.rpcFailureCritical, "RPC");
  if (rpc) alarms.push(rpc);

  const facilitator = rateAlarm(
    "facilitator.failures",
    snapshot.facilitator,
    t.facilitatorFailureWarn,
    t.facilitatorFailureCritical,
    "x402 facilitator",
  );
  if (facilitator) alarms.push(facilitator);

  // Research sources are a soft dependency: a dead source degrades evidence
  // quality, it does not take the product down, so it can only ever warn.
  const sources = rateAlarm(
    "sources.failures",
    snapshot.sources,
    t.sourceFailureWarn,
    Number.POSITIVE_INFINITY,
    "research source",
  );
  if (sources) alarms.push(sources);

  for (const [name, balance] of Object.entries(snapshot.agentBalancesUsdc)) {
    if (balance === null) {
      alarms.push({
        id: `agent.${name}.untrusted`,
        severity: "critical",
        message: `agent ${name} has no USDC trustline or account`,
        observed: 0,
        threshold: t.agentBalanceCriticalUsdc,
        unit: "count",
      });
    } else {
      const balanceAlarm = threshold(
        `agent.${name}.balance`,
        -balance,
        -t.agentBalanceWarnUsdc,
        -t.agentBalanceCriticalUsdc,
        "count",
        (level) => `agent ${name} USDC balance is low: ${balance.toFixed(2)} (${level})`,
      );
      if (balanceAlarm) {
        alarms.push({
          ...balanceAlarm,
          observed: balance,
          threshold: balanceAlarm.severity === "critical" ? t.agentBalanceCriticalUsdc : t.agentBalanceWarnUsdc,
        });
      }
    }
  }

  return {
    status: worstSeverity(alarms),
    // Critical first so a truncated pager message still carries the worst news.
    alarms: alarms.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    measurements: {
      indexLastSyncAgeSec: snapshot.indexLastSyncAgeSec,
      oldestQueuedJobAgeSec: snapshot.oldestQueuedJobAgeSec,
      oldestOverdueSettlementSec: snapshot.oldestOverdueSettlementSec,
      oracleBacklog: snapshot.oracleBacklog,
      rpcFailureRatio: failureRatio(snapshot.rpc),
      facilitatorFailureRatio: failureRatio(snapshot.facilitator),
      sourceFailureRatio: failureRatio(snapshot.sources),
      workerAgesSec,
      workerTraceIds,
    },
  };
}

function severityRank(severity: Severity): number {
  return severity === "critical" ? 2 : severity === "warn" ? 1 : 0;
}

/** HTTP status for a probe: 503 only when something is actually broken. */
export function healthHttpStatus(status: Severity): number {
  return status === "critical" ? 503 : 200;
}

// ── Heartbeat storage ─────────────────────────────────────────────────────────

/** Workers expected to report. A worker missing from a snapshot cannot alarm. */
export const MONITORED_WORKERS = ["oracle", "market_creator", "council", "sync", "traders"] as const;
export type MonitoredWorker = (typeof MONITORED_WORKERS)[number];

/**
 * Heartbeats live in `sync_meta` rather than a table of their own. They are a
 * handful of rows overwritten in place, and a new table would need a migration to
 * hold less than a kilobyte.
 */
export function heartbeatKey(worker: MonitoredWorker): string {
  return `heartbeat:${worker}`;
}

export interface HeartbeatPayload {
  atMs: number;
  error?: string;
  /**
   * The worker's own poll cadence, reported with the beat.
   *
   * The worker knows its cadence; the reader would have to guess it from another
   * process's environment variables.
   */
  intervalSec?: number;
  /** Trace id of the cycle this beat came from, for log correlation. */
  traceId?: string;
}

export function encodeHeartbeat(payload: HeartbeatPayload): string {
  return JSON.stringify(payload);
}

/**
 * A malformed or missing heartbeat decodes to "never reported" rather than
 * throwing — a corrupt row must not take the health endpoint down with it, and
 * rule 1 already makes "never reported" the loud case.
 *
 * `traceId` is validated on read with the same rule the HTTP edge applies. The row
 * is written by a worker, but a health endpoint that echoes whatever a `sync_meta`
 * row contains is a public endpoint echoing whatever is in that row — and this one
 * is unauthenticated on purpose. A row that cannot be a trace id yields no trace
 * id, which is the fail-closed direction.
 */
export function decodeHeartbeat(raw: string | null): HeartbeatPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const atMs = (parsed as { atMs?: unknown }).atMs;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    const error = (parsed as { error?: unknown }).error;
    const intervalSec = (parsed as { intervalSec?: unknown }).intervalSec;
    const traceId = (parsed as { traceId?: unknown }).traceId;
    const payload: HeartbeatPayload = {
      atMs,
      error: typeof error === "string" && error.length > 0 ? error : undefined,
      intervalSec:
        typeof intervalSec === "number" && Number.isFinite(intervalSec) && intervalSec > 0
          ? intervalSec
          : undefined,
    };
    // Omitted rather than set to `undefined`: this field is additive, and a row
    // written before it existed must decode to exactly what it always did. An
    // explicit `traceId: undefined` key is a different object under deep equality,
    // which is the kind of difference that breaks a caller's comparison for no
    // reason. A malformed id is dropped the same way — the row is still a good
    // heartbeat, it just cannot name a trace.
    if (isTraceId(traceId)) payload.traceId = traceId;
    return payload;
  } catch {
    return null;
  }
}
