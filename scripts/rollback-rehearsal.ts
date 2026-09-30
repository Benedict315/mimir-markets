/**
 * Deployment rollback rehearsal script.
 *
 * Simulates a complete rollback of the current deployment without touching the
 * chain, the filesystem, or any live credentials. Safe to run from a clean
 * checkout in CI or locally with no secrets configured.
 *
 * What it does:
 *   1. Captures a snapshot of the deployment config from the environment (or a
 *      deterministic fixture when no env is configured).
 *   2. Builds a rollback plan that pauses write capabilities, disables funded
 *      features, and restores deployment-critical env keys.
 *   3. Runs the rollback rehearsal state machine over the plan.
 *   4. Prints a step-by-step report and exits non-zero if any step fails.
 *
 * Usage:
 *   npm run rollback:rehearsal
 *   npx tsx scripts/rollback-rehearsal.ts [--fixture] [--fail-fast] [--quiet]
 *
 * Flags:
 *   --fixture    Force the deterministic fixture even when env vars are set.
 *                Use this in CI to get a reproducible baseline.
 *   --fail-fast  Stop after the first failing step.
 *   --quiet      Only print the summary, not the step-by-step output.
 *
 * Exit codes:
 *   0  — all steps passed (rehearsal is safe)
 *   1  — one or more steps failed (investigate before deploying)
 *   2  — script configuration error
 */
import { FEATURES, PAUSABLE } from "../lib/ops/flags";
import { buildRollbackPlan, captureSnapshot, rehearse } from "../lib/rollback";
import type { RehearsalOptions } from "../lib/rollback/machine";

// ── Deterministic fixture ─────────────────────────────────────────────────────

/**
 * A fully-specified env that mirrors a realistic Mimir Testnet deployment.
 * Every value here is safe to commit: no real secrets, no live contract ids.
 * The fixture is used in CI (where no .env.local exists) and when --fixture is
 * passed explicitly.
 *
 * Contract ids use the real `C…` strkey prefix and character set but are not
 * real deployed contracts. They exercise the format validation and the
 * post-rollback env-key presence checks.
 */
export const FIXTURE_ENV: Record<string, string> = {
  // Deployment-critical keys (required by the verify_env_keys_present step).
  NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID:
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACT2X",
  NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID:
    "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ",
  NEXT_PUBLIC_STELLAR_USDC_SAC_ID:
    "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD",
  NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  NEXT_PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  NEXT_PUBLIC_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  NEXT_PUBLIC_STELLAR_USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",

  // Fee policy (valid, below the hard cap).
  STELLAR_PLATFORM_FEE_BPS: "200",
  STELLAR_AGENT_OWNER_FEE_BPS: "0",

  // Secrets — always redacted in snapshots. These values are placeholders;
  // the script replaces them with "[redacted]" before they enter the snapshot.
  STELLAR_DEPLOYER_SECRET: "PLACEHOLDER_WILL_BE_REDACTED",
  STELLAR_ORACLE_SECRET: "PLACEHOLDER_WILL_BE_REDACTED",
};

/**
 * Feature flag state in the fixture: funded features are OFF (gated) as they
 * are in a freshly-cloned repo.
 */
export const FIXTURE_FEATURE_FLAGS: Record<string, boolean> = Object.fromEntries(
  FEATURES.map((feature) => {
    // Funded features that require a review gate default to off.
    const fundedAndGated = new Set(["byoa_funded_actions", "copy_trading", "agent_baskets", "fee_policy"]);
    return [feature, !fundedAndGated.has(feature)];
  }),
);

/**
 * Pause state in the fixture: nothing is paused (normal operating state).
 */
export const FIXTURE_PAUSE_STATE: Record<string, boolean> = Object.fromEntries(
  PAUSABLE.map((capability) => [capability, false]),
);

// ── Main ──────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const useFixture = args.has("--fixture");
const failFast = args.has("--fail-fast");
const quiet = args.has("--quiet");

function resolveEnv(): {
  env: Record<string, string>;
  featureFlags: Record<string, boolean>;
  pauseState: Record<string, boolean>;
  usingFixture: boolean;
} {
  // Use the fixture when explicitly requested or when the deployment-critical
  // keys are absent (clean checkout without .env.local).
  const hasLiveConfig =
    !useFixture &&
    Boolean(process.env["NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID"]?.trim());

  if (!hasLiveConfig) {
    return {
      env: FIXTURE_ENV,
      featureFlags: FIXTURE_FEATURE_FLAGS,
      pauseState: FIXTURE_PAUSE_STATE,
      usingFixture: true,
    };
  }

  // Build feature flag state from live env.
  const liveFeatureFlags: Record<string, boolean> = Object.fromEntries(
    FEATURES.map((feature) => {
      const envKey = `MIMIR_FEATURE_${feature.toUpperCase()}`;
      const raw = process.env[envKey];
      if (raw === "1") return [feature, true];
      if (raw === "0") return [feature, false];
      // Match FEATURE_DEFAULTS from lib/ops/flags.ts.
      const fundedAndGated = new Set(["byoa_funded_actions", "copy_trading", "agent_baskets", "fee_policy"]);
      return [feature, !fundedAndGated.has(feature)];
    }),
  );

  // Build pause state from live env.
  const livePauseState: Record<string, boolean> = Object.fromEntries(
    PAUSABLE.map((capability) => {
      const envKey = `MIMIR_PAUSE_${capability.toUpperCase()}`;
      return [capability, process.env[envKey] === "1" || process.env["MIMIR_PAUSE_ALL"] === "1"];
    }),
  );

  // Pull live env values but strip undefined.
  const liveEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  return { env: liveEnv, featureFlags: liveFeatureFlags, pauseState: livePauseState, usingFixture: false };
}

async function main(): Promise<void> {
  const { env, featureFlags, pauseState, usingFixture } = resolveEnv();

  if (!quiet) {
    console.log("── Mimir deployment rollback rehearsal ──");
    console.log(`  mode      : ${usingFixture ? "deterministic fixture (no live credentials needed)" : "live env"}`);
    console.log("");
  }

  // Step 1: Capture snapshot.
  const snapshot = captureSnapshot(env, {
    label: usingFixture ? "fixture:pre-deploy" : "live:pre-deploy",
    featureFlags,
    pauseState,
  });

  if (!quiet) {
    console.log(`[snapshot] ${snapshot.label} @ ${snapshot.capturedAt}`);
    console.log(`  market contract : ${snapshot.contractIds.market ?? "(not set)"}`);
    console.log(`  squad contract  : ${snapshot.contractIds.squad ?? "(not set)"}`);
    console.log(`  fee policy      : platform=${snapshot.feePolicy.platformFeeBps}bps agent=${snapshot.feePolicy.agentOwnerFeeBps}bps total=${snapshot.feePolicy.totalFeeBps}bps`);
    console.log(
      `  feature flags   : ${Object.entries(snapshot.featureFlags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "(none enabled)"}`,
    );
    console.log("");
  }

  // Step 2: Build the rollback plan.
  // In a real incident the operator would select which features to roll back
  // and which capabilities to pause. Here we exercise the full set.
  const plan = buildRollbackPlan(snapshot, "full deployment rollback (rehearsal)", {
    pauseCapabilities: ["stake", "create_market", "copy_execution", "oracle_settlement"],
    revertFeatures: ["byoa_funded_actions", "copy_trading", "agent_baskets", "fee_policy"],
    restoreEnvKeys: ["*"],
  });

  if (!quiet) {
    console.log(`[plan] ${plan.description}`);
    console.log(`  steps: ${plan.steps.length}`);
    console.log("");
  }

  // Step 3: Run the rehearsal.
  const rehearsalOptions: RehearsalOptions = { failFast };
  const result = rehearse(plan, rehearsalOptions);

  // Step 4: Print results.
  if (!quiet) {
    for (const sr of result.stepResults) {
      const icon = sr.status === "pass" ? "✓" : sr.status === "skip" ? "·" : "✗";
      console.log(`  ${icon} [${sr.step.kind}] ${sr.step.description}`);
      if (sr.status !== "pass") {
        console.log(`      ${sr.message}`);
      }
    }
    console.log("");
  }

  console.log(result.summary);

  if (result.status !== "success") {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(
    "rollback-rehearsal failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(2);
});
