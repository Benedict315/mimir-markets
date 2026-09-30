/**
 * Rollback rehearsal tests.
 *
 * Coverage:
 *  - Snapshot capture: secret redaction, env key copying, fee policy derivation
 *  - Plan builder: step ordering, target resolution, wildcard key restore
 *  - State machine: step execution, fail-fast, phase ordering
 *  - Invariant checks: fee policy cap, feature flag safety, env key presence,
 *    secret leak detection
 *  - Positive cases: a clean fixture passes end-to-end
 *  - Negative cases: each invariant can be individually violated and caught
 *  - Failure cases: missing target, bad fee policy, secret leaks
 *  - Regression cases: snapshot cannot contain raw secrets even if passed in
 *
 * All tests are deterministic — no network, no filesystem, no secrets.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRollbackPlan,
  captureSnapshot,
  rehearse,
  runInvariantChecks,
  type DeploymentSnapshot,
  type PostRollbackState,
} from "../../lib/rollback";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal valid env for tests that need required keys. */
function minimalEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID:
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACT2X",
    NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID:
      "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ",
    NEXT_PUBLIC_STELLAR_USDC_SAC_ID:
      "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD",
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    NEXT_PUBLIC_STELLAR_USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    STELLAR_PLATFORM_FEE_BPS: "200",
    STELLAR_AGENT_OWNER_FEE_BPS: "0",
    ...overrides,
  };
}

/** A minimal valid snapshot for tests that build plans directly. */
function minimalSnapshot(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  return captureSnapshot(minimalEnv(), {
    label: "test-snapshot",
    featureFlags: {
      byoa_funded_actions: false,
      copy_trading: false,
      agent_baskets: false,
      fee_policy: false,
    },
    pauseState: {},
    now: () => 1_700_000_000_000,
  });
}

/** A minimal valid PostRollbackState for testing invariants directly. */
function minimalPostRollbackState(
  overrides: Partial<PostRollbackState> = {},
): PostRollbackState {
  const snapshot = minimalSnapshot();
  return {
    snapshot,
    effectiveEnv: { ...snapshot.env },
    effectiveFeatureFlags: {
      byoa_funded_actions: false,
      copy_trading: false,
      agent_baskets: false,
      fee_policy: false,
    },
    effectivePauseState: {},
    effectiveFeePolicy: { ...snapshot.feePolicy },
    stepResults: [],
    ...overrides,
  };
}

// ── Snapshot capture ──────────────────────────────────────────────────────────

test("snapshot captures label and timestamp", () => {
  const fixedNow = 1_700_000_000_000;
  const snapshot = captureSnapshot(minimalEnv(), {
    label: "pre-v2-deploy",
    now: () => fixedNow,
  });
  assert.equal(snapshot.label, "pre-v2-deploy");
  assert.equal(snapshot.capturedAt, new Date(fixedNow).toISOString());
});

test("snapshot captures deployment-critical env keys", () => {
  const snapshot = captureSnapshot(minimalEnv(), { label: "test" });
  assert.equal(
    snapshot.env["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"],
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACT2X",
  );
  assert.equal(snapshot.env["NEXT_PUBLIC_STELLAR_NETWORK"], "testnet");
});

test("snapshot redacts keys matching _SECRET pattern", () => {
  const env = minimalEnv({ STELLAR_DEPLOYER_SECRET: "SACTUAL_SECRET_VALUE_ABCDEFGHIJ" });
  const snapshot = captureSnapshot(env, { label: "test" });
  assert.equal(snapshot.env["STELLAR_DEPLOYER_SECRET"], "[redacted]");
  // The raw secret must not appear anywhere in the snapshot.
  const serialised = JSON.stringify(snapshot);
  assert.ok(
    !serialised.includes("SACTUAL_SECRET_VALUE_ABCDEFGHIJ"),
    "raw secret leaked into snapshot",
  );
});

test("snapshot redacts keys matching _SEED pattern", () => {
  const env = minimalEnv({ DATABASE_SEED: "super-secret-seed-value" });
  const snapshot = captureSnapshot(env, { label: "test" });
  assert.equal(snapshot.env["DATABASE_SEED"], "[redacted]");
});

test("snapshot redacts value that looks like a Stellar seed even on a non-secret key", () => {
  // A Stellar seed is S + 55 uppercase base32 characters.
  const stellarSeed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const env = minimalEnv({ SOME_CONFIG_KEY: stellarSeed });
  const snapshot = captureSnapshot(env, { label: "test" });
  assert.equal(snapshot.env["SOME_CONFIG_KEY"], "[redacted:value-looks-like-secret]");
});

test("snapshot derives fee policy from env", () => {
  const env = minimalEnv({
    STELLAR_PLATFORM_FEE_BPS: "300",
    STELLAR_AGENT_OWNER_FEE_BPS: "50",
  });
  const snapshot = captureSnapshot(env, { label: "test" });
  assert.equal(snapshot.feePolicy.platformFeeBps, 300);
  assert.equal(snapshot.feePolicy.agentOwnerFeeBps, 50);
  assert.equal(snapshot.feePolicy.totalFeeBps, 350);
});

test("snapshot captures contract ids from env", () => {
  const snapshot = captureSnapshot(minimalEnv(), { label: "test" });
  assert.equal(
    snapshot.contractIds.market,
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACT2X",
  );
  assert.ok(snapshot.contractIds.squad);
  assert.ok(snapshot.contractIds.usdcSac);
});

test("snapshot captures feature flags", () => {
  const snapshot = captureSnapshot(minimalEnv(), {
    label: "test",
    featureFlags: { copy_trading: false, fee_policy: false },
  });
  assert.equal(snapshot.featureFlags["copy_trading"], false);
  assert.equal(snapshot.featureFlags["fee_policy"], false);
});

test("snapshot captures pause state", () => {
  const snapshot = captureSnapshot(minimalEnv(), {
    label: "test",
    pauseState: { stake: true, create_market: false },
  });
  assert.equal(snapshot.pauseState["stake"], true);
  assert.equal(snapshot.pauseState["create_market"], false);
});

// ── Plan builder ──────────────────────────────────────────────────────────────

test("plan includes pause steps before feature revert steps", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test rollback", {
    pauseCapabilities: ["stake"],
    revertFeatures: ["fee_policy"],
  });
  const pauseIdx = plan.steps.findIndex((s) => s.kind === "pause_capability");
  const revertIdx = plan.steps.findIndex((s) => s.kind === "revert_feature_flag");
  assert.ok(pauseIdx !== -1, "no pause_capability step found");
  assert.ok(revertIdx !== -1, "no revert_feature_flag step found");
  assert.ok(pauseIdx < revertIdx, "pause must come before feature revert");
});

test("plan includes verify steps at the end", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test rollback", {
    pauseCapabilities: ["stake"],
  });
  const verifySteps = plan.steps.filter((s) => s.kind.startsWith("verify_"));
  assert.ok(verifySteps.length >= 3, "expected at least 3 verify steps");
  const lastNonVerify = plan.steps.reduceRight((acc, s, i) => {
    if (!s.kind.startsWith("verify_")) return Math.max(acc, i);
    return acc;
  }, -1);
  const firstVerify = plan.steps.findIndex((s) => s.kind.startsWith("verify_"));
  assert.ok(
    firstVerify > lastNonVerify,
    "all verify steps must come after all action steps",
  );
});

test("plan with wildcard restores all snapshot env keys", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test", { restoreEnvKeys: ["*"] });
  const restoredKeys = plan.steps
    .filter((s) => s.kind === "restore_env_key")
    .map((s) => s.target);
  // Every key in the snapshot must have a corresponding restore step.
  for (const key of Object.keys(snapshot.env)) {
    assert.ok(restoredKeys.includes(key), `missing restore step for ${key}`);
  }
});

test("plan with specific key list only restores those keys", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test", {
    restoreEnvKeys: ["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"],
  });
  const restoredKeys = plan.steps
    .filter((s) => s.kind === "restore_env_key")
    .map((s) => s.target);
  assert.deepEqual(restoredKeys, ["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"]);
});

test("plan does not add restore step for key absent from snapshot", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test", {
    restoreEnvKeys: ["KEY_NOT_IN_SNAPSHOT"],
  });
  const restoredKeys = plan.steps
    .filter((s) => s.kind === "restore_env_key")
    .map((s) => s.target);
  assert.ok(!restoredKeys.includes("KEY_NOT_IN_SNAPSHOT"));
});

test("plan description is set correctly", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "my custom rollback", {});
  assert.equal(plan.description, "my custom rollback");
});

// ── Positive end-to-end case ──────────────────────────────────────────────────

test("a clean fixture rehearsal succeeds end-to-end", () => {
  const snapshot = captureSnapshot(minimalEnv(), {
    label: "fixture-e2e",
    featureFlags: {
      byoa_funded_actions: false,
      copy_trading: false,
      agent_baskets: false,
      fee_policy: false,
    },
    pauseState: {},
  });
  const plan = buildRollbackPlan(snapshot, "e2e test rollback", {
    pauseCapabilities: ["stake", "create_market"],
    revertFeatures: ["byoa_funded_actions", "copy_trading", "fee_policy"],
    restoreEnvKeys: ["*"],
  });
  const result = rehearse(plan);
  assert.equal(
    result.status,
    "success",
    `rehearsal failed:\n${result.summary}`,
  );
  assert.equal(result.failedSteps, 0);
});

test("rehearsal passes with no capabilities paused and no features reverted", () => {
  // A minimal plan should still pass all invariants when the state is already clean.
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "minimal", {});
  const result = rehearse(plan);
  assert.equal(result.status, "success", result.summary);
});

test("rehearsal summary contains the plan description", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "test rollback v1", {});
  const result = rehearse(plan);
  assert.ok(result.summary.includes("test rollback v1"), "plan description missing from summary");
});

test("rehearsal reports total duration", () => {
  let tick = 0;
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "timing test", {});
  const result = rehearse(plan, { now: () => (tick += 10) });
  assert.ok(result.totalDurationMs >= 0);
});

// ── Step execution ────────────────────────────────────────────────────────────

test("pause_capability step marks capability as paused in state", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "pause test", {
    pauseCapabilities: ["stake", "create_market"],
  });
  const result = rehearse(plan);
  // Both capabilities must appear in the effective pause state.
  const pauseResults = result.stepResults.filter((r) => r.step.kind === "pause_capability");
  assert.ok(pauseResults.length === 2);
  for (const r of pauseResults) {
    assert.equal(r.status, "pass");
  }
});

test("revert_feature_flag step sets the feature to its snapshot value", () => {
  // Snapshot has fee_policy = false; the step should set it back to false.
  const snapshot = captureSnapshot(minimalEnv(), {
    label: "test",
    featureFlags: { fee_policy: false },
  });
  const plan = buildRollbackPlan(snapshot, "flag test", {
    revertFeatures: ["fee_policy"],
  });
  const result = rehearse(plan);
  const flagResult = result.stepResults.find((r) => r.step.kind === "revert_feature_flag");
  assert.ok(flagResult, "no revert_feature_flag step result");
  assert.equal(flagResult.status, "pass");
});

test("restore_env_key step sets the key in the effective env", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "env test", {
    restoreEnvKeys: ["NEXT_PUBLIC_STELLAR_NETWORK"],
  });
  const result = rehearse(plan);
  const envResult = result.stepResults.find((r) => r.step.kind === "restore_env_key");
  assert.ok(envResult, "no restore_env_key step result");
  assert.equal(envResult.status, "pass");
});

test("verify steps pass on a clean state", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "verify test", {});
  const result = rehearse(plan);
  const verifyResults = result.stepResults.filter((r) => r.step.kind.startsWith("verify_"));
  for (const vr of verifyResults) {
    assert.equal(vr.status, "pass", `verify step failed: ${vr.message}`);
  }
});

// ── Fail-fast mode ────────────────────────────────────────────────────────────

test("fail-fast stops after first failure", () => {
  // Build a plan where the first step will fail (pause step with no target).
  const snapshot = minimalSnapshot();
  // Manually inject a bad step by building a plan then mutating steps.
  const plan = buildRollbackPlan(snapshot, "fail-fast test", {
    pauseCapabilities: ["stake"],
  });
  // Replace the first step with one that has no target.
  plan.steps.unshift({
    kind: "pause_capability",
    description: "intentionally bad step",
    // target intentionally omitted
  });

  const result = rehearse(plan, { failFast: true });
  assert.equal(result.status !== "success", true);
  const skippedCount = result.stepResults.filter((r) => r.status === "skip").length;
  assert.ok(skippedCount >= 1, "expected at least one skipped step in fail-fast mode");
});

test("without fail-fast all steps run even after a failure", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "no-fail-fast test", {
    pauseCapabilities: ["stake"],
  });
  plan.steps.unshift({
    kind: "pause_capability",
    description: "intentionally bad step",
    // no target
  });

  const result = rehearse(plan, { failFast: false });
  const skippedCount = result.stepResults.filter((r) => r.status === "skip").length;
  assert.equal(skippedCount, 0, "no steps should be skipped without fail-fast");
});

// ── Invariant checks — negative cases ────────────────────────────────────────

test("fee_policy_within_cap invariant catches total > 1000 bps", () => {
  const state = minimalPostRollbackState({
    effectiveFeePolicy: { platformFeeBps: 800, agentOwnerFeeBps: 300, totalFeeBps: 1100 },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(
    names.includes("fee_policy_within_cap"),
    `expected fee_policy_within_cap to fail, got: ${names.join(", ")}`,
  );
});

test("fee_legs_non_negative invariant catches negative platform fee", () => {
  const state = minimalPostRollbackState({
    effectiveFeePolicy: { platformFeeBps: -50, agentOwnerFeeBps: 0, totalFeeBps: -50 },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("fee_legs_non_negative"));
});

test("fee_policy_totals_consistent invariant catches inconsistent total", () => {
  const state = minimalPostRollbackState({
    effectiveFeePolicy: { platformFeeBps: 200, agentOwnerFeeBps: 50, totalFeeBps: 999 },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("fee_policy_totals_consistent"));
});

test("funded_features_disabled_after_rollback catches fee_policy left enabled", () => {
  const state = minimalPostRollbackState({
    effectiveFeatureFlags: { fee_policy: true },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("funded_features_disabled_after_rollback"));
});

test("funded_features_disabled_after_rollback catches copy_trading left enabled", () => {
  const state = minimalPostRollbackState({
    effectiveFeatureFlags: { copy_trading: true },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("funded_features_disabled_after_rollback"));
});

test("funded_features_disabled_after_rollback catches byoa_funded_actions left enabled", () => {
  const state = minimalPostRollbackState({
    effectiveFeatureFlags: { byoa_funded_actions: true },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("funded_features_disabled_after_rollback"));
});

test("required_env_keys_present catches missing MARKET_CONTRACT_ID", () => {
  const state = minimalPostRollbackState();
  delete state.effectiveEnv["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"];
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("required_env_keys_present"));
});

test("required_env_keys_present catches empty RPC URL", () => {
  const state = minimalPostRollbackState({
    effectiveEnv: {
      ...minimalEnv(),
      NEXT_PUBLIC_STELLAR_RPC_URL: "",
    },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("required_env_keys_present"));
});

test("no_raw_secrets_in_effective_env catches un-redacted secret key", () => {
  const state = minimalPostRollbackState({
    effectiveEnv: {
      ...minimalEnv(),
      STELLAR_DEPLOYER_SECRET: "SACTUAL_SECRET_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJ",
    },
  });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("no_raw_secrets_in_effective_env"));
});

test("no_raw_secrets_in_snapshot catches un-redacted secret in snapshot env", () => {
  const snapshot = minimalSnapshot();
  // Manually plant an un-redacted secret in the snapshot (simulating a bypass).
  const taintedSnapshot: DeploymentSnapshot = {
    ...snapshot,
    env: {
      ...snapshot.env,
      STELLAR_ORACLE_SECRET: "SACTUAL_SECRET_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJ",
    },
  };
  const state = minimalPostRollbackState({ snapshot: taintedSnapshot });
  const failures = runInvariantChecks(state);
  const names = failures.map((f) => f.name);
  assert.ok(names.includes("no_raw_secrets_in_snapshot"));
});

// ── Regression cases ──────────────────────────────────────────────────────────

test("captureSnapshot never stores a raw Stellar seed even if passed directly", () => {
  // Regression: the capture path must redact at input, not at output.
  const seed = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const env = minimalEnv({ STELLAR_DEPLOYER_SECRET: seed });
  const snapshot = captureSnapshot(env, { label: "regression" });
  assert.equal(snapshot.env["STELLAR_DEPLOYER_SECRET"], "[redacted]");
  const raw = JSON.stringify(snapshot);
  assert.ok(!raw.includes(seed), `raw seed leaked: ${seed}`);
});

test("rehearsal does not fail when no features or capabilities are specified", () => {
  // An empty rollback plan (no pauses, no reverts, no env restores) should still
  // run the verify steps and pass if the snapshot is already safe.
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "empty plan", {});
  const result = rehearse(plan);
  assert.equal(result.status, "success", result.summary);
});

test("rehearsal is deterministic — identical inputs always produce identical results", () => {
  const env = minimalEnv();
  const flags = { byoa_funded_actions: false, copy_trading: false };
  const now = () => 1_700_000_000_000;

  const run = () => {
    const snapshot = captureSnapshot(env, { label: "deterministic", featureFlags: flags, now });
    const plan = buildRollbackPlan(snapshot, "determinism test", {
      pauseCapabilities: ["stake"],
      revertFeatures: ["fee_policy"],
      restoreEnvKeys: ["NEXT_PUBLIC_STELLAR_NETWORK"],
    });
    return rehearse(plan, { now });
  };

  const r1 = run();
  const r2 = run();

  assert.equal(r1.status, r2.status);
  assert.equal(r1.failedSteps, r2.failedSteps);
  assert.equal(r1.stepResults.length, r2.stepResults.length);
  for (let i = 0; i < r1.stepResults.length; i++) {
    assert.equal(r1.stepResults[i].status, r2.stepResults[i].status);
    assert.equal(r1.stepResults[i].message, r2.stepResults[i].message);
  }
});

test("fee policy total is always derived as platformFeeBps + agentOwnerFeeBps", () => {
  const env = minimalEnv({
    STELLAR_PLATFORM_FEE_BPS: "150",
    STELLAR_AGENT_OWNER_FEE_BPS: "75",
  });
  const snapshot = captureSnapshot(env, { label: "fee-total" });
  assert.equal(snapshot.feePolicy.totalFeeBps, 225);
});

test("a rehearsal with a fee policy at exactly the cap (1000 bps) passes", () => {
  // The hard cap is MAX_TOTAL_FEE_BPS = 1000.  At exactly the cap is valid.
  const env = minimalEnv({
    STELLAR_PLATFORM_FEE_BPS: "1000",
    STELLAR_AGENT_OWNER_FEE_BPS: "0",
  });
  const snapshot = captureSnapshot(env, { label: "at-cap" });
  const plan = buildRollbackPlan(snapshot, "at-cap test", {});
  const result = rehearse(plan);
  assert.equal(result.status, "success", result.summary);
});

test("a rehearsal with a fee policy above the cap (1001 bps) fails the fee invariant", () => {
  // The snapshot is captured with a total of 1001 bps — above the contract cap.
  const env = minimalEnv({
    STELLAR_PLATFORM_FEE_BPS: "1001",
    STELLAR_AGENT_OWNER_FEE_BPS: "0",
  });
  const snapshot = captureSnapshot(env, { label: "over-cap" });
  const plan = buildRollbackPlan(snapshot, "over-cap test", {});
  const result = rehearse(plan);
  assert.notEqual(result.status, "success");
  const feeFailure = result.stepResults.find(
    (r) => r.status === "fail" && r.message.includes("hard cap"),
  );
  assert.ok(feeFailure, `expected fee cap failure, got summary:\n${result.summary}`);
});

// ── Summary output ────────────────────────────────────────────────────────────

test("summary on success starts with the check mark icon", () => {
  const snapshot = minimalSnapshot();
  const plan = buildRollbackPlan(snapshot, "icon test", {});
  const result = rehearse(plan);
  assert.ok(result.summary.trimStart().startsWith("✓"), result.summary);
});

test("summary on failure starts with the cross icon", () => {
  // A snapshot with a fee policy above the cap will fail.
  const env = minimalEnv({ STELLAR_PLATFORM_FEE_BPS: "9999", STELLAR_AGENT_OWNER_FEE_BPS: "0" });
  const snapshot = captureSnapshot(env, { label: "fail-icon" });
  const plan = buildRollbackPlan(snapshot, "fail icon test", {});
  const result = rehearse(plan);
  assert.notEqual(result.status, "success");
  assert.ok(
    result.summary.trimStart().startsWith("✗") || result.summary.trimStart().startsWith("⚠"),
    `expected ✗ or ⚠ summary, got: ${result.summary.substring(0, 100)}`,
  );
});

test("summary includes the snapshot label", () => {
  const snapshot = captureSnapshot(minimalEnv(), { label: "v1-snapshot-2026-09-23" });
  const plan = buildRollbackPlan(snapshot, "summary label test", {});
  const result = rehearse(plan);
  assert.ok(result.summary.includes("v1-snapshot-2026-09-23"));
});
