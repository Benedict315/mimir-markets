/**
 * Rollback rehearsal state machine.
 *
 * The machine runs through four phases in order:
 *
 *   1. snapshot  — capture the current deployment configuration
 *   2. verify    — assert the snapshot is internally consistent and safe
 *   3. simulate  — apply each rollback step to an in-memory copy of the state
 *   4. verify_post — run all invariants over the resulting state
 *
 * None of these phases touch the chain or the filesystem. The machine is
 * deliberately offline-safe so it can run in CI without credentials.
 *
 * The entry point is `rehearse(plan, options?)`. The machine returns a
 * `RehearsalResult` that summarises what happened and whether the rehearsal
 * passed.
 */

import {
  type DeploymentSnapshot,
  type PostRollbackState,
  type RehearsalResult,
  type RehearsalStatus,
  type RollbackPlan,
  type RollbackStep,
  type SnapshotFeePolicy,
  type StepResult,
  appearsToContainSecret,
  isSecretKey,
} from "./types";
import { runInvariantChecks } from "./verify";

// ── Machine options ───────────────────────────────────────────────────────────

export interface RehearsalOptions {
  /**
   * If true, the machine stops executing steps after the first failure.
   * Default: false (run all steps, collect all failures).
   */
  failFast?: boolean;

  /**
   * Injected clock, for deterministic testing. Defaults to `Date.now`.
   */
  now?: () => number;
}

// ── Snapshot capture ──────────────────────────────────────────────────────────

/**
 * Capture a deployment snapshot from an env-like record.
 * Secrets are redacted at capture time and never appear in the output.
 *
 * This is a pure function — given the same inputs it produces the same snapshot.
 * The caller is responsible for providing the env; we do not read `process.env`
 * directly so tests can inject their own fixtures without side effects.
 */
export function captureSnapshot(
  env: Record<string, string | undefined>,
  options: {
    label: string;
    featureFlags?: Record<string, boolean>;
    pauseState?: Record<string, boolean>;
    now?: () => number;
  },
): DeploymentSnapshot {
  const now = options.now ?? (() => Date.now());

  // Redact secrets before touching the env map.
  const safeEnv: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(env)) {
    const value = rawValue?.trim() ?? "";
    if (isSecretKey(key)) {
      // Always redact, even if the value is empty, to signal the key exists.
      safeEnv[key] = value === "" ? "" : "[redacted]";
    } else if (appearsToContainSecret(value)) {
      // Non-secret key whose value looks like a seed — redact and warn.
      safeEnv[key] = "[redacted:value-looks-like-secret]";
    } else {
      safeEnv[key] = value;
    }
  }

  const platformFeeBps = Number(safeEnv["STELLAR_PLATFORM_FEE_BPS"] ?? "0");
  const agentOwnerFeeBps = Number(safeEnv["STELLAR_AGENT_OWNER_FEE_BPS"] ?? "0");
  const feePolicy: SnapshotFeePolicy = {
    platformFeeBps,
    agentOwnerFeeBps,
    totalFeeBps: platformFeeBps + agentOwnerFeeBps,
  };

  return {
    capturedAt: new Date(now()).toISOString(),
    label: options.label,
    env: safeEnv,
    featureFlags: options.featureFlags ?? {},
    pauseState: options.pauseState ?? {},
    feePolicy,
    contractIds: {
      market: safeEnv["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"] || undefined,
      squad: safeEnv["NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID"] || undefined,
      usdcSac: safeEnv["NEXT_PUBLIC_STELLAR_USDC_SAC_ID"] || undefined,
    },
  };
}

// ── Plan builder ──────────────────────────────────────────────────────────────

/**
 * Build a rollback plan from a snapshot and a list of funded features that are
 * being rolled back.
 *
 * The generated plan follows the fail-closed principle:
 *   1. Pause all write capabilities first (fast, no deploy needed, no chain call).
 *   2. Disable funded feature flags.
 *   3. Restore env keys to their snapshot values.
 *   4. Restore contract ids.
 *   5. Verify the resulting state satisfies every invariant.
 */
export function buildRollbackPlan(
  snapshot: DeploymentSnapshot,
  description: string,
  options: {
    /**
     * Write capabilities to pause during rollback. These map to `MIMIR_PAUSE_*`
     * env vars and are set first so the system fails closed immediately.
     */
    pauseCapabilities?: string[];
    /**
     * Funded features to disable. These map to `MIMIR_FEATURE_*` env vars.
     * A funded feature left on while the contract ids have been reverted is a
     * critical misconfiguration.
     */
    revertFeatures?: string[];
    /**
     * Env keys to restore from the snapshot. Keys not in this list are not touched.
     * Use ["*"] to restore all keys in the snapshot.
     */
    restoreEnvKeys?: string[];
  } = {},
): RollbackPlan {
  const steps: RollbackStep[] = [];

  // 1. Pause capabilities (fail-closed first)
  for (const capability of options.pauseCapabilities ?? []) {
    steps.push({
      kind: "pause_capability",
      description: `Pause ${capability}: set MIMIR_PAUSE_${capability.toUpperCase()}=1`,
      target: capability,
      restoreValue: "1",
    });
  }

  // 2. Revert feature flags (funded features off before restoring older contract ids)
  for (const feature of options.revertFeatures ?? []) {
    const wasEnabled = snapshot.featureFlags[feature];
    steps.push({
      kind: "revert_feature_flag",
      description: `Revert feature flag: ${feature} → ${wasEnabled ? "enabled" : "disabled"} (snapshot value)`,
      target: feature,
      restoreValue: wasEnabled ? "1" : "0",
    });
  }

  // 3. Restore env keys
  const keysToRestore =
    options.restoreEnvKeys?.includes("*")
      ? Object.keys(snapshot.env)
      : (options.restoreEnvKeys ?? []);

  for (const key of keysToRestore) {
    const snapshotValue = snapshot.env[key];
    if (snapshotValue === undefined) continue;
    steps.push({
      kind: "restore_env_key",
      description: `Restore env key: ${key} → ${isSecretKey(key) ? "[redacted]" : snapshotValue}`,
      target: key,
      restoreValue: isSecretKey(key) ? "[redacted]" : snapshotValue,
    });
  }

  // 4. Verify invariants
  steps.push({
    kind: "verify_fee_invariant",
    description: "Verify fee policy is within the hard cap and legs are non-negative",
  });
  steps.push({
    kind: "verify_no_secret_leak",
    description: "Verify no raw secret values in the effective env or snapshot",
  });
  steps.push({
    kind: "verify_env_keys_present",
    description: "Verify all deployment-critical env keys are present and non-empty",
  });

  return { description, snapshot, steps };
}

// ── Step execution ────────────────────────────────────────────────────────────

function executeStep(
  step: RollbackStep,
  state: PostRollbackState,
  durationMs: number,
): StepResult {
  switch (step.kind) {
    case "pause_capability": {
      if (!step.target) {
        return { step, status: "fail", message: "pause_capability step has no target", durationMs };
      }
      state.effectivePauseState[step.target] = true;
      return {
        step,
        status: "pass",
        message: `capability "${step.target}" marked as paused`,
        durationMs,
      };
    }

    case "revert_feature_flag": {
      if (!step.target) {
        return {
          step,
          status: "fail",
          message: "revert_feature_flag step has no target",
          durationMs,
        };
      }
      const enabled = step.restoreValue === "1";
      state.effectiveFeatureFlags[step.target] = enabled;
      return {
        step,
        status: "pass",
        message: `feature flag "${step.target}" set to ${enabled ? "enabled" : "disabled"}`,
        durationMs,
      };
    }

    case "restore_env_key": {
      if (!step.target) {
        return { step, status: "fail", message: "restore_env_key step has no target", durationMs };
      }
      const value = step.restoreValue ?? "";
      state.effectiveEnv[step.target] = value;
      return {
        step,
        status: "pass",
        message: `env key "${step.target}" restored${isSecretKey(step.target) ? " (secret, value redacted)" : ""}`,
        durationMs,
      };
    }

    case "restore_contract_id": {
      if (!step.target) {
        return {
          step,
          status: "fail",
          message: "restore_contract_id step has no target",
          durationMs,
        };
      }
      const id = step.restoreValue ?? "";
      state.effectiveEnv[step.target] = id;
      return {
        step,
        status: "pass",
        message: `contract id "${step.target}" restored to ${id}`,
        durationMs,
      };
    }

    case "verify_fee_invariant": {
      const { platformFeeBps, agentOwnerFeeBps, totalFeeBps } = state.effectiveFeePolicy;
      const errors: string[] = [];
      if (platformFeeBps < 0)
        errors.push(`platformFeeBps is negative (${platformFeeBps})`);
      if (agentOwnerFeeBps < 0)
        errors.push(`agentOwnerFeeBps is negative (${agentOwnerFeeBps})`);
      if (totalFeeBps > 1_000)
        errors.push(`totalFeeBps ${totalFeeBps} exceeds hard cap 1000`);
      if (totalFeeBps !== platformFeeBps + agentOwnerFeeBps)
        errors.push(
          `totalFeeBps (${totalFeeBps}) != platformFeeBps (${platformFeeBps}) + agentOwnerFeeBps (${agentOwnerFeeBps})`,
        );
      if (errors.length > 0) {
        return { step, status: "fail", message: errors.join("; "), durationMs };
      }
      return {
        step,
        status: "pass",
        message: `fee policy valid: platform=${platformFeeBps}bps agent=${agentOwnerFeeBps}bps total=${totalFeeBps}bps`,
        durationMs,
      };
    }

    case "verify_no_secret_leak": {
      const leaks: string[] = [];
      for (const [key, value] of Object.entries(state.effectiveEnv)) {
        if (isSecretKey(key) && value !== "[redacted]" && value.trim() !== "") {
          leaks.push(`${key} (secret key not redacted)`);
        } else if (appearsToContainSecret(value)) {
          leaks.push(`${key} (value looks like a Stellar seed)`);
        }
      }
      // Also check the snapshot env.
      for (const [key, value] of Object.entries(state.snapshot.env)) {
        if (isSecretKey(key) && value !== "[redacted]" && value.trim() !== "") {
          leaks.push(`snapshot.${key} (secret key not redacted)`);
        } else if (appearsToContainSecret(value)) {
          leaks.push(`snapshot.${key} (value looks like a Stellar seed)`);
        }
      }
      if (leaks.length > 0) {
        return {
          step,
          status: "fail",
          message: `secret leak detected: ${leaks.join("; ")}`,
          durationMs,
        };
      }
      return { step, status: "pass", message: "no raw secrets found in effective env or snapshot", durationMs };
    }

    case "verify_env_keys_present": {
      const required = [
        "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
        "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
        "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
        "NEXT_PUBLIC_STELLAR_NETWORK",
        "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE",
        "NEXT_PUBLIC_STELLAR_RPC_URL",
        "NEXT_PUBLIC_STELLAR_USDC_ISSUER",
      ];
      const missing = required.filter(
        (key) => !state.effectiveEnv[key] || state.effectiveEnv[key].trim() === "",
      );
      if (missing.length > 0) {
        return {
          step,
          status: "fail",
          message: `missing required env keys: ${missing.join(", ")}`,
          durationMs,
        };
      }
      return {
        step,
        status: "pass",
        message: `all ${required.length} required env keys present`,
        durationMs,
      };
    }
  }
}

// ── Machine entry point ───────────────────────────────────────────────────────

/**
 * Run the rollback rehearsal for `plan`.
 *
 * Returns a `RehearsalResult` with step-by-step results and a final
 * pass/fail determination. The rehearsal is entirely in-memory — no files are
 * written, no chain calls are made.
 */
export function rehearse(plan: RollbackPlan, options: RehearsalOptions = {}): RehearsalResult {
  const clock = options.now ?? (() => Date.now());
  const start = clock();

  // Build the mutable post-rollback state that steps will modify.
  const state: PostRollbackState = {
    snapshot: plan.snapshot,
    effectiveEnv: { ...plan.snapshot.env },
    effectiveFeatureFlags: { ...plan.snapshot.featureFlags },
    effectivePauseState: { ...plan.snapshot.pauseState },
    effectiveFeePolicy: { ...plan.snapshot.feePolicy },
    stepResults: [],
  };

  const stepResults: StepResult[] = [];
  let halted = false;

  for (const step of plan.steps) {
    if (halted) {
      stepResults.push({
        step,
        status: "skip",
        message: "skipped: an earlier step failed and fail-fast is enabled",
        durationMs: 0,
      });
      continue;
    }

    const stepStart = clock();
    const result = executeStep(step, state, 0);
    const stepEnd = clock();
    const withDuration: StepResult = { ...result, durationMs: stepEnd - stepStart };
    stepResults.push(withDuration);
    state.stepResults = stepResults;

    if (withDuration.status === "fail" && options.failFast) {
      halted = true;
    }
  }

  // Run the full invariant suite over the final state.
  const invariantFailures = runInvariantChecks(state);
  // Attach invariant failures as additional synthetic step results for visibility.
  for (const { name, error } of invariantFailures) {
    stepResults.push({
      step: {
        kind: "verify_fee_invariant", // Reuse a verify kind as a catch-all.
        description: `invariant: ${name}`,
      },
      status: "fail",
      message: error,
      durationMs: 0,
    });
  }

  const failed = stepResults.filter((r) => r.status === "fail").length;
  const skipped = stepResults.filter((r) => r.status === "skip").length;
  const end = clock();

  let status: RehearsalStatus;
  if (failed === 0) {
    status = "success";
  } else if (failed === stepResults.length) {
    status = "failure";
  } else {
    status = "partial";
  }

  const summary = buildSummary(plan, stepResults, status, failed, skipped, end - start);

  return {
    plan,
    stepResults,
    status,
    totalDurationMs: end - start,
    failedSteps: failed,
    skippedSteps: skipped,
    summary,
  };
}

function buildSummary(
  plan: RollbackPlan,
  results: StepResult[],
  status: RehearsalStatus,
  failed: number,
  skipped: number,
  durationMs: number,
): string {
  const passed = results.filter((r) => r.status === "pass").length;
  const total = results.length;
  const icon = status === "success" ? "✓" : status === "partial" ? "⚠" : "✗";

  const lines = [
    `${icon} Rollback rehearsal: ${plan.description}`,
    `  snapshot  : ${plan.snapshot.label} (captured ${plan.snapshot.capturedAt})`,
    `  result    : ${status.toUpperCase()} — ${passed}/${total} steps passed, ${failed} failed, ${skipped} skipped`,
    `  duration  : ${durationMs}ms`,
  ];

  if (failed > 0) {
    lines.push("  failures  :");
    for (const r of results.filter((r) => r.status === "fail")) {
      lines.push(`    ✗ [${r.step.kind}] ${r.step.description}`);
      lines.push(`        ${r.message}`);
    }
  }

  lines.push(
    status === "success"
      ? "  The rollback plan is safe to execute. All invariants hold."
      : status === "partial"
        ? "  Some steps failed. Review the failures before executing a real rollback."
        : "  The rollback plan has critical failures. Do not execute without remediation.",
  );

  return lines.join("\n");
}
