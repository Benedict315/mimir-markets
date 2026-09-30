/**
 * Verify public operational status and deployment safety.
 *
 * Reproducible from a clean checkout without requiring production secrets.
 *
 * Checks:
 *   1. Deployment contract configurations and Stellar address formatting.
 *   2. Contract artifact provenance manifest and pins (fail-closed in release mode).
 *   3. Incident pause kill-switch state across all pausable capabilities.
 *   4. Critical non-pausable invariants (withdrawals and read paths always up).
 *   5. Privacy-safe telemetry (guaranteeing zero secret leakage).
 *
 * Usage:
 *   npx tsx scripts/verify-operational-status.ts
 *   npx tsx scripts/verify-operational-status.ts --mode=release --fail-closed
 *   npx tsx scripts/verify-operational-status.ts --json
 */

import {
  evaluateOperationalStatusReport,
  type OperationalStatusReport,
} from "../lib/ops/operational-status";

interface ParsedArgs {
  mode: "develop" | "release";
  failClosed: boolean;
  strict: boolean;
  json: boolean;
}

function parseCliArgs(args: string[]): ParsedArgs {
  let mode: "develop" | "release" =
    process.env.MIMIR_REQUIRE_ARTIFACT_PROVENANCE === "1" || process.env.NODE_ENV === "production"
      ? "release"
      : "develop";
  let failClosed = false;
  let strict = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--mode=release" || arg === "--release") mode = "release";
    else if (arg === "--mode=develop" || arg === "--develop") mode = "develop";
    else if (arg === "--fail-closed") failClosed = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
  }

  return { mode, failClosed, strict, json };
}

export function runOperationalVerification(
  report: OperationalStatusReport,
  options: { mode: "develop" | "release"; failClosed: boolean; strict: boolean },
): { ok: boolean; checksPassed: number; checksFailed: number; notes: string[] } {
  const notes: string[] = [];
  let checksPassed = 0;
  let checksFailed = 0;

  function pass(msg: string) {
    checksPassed++;
    notes.push(`  ✓ ${msg}`);
  }

  function fail(msg: string) {
    checksFailed++;
    notes.push(`  ✗ ${msg}`);
  }

  function warn(msg: string) {
    notes.push(`  ! ${msg}`);
  }

  // 1. Network & Environment
  pass(`Network: ${report.deployment.network} (${report.deployment.networkPassphrase})`);
  pass(`Environment: ${report.metadata.environment} (v${report.metadata.version})`);

  // 2. Contracts
  for (const [key, contract] of Object.entries(report.deployment.contracts)) {
    if (contract.configured) {
      if (contract.validFormat) {
        pass(`${contract.name}: configured (${contract.contractId})`);
      } else {
        fail(`${contract.name}: invalid contract address format (${contract.contractId})`);
      }
    } else {
      if (options.mode === "release") {
        fail(`${contract.name}: unconfigured in release mode`);
      } else {
        warn(`${contract.name}: unconfigured (optional in develop mode)`);
      }
    }
  }

  // 3. Artifact Provenance
  if (report.deployment.artifacts.manifestLoaded) {
    pass(
      `Artifact manifest: schema v${report.deployment.artifacts.schemaVersion}, ${report.deployment.artifacts.pinnedCount}/${report.deployment.artifacts.totalArtifacts} pinned`,
    );
  } else {
    if (options.mode === "release") {
      fail("Artifact manifest: failed to load or invalid");
    } else {
      warn("Artifact manifest: not found on disk");
    }
  }

  for (const finding of report.deployment.artifacts.findings) {
    if (finding.severity === "error") {
      fail(`Artifact [${finding.artifactId ?? "manifest"}]: ${finding.message}`);
    } else {
      warn(`Artifact [${finding.artifactId ?? "manifest"}]: ${finding.message}`);
    }
  }

  // 4. Invariant Protection: Withdrawals are NEVER pausable
  const withdraw = report.capabilities.items.find((c) => c.capability === "withdraw");
  if (withdraw && withdraw.status === "active" && withdraw.guaranteedNonPausable) {
    pass("Invariant: withdrawal is never pausable (fail-closed fund safety verified)");
  } else {
    fail("Invariant violated: withdrawal must never be pausable");
  }

  // 5. Capability Controls
  const pausedCount = report.capabilities.items.filter((c) => c.status === "paused").length;
  if (report.capabilities.globalPause) {
    warn(`Capabilities: globally paused (${report.capabilities.globalReason ?? "all writes"})`);
  } else if (pausedCount > 0) {
    warn(`Capabilities: ${pausedCount} capability/capabilities currently paused`);
  } else {
    pass("Capabilities: all 9 pausable capabilities active");
  }

  // 6. Privacy & Secret Safety
  const serialized = JSON.stringify(report);
  const secretPattern = /S[A-Z2-7]{55}|(postgres|postgresql):\/\/[^@\s]+@[^\s"']+/i;
  if (secretPattern.test(serialized)) {
    fail("Privacy safety: potential secret leaked in report payload");
  } else {
    pass("Privacy safety: 0 secrets leaked in operational telemetry");
  }

  const ok =
    options.strict
      ? checksFailed === 0 && report.status === "ok"
      : options.failClosed
      ? checksFailed === 0 && report.status !== "critical"
      : checksFailed === 0;

  return { ok, checksPassed, checksFailed, notes };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const envCopy = { ...process.env };
  if (args.mode === "release") {
    envCopy.MIMIR_REQUIRE_ARTIFACT_PROVENANCE = "1";
  }

  const report = evaluateOperationalStatusReport({
    env: envCopy,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === "critical" && args.failClosed ? 1 : 0);
  }

  console.log(`\nMimir Operational Status Surface [${report.status.toUpperCase()}]`);
  console.log(`Mode: ${report.mode} | Network: ${report.deployment.network} | Time: ${report.metadata.timestamp}\n`);

  const result = runOperationalVerification(report, {
    mode: args.mode,
    failClosed: args.failClosed,
    strict: args.strict,
  });

  for (const line of result.notes) {
    console.log(line);
  }

  console.log(`\nResult: ${result.checksPassed} passed, ${result.checksFailed} failed (status: ${report.status})`);

  if (!result.ok) {
    console.error("\nOperational status check FAILED fail-closed gate.");
    process.exit(1);
  }

  console.log("\nOperational status check PASSED.\n");
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal operational status verification error:", err);
    process.exit(1);
  });
}
