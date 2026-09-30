import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_THRESHOLDS,
  MIN_SAMPLES,
  MONITORED_WORKERS,
  decodeHeartbeat,
  encodeHeartbeat,
  evaluateHealth,
  failureRatio,
  healthHttpStatus,
  heartbeatKey,
  worstSeverity,
  type HealthSnapshot,
} from "../../lib/ops/health";

const NOW = 1_800_000_000_000;
const ROOT = path.resolve(import.meta.dirname, "..", "..");

function healthy(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    workers: MONITORED_WORKERS.map((name) => ({ name, lastBeatAtMs: NOW - 10_000 })),
    indexLastSyncAgeSec: 45,
    oldestQueuedJobAgeSec: 5,
    oldestOverdueSettlementSec: 0,
    oracleBacklog: 0,
    rpc: { attempts: 500, failures: 1 },
    facilitator: { attempts: 200, failures: 0 },
    sources: { attempts: 100, failures: 3 },
    agentBalancesUsdc: { oracle: 10, market_creator: 50 },
    ...overrides,
  };
}

function ids(snapshot: HealthSnapshot) {
  return evaluateHealth(snapshot, NOW).alarms.map((a) => a.id);
}

test("a healthy snapshot raises nothing", () => {
  const report = evaluateHealth(healthy(), NOW);
  assert.equal(report.status, "ok");
  assert.deepEqual(report.alarms, []);
  assert.equal(healthHttpStatus(report.status), 200);
});

// ── Rule 1: absence of signal is not health ───────────────────────────────────

test("a worker that never reported is critical, not silent", () => {
  const report = evaluateHealth(
    healthy({ workers: [{ name: "oracle", lastBeatAtMs: null }] }),
    NOW,
  );
  assert.equal(report.status, "critical");
  assert.deepEqual(report.alarms.map((a) => a.id), ["worker.oracle.missing"]);
  assert.equal(healthHttpStatus(report.status), 503);
});

test("a never-reported worker shows a null age rather than zero", () => {
  // Zero would graph as "just beat", which is the opposite of the truth.
  const report = evaluateHealth(healthy({ workers: [{ name: "council", lastBeatAtMs: null }] }), NOW);
  assert.equal(report.measurements.workerAgesSec.council, null);
});

test("staleness escalates warn then critical", () => {
  const at = (ageSec: number) =>
    evaluateHealth(healthy({ workers: [{ name: "sync", lastBeatAtMs: NOW - ageSec * 1000 }] }), NOW);
  assert.equal(at(DEFAULT_THRESHOLDS.workerStaleWarnSec - 1).status, "ok");
  assert.equal(at(DEFAULT_THRESHOLDS.workerStaleWarnSec).status, "warn");
  assert.equal(at(DEFAULT_THRESHOLDS.workerStaleCriticalSec).status, "critical");
});

test("a slow worker is judged against its own interval", () => {
  // The market creator runs every six hours; the default three-minute bar would
  // alarm permanently and teach everyone to ignore worker alarms.
  const sixHours = 6 * 3600;
  const at = (ageSec: number) =>
    evaluateHealth(
      healthy({
        workers: [
          { name: "market_creator", lastBeatAtMs: NOW - ageSec * 1000, expectedIntervalSec: sixHours },
        ],
      }),
      NOW,
    ).status;
  assert.equal(at(sixHours), "ok");
  assert.equal(at(sixHours * 2), "warn");
  assert.equal(at(sixHours * 4), "critical");
});

test("declaring a short interval cannot make a worker alarm-happy", () => {
  // Two cycles of a 10s poll is 20s, well under the default bar; the default wins.
  const report = evaluateHealth(
    healthy({
      workers: [{ name: "oracle", lastBeatAtMs: NOW - 60_000, expectedIntervalSec: 10 }],
    }),
    NOW,
  );
  assert.equal(report.status, "ok");
});

test("a worker beating with an error is alive and broken, not healthy", () => {
  const report = evaluateHealth(
    healthy({ workers: [{ name: "oracle", lastBeatAtMs: NOW - 1_000, lastError: "rpc timeout" }] }),
    NOW,
  );
  assert.equal(report.status, "warn");
  assert.match(report.alarms[0].message, /rpc timeout/);
});

test("a beat from the future is clamped, not treated as negative age", () => {
  const report = evaluateHealth(
    healthy({ workers: [{ name: "sync", lastBeatAtMs: NOW + 60_000 }] }),
    NOW,
  );
  assert.equal(report.measurements.workerAgesSec.sync, 0);
  assert.equal(report.status, "ok");
});

// ── Rule 2: a rate needs a sample size ────────────────────────────────────────

test("one failure out of one does not page anybody", () => {
  const report = evaluateHealth(healthy({ rpc: { attempts: 1, failures: 1 } }), NOW);
  assert.equal(report.status, "ok");
  // Still measured, so the graph shows it even though it cannot alarm.
  assert.equal(report.measurements.rpcFailureRatio, 1);
});

test("the same ratio alarms once the sample is big enough", () => {
  const small = evaluateHealth(
    healthy({ rpc: { attempts: MIN_SAMPLES - 1, failures: MIN_SAMPLES - 1 } }),
    NOW,
  );
  const big = evaluateHealth(
    healthy({ rpc: { attempts: MIN_SAMPLES, failures: MIN_SAMPLES } }),
    NOW,
  );
  assert.equal(small.status, "ok");
  assert.equal(big.status, "critical");
});

test("an empty window is a zero ratio, not a division by zero", () => {
  assert.equal(failureRatio({ attempts: 0, failures: 0 }), 0);
  assert.equal(evaluateHealth(healthy({ facilitator: { attempts: 0, failures: 0 } }), NOW).status, "ok");
});

test("facilitator failures are held to a tighter bar than RPC", () => {
  // A failing facilitator means payments are silently not settling.
  assert.ok(DEFAULT_THRESHOLDS.facilitatorFailureWarn < DEFAULT_THRESHOLDS.rpcFailureWarn);
  const report = evaluateHealth(healthy({ facilitator: { attempts: 100, failures: 10 } }), NOW);
  assert.deepEqual(report.alarms.map((a) => a.id), ["facilitator.failures"]);
});

test("research sources can only ever warn", () => {
  // A dead source degrades evidence quality; it does not take the product down.
  const report = evaluateHealth(healthy({ sources: { attempts: 100, failures: 100 } }), NOW);
  assert.equal(report.status, "warn");
  assert.deepEqual(report.alarms.map((a) => a.id), ["sources.failures"]);
});

// ── Rule 3: latency measured on what has not finished ─────────────────────────

test("an overdue settlement alarms on the oldest unsettled market", () => {
  const report = evaluateHealth(
    healthy({ oldestOverdueSettlementSec: DEFAULT_THRESHOLDS.settlementCriticalSec }),
    NOW,
  );
  assert.equal(report.status, "critical");
  assert.deepEqual(report.alarms.map((a) => a.id), ["settlement.overdue"]);
});

test("oracle backlog and settlement age are separate alarms", () => {
  // A large backlog settled promptly and one ancient stuck market are different
  // failures and want different responses.
  const backlogOnly = ids(healthy({ oracleBacklog: DEFAULT_THRESHOLDS.oracleBacklogWarn }));
  assert.deepEqual(backlogOnly, ["oracle.backlog"]);
  const stuckOnly = ids(healthy({ oldestOverdueSettlementSec: DEFAULT_THRESHOLDS.settlementWarnSec }));
  assert.deepEqual(stuckOnly, ["settlement.overdue"]);
});

// ── Lag ───────────────────────────────────────────────────────────────────────

test("a stale read-index escalates", () => {
  assert.equal(evaluateHealth(healthy({ indexLastSyncAgeSec: 299 }), NOW).status, "ok");
  assert.equal(evaluateHealth(healthy({ indexLastSyncAgeSec: 300 }), NOW).status, "warn");
  const report = evaluateHealth(healthy({ indexLastSyncAgeSec: 1_800 }), NOW);
  assert.equal(report.status, "critical");
  assert.deepEqual(report.alarms.map((a) => a.id), ["index.stale"]);
});

test("an index that never synced is critical, not fresh", () => {
  const report = evaluateHealth(healthy({ indexLastSyncAgeSec: null }), NOW);
  assert.equal(report.status, "critical");
  assert.deepEqual(report.alarms.map((a) => a.id), ["index.never_synced"]);
  assert.equal(report.measurements.indexLastSyncAgeSec, null);
});

test("queue lag escalates", () => {
  assert.equal(evaluateHealth(healthy({ oldestQueuedJobAgeSec: 299 }), NOW).status, "ok");
  assert.equal(evaluateHealth(healthy({ oldestQueuedJobAgeSec: 300 }), NOW).status, "warn");
  assert.equal(evaluateHealth(healthy({ oldestQueuedJobAgeSec: 1_800 }), NOW).status, "critical");
});

// ── Reporting ─────────────────────────────────────────────────────────────────

test("critical alarms sort ahead of warnings", () => {
  const report = evaluateHealth(
    healthy({
      workers: [{ name: "oracle", lastBeatAtMs: null }],
      oldestQueuedJobAgeSec: 400,
    }),
    NOW,
  );
  assert.equal(report.alarms[0].severity, "critical");
  assert.equal(report.alarms.at(-1)!.severity, "warn");
});

test("every alarm carries the value and the threshold it crossed", () => {
  const report = evaluateHealth(healthy({ oracleBacklog: 60 }), NOW);
  const alarm = report.alarms[0];
  assert.equal(alarm.observed, 60);
  assert.equal(alarm.threshold, DEFAULT_THRESHOLDS.oracleBacklogCritical);
  assert.equal(alarm.unit, "count");
});

test("measurements are present even when nothing alarms", () => {
  const report = evaluateHealth(healthy(), NOW);
  assert.equal(report.measurements.indexLastSyncAgeSec, 45);
  assert.equal(Object.keys(report.measurements.workerAgesSec).length, MONITORED_WORKERS.length);
});

test("thresholds can be overridden per environment", () => {
  const snapshot = healthy({ oldestQueuedJobAgeSec: 60 });
  assert.equal(evaluateHealth(snapshot, NOW).status, "ok");
  assert.equal(evaluateHealth(snapshot, NOW, { queueLagWarnSec: 30 }).status, "warn");
});

test("worstSeverity picks the loudest", () => {
  assert.equal(worstSeverity([]), "ok");
  assert.equal(
    worstSeverity([{ id: "a", severity: "warn", message: "", observed: 0, threshold: 0, unit: "count" }]),
    "warn",
  );
  assert.equal(
    worstSeverity([
      { id: "a", severity: "warn", message: "", observed: 0, threshold: 0, unit: "count" },
      { id: "b", severity: "critical", message: "", observed: 0, threshold: 0, unit: "count" },
    ]),
    "critical",
  );
});

test("a probe returns 503 only when something is actually broken", () => {
  assert.equal(healthHttpStatus("ok"), 200);
  // A warning must stay 200 or a load balancer pulls the app out of rotation for
  // a slow research source.
  assert.equal(healthHttpStatus("warn"), 200);
  assert.equal(healthHttpStatus("critical"), 503);
});

// ── Heartbeat storage ─────────────────────────────────────────────────────────

test("a heartbeat round-trips", () => {
  const decoded = decodeHeartbeat(encodeHeartbeat({ atMs: NOW, error: "boom", intervalSec: 60 }));
  assert.deepEqual(decoded, { atMs: NOW, error: "boom", intervalSec: 60 });
});

test("a worker reports its own cadence with the beat", () => {
  // The reader would otherwise have to guess it from another process's env.
  const decoded = decodeHeartbeat(encodeHeartbeat({ atMs: NOW, intervalSec: 21_600 }));
  assert.equal(decoded?.intervalSec, 21_600);
});

test("a nonsensical interval is dropped rather than trusted", () => {
  // A zero or negative interval would compute a staleness bar of zero.
  assert.equal(decodeHeartbeat('{"atMs":1,"intervalSec":0}')?.intervalSec, undefined);
  assert.equal(decodeHeartbeat('{"atMs":1,"intervalSec":-5}')?.intervalSec, undefined);
  assert.equal(decodeHeartbeat('{"atMs":1,"intervalSec":"soon"}')?.intervalSec, undefined);
});

test("heartbeat keys are namespaced per worker", () => {
  assert.equal(heartbeatKey("oracle"), "heartbeat:oracle");
  assert.notEqual(heartbeatKey("oracle"), heartbeatKey("council"));
});

test("a corrupt heartbeat decodes to never-reported instead of throwing", () => {
  // The health endpoint must survive a bad row; rule 1 already makes the
  // resulting "never reported" the loud case.
  assert.equal(decodeHeartbeat("not json"), null);
  assert.equal(decodeHeartbeat("null"), null);
  assert.equal(decodeHeartbeat('{"atMs":"soon"}'), null);
  assert.equal(decodeHeartbeat(null), null);
});

test("an empty error string is dropped rather than reported as an error", () => {
  assert.equal(decodeHeartbeat('{"atMs":1,"error":""}')?.error, undefined);
});

test("every monitored worker has something that writes its heartbeat", () => {
  // A name in MONITORED_WORKERS with no writer alarms as "never reported" forever,
  // which pins /api/health at 503 no matter how healthy the system is. This is
  // exactly how `sync` shipped: monitored, never beaten.
  const sources = [
    "agents/oracle/index.ts",
    "agents/market-creator/index.ts",
    "agents/council/index.ts",
    "agents/sync/index.ts",
    "agents/traders/index.ts",
  ].map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\n");

  for (const worker of MONITORED_WORKERS) {
    assert.ok(
      sources.includes(`beat("${worker}"`) || sources.includes(`reportingPoll("${worker}"`),
      `no beat("${worker}") or reportingPoll("${worker}") writer found`,
    );
  }
});

// ── Agent balances ────────────────────────────────────────────────────────────

test("a null agent balance (untrusted or unconfigured) alarms critical", () => {
  const report = evaluateHealth(healthy({ agentBalancesUsdc: { oracle: null } }), NOW);
  assert.equal(report.status, "critical");
  assert.deepEqual(
    report.alarms.map((a) => a.id),
    ["agent.oracle.untrusted"],
  );
});

test("agent balance escalates warn then critical", () => {
  const at = (balance: number) =>
    evaluateHealth(healthy({ agentBalancesUsdc: { oracle: balance } }), NOW);

  assert.equal(at(DEFAULT_THRESHOLDS.agentBalanceWarnUsdc + 0.1).status, "ok");
  assert.equal(at(DEFAULT_THRESHOLDS.agentBalanceWarnUsdc).status, "warn");
  assert.equal(at(DEFAULT_THRESHOLDS.agentBalanceCriticalUsdc).status, "critical");
  assert.equal(at(0.01).status, "critical");
});

test("agent balance metrics are included in the report", () => {
  const report = evaluateHealth(healthy({ agentBalancesUsdc: { oracle: 5.5 } }), NOW);
  assert.equal(report.measurements.agentBalancesUsdc.oracle, 5.5);
});
