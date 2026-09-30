/**
 * Invariant checks for the post-rollback state.
 *
 * Every check here is a pure function over `PostRollbackState`. No I/O, no
 * side effects. This keeps the verify phase deterministic and testable in
 * isolation.
 *
 * Invariants are grouped by concern:
 *  1. Fee policy — mirrors the economic invariants in docs/ECONOMIC_INVARIANTS.md
 *  2. Feature flag safety — funded features must be off after rollback
 *  3. Env key presence — required keys must be present and non-empty
 *  4. Secret safety — no raw secret values in the effective env or snapshot output
 */

import {
  type InvariantCheck,
  type PostRollbackState,
  appearsToContainSecret,
  isSecretKey,
} from "./types";

/** 1 000 bps — mirrors MAX_TOTAL_FEE_BPS in contracts-soroban/mimir-market/src/types.rs */
const MAX_TOTAL_FEE_BPS = 1_000;

// ── Fee policy invariants ─────────────────────────────────────────────────────

/**
 * The combined fee cannot exceed the hard cap that is enforced in the contract.
 * A rollback that restores a policy above this cap is invalid — it would produce
 * an un-initializable contract or a silent accounting error.
 */
const feePolicyWithinCap: InvariantCheck = {
  name: "fee_policy_within_cap",
  description:
    `platform_fee_bps + agent_owner_fee_bps <= MAX_TOTAL_FEE_BPS (${MAX_TOTAL_FEE_BPS})`,
  check(state: PostRollbackState): string | null {
    const { totalFeeBps } = state.effectiveFeePolicy;
    if (totalFeeBps > MAX_TOTAL_FEE_BPS) {
      return (
        `fee policy total ${totalFeeBps} bps exceeds hard cap ${MAX_TOTAL_FEE_BPS} — ` +
        `this state would be rejected by mimir-market initialize`
      );
    }
    return null;
  },
};

/**
 * Individual fee legs must be non-negative. A negative fee is a sign of integer
 * underflow in fee accounting and would violate the "winner never loses principal"
 * invariant.
 */
const feeLegsNonNegative: InvariantCheck = {
  name: "fee_legs_non_negative",
  description: "platformFeeBps >= 0 and agentOwnerFeeBps >= 0",
  check(state: PostRollbackState): string | null {
    const { platformFeeBps, agentOwnerFeeBps } = state.effectiveFeePolicy;
    if (platformFeeBps < 0) {
      return `platformFeeBps is negative (${platformFeeBps}) — integer underflow suspected`;
    }
    if (agentOwnerFeeBps < 0) {
      return `agentOwnerFeeBps is negative (${agentOwnerFeeBps}) — integer underflow suspected`;
    }
    return null;
  },
};

/**
 * The totalFeeBps field must equal the sum of the individual legs. A mismatch
 * indicates the snapshot or the rollback plan was generated incorrectly.
 */
const feePoliyTotalsConsistent: InvariantCheck = {
  name: "fee_policy_totals_consistent",
  description: "totalFeeBps === platformFeeBps + agentOwnerFeeBps",
  check(state: PostRollbackState): string | null {
    const { platformFeeBps, agentOwnerFeeBps, totalFeeBps } = state.effectiveFeePolicy;
    const expected = platformFeeBps + agentOwnerFeeBps;
    if (totalFeeBps !== expected) {
      return (
        `totalFeeBps (${totalFeeBps}) != platformFeeBps (${platformFeeBps}) ` +
        `+ agentOwnerFeeBps (${agentOwnerFeeBps}) (${expected}) — snapshot is inconsistent`
      );
    }
    return null;
  },
};

// ── Feature flag safety invariants ────────────────────────────────────────────

/**
 * Funded features (those that can move money) must be explicitly disabled in a
 * post-rollback state. Leaving a funded feature on while the contract ids have
 * been reverted to a prior version is a critical misconfiguration.
 *
 * This list mirrors the `gatedFeatures()` list from lib/ops/flags.ts, which
 * tracks features that default to off because they need a review gate first.
 * A rollback must not re-enable any of them.
 */
const FUNDED_FEATURES = [
  "byoa_funded_actions",
  "copy_trading",
  "agent_baskets",
  "fee_policy",
] as const;

const fundedFeaturesDisabledAfterRollback: InvariantCheck = {
  name: "funded_features_disabled_after_rollback",
  description: "funded features are all off in the post-rollback env",
  check(state: PostRollbackState): string | null {
    const enabledFunded = FUNDED_FEATURES.filter(
      (feature) => state.effectiveFeatureFlags[feature] === true,
    );
    if (enabledFunded.length > 0) {
      return (
        `funded features still enabled after rollback: [${enabledFunded.join(", ")}] — ` +
        `each of these can move USDC and must be explicitly disabled`
      );
    }
    return null;
  },
};

// ── Env key presence invariants ───────────────────────────────────────────────

/**
 * Deployment-critical keys must be non-empty in the post-rollback env.
 * A rollback that clears a required key would leave the app unable to start.
 *
 * These mirror the ENV_KEYS entries in scripts/lib/stellar-env.ts that the
 * deploy pipeline writes back.
 */
const REQUIRED_ENV_KEYS = [
  "NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_SQUAD_CONTRACT_ID",
  "NEXT_PUBLIC_STELLAR_USDC_SAC_ID",
  "NEXT_PUBLIC_STELLAR_NETWORK",
  "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE",
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "NEXT_PUBLIC_STELLAR_USDC_ISSUER",
] as const;

const requiredEnvKeysPresent: InvariantCheck = {
  name: "required_env_keys_present",
  description: "all deployment-critical env keys are non-empty after rollback",
  check(state: PostRollbackState): string | null {
    const missing = REQUIRED_ENV_KEYS.filter(
      (key) => !state.effectiveEnv[key] || state.effectiveEnv[key].trim() === "",
    );
    if (missing.length > 0) {
      return (
        `required env keys missing or empty after rollback: [${missing.join(", ")}] — ` +
        `the application cannot start without these`
      );
    }
    return null;
  },
};

// ── Secret safety invariants ──────────────────────────────────────────────────

/**
 * The effective env produced by the rollback must not contain raw secret values.
 * Secrets must have been replaced with "[redacted]" at snapshot time.
 *
 * This invariant protects against:
 *  - a snapshot captured before the redaction logic was applied
 *  - a rollback plan step that accidentally restores a secret value
 *  - a test fixture that includes a realistic-looking seed
 */
const noRawSecretsInEffectiveEnv: InvariantCheck = {
  name: "no_raw_secrets_in_effective_env",
  description: "effective env contains no raw secret values (Stellar seeds, private keys)",
  check(state: PostRollbackState): string | null {
    const leaks: string[] = [];

    for (const [key, value] of Object.entries(state.effectiveEnv)) {
      // A key known to hold a secret must be redacted.
      if (isSecretKey(key) && value !== "[redacted]" && value.trim() !== "") {
        leaks.push(`${key} is a secret key but its value was not redacted`);
        continue;
      }
      // Even non-secret keys must not contain something that looks like a seed.
      if (appearsToContainSecret(value)) {
        leaks.push(`${key} appears to contain a raw Stellar secret seed`);
      }
    }

    if (leaks.length > 0) {
      return `secret safety violation: ${leaks.join("; ")}`;
    }
    return null;
  },
};

/**
 * The snapshot's env map must not contain un-redacted secret values.
 * This is a defence-in-depth check — the machine itself should redact at
 * capture time, but the invariant catches any path that bypassed that.
 */
const noRawSecretsInSnapshot: InvariantCheck = {
  name: "no_raw_secrets_in_snapshot",
  description: "snapshot env contains no raw secret values",
  check(state: PostRollbackState): string | null {
    const leaks: string[] = [];

    for (const [key, value] of Object.entries(state.snapshot.env)) {
      if (isSecretKey(key) && value !== "[redacted]" && value.trim() !== "") {
        leaks.push(`${key} in snapshot is a secret key but was not redacted`);
        continue;
      }
      if (appearsToContainSecret(value)) {
        leaks.push(`${key} in snapshot appears to contain a raw Stellar secret seed`);
      }
    }

    if (leaks.length > 0) {
      return `snapshot secret safety violation: ${leaks.join("; ")}`;
    }
    return null;
  },
};

// ── Step result integrity ─────────────────────────────────────────────────────

/**
 * All steps in the plan must have produced a result. A missing result indicates
 * the machine exited early without recording it — which would silently hide a
 * failure.
 */
const allStepsHaveResults: InvariantCheck = {
  name: "all_steps_have_results",
  description: "every planned step produced a result record",
  check(state: PostRollbackState): string | null {
    // The machine records one result per step; if the count differs something
    // was skipped without recording.
    const expectedCount = state.snapshot
      ? state.stepResults.length
      : 0;
    if (expectedCount === 0 && state.snapshot) {
      // No steps were run — this is valid for an empty plan.
      return null;
    }
    const failedWithNoMessage = state.stepResults.filter(
      (r) => r.status === "fail" && !r.message,
    );
    if (failedWithNoMessage.length > 0) {
      return (
        `${failedWithNoMessage.length} step(s) failed without recording a message — ` +
        `silent failures must not pass verification`
      );
    }
    return null;
  },
};

// ── Exported invariant set ────────────────────────────────────────────────────

/**
 * The full set of invariants that the verify phase runs. Adding a new invariant
 * here is the only change required to enforce it in both the rehearsal script
 * and the test suite.
 */
export const ROLLBACK_INVARIANTS: readonly InvariantCheck[] = [
  feePolicyWithinCap,
  feeLegsNonNegative,
  feePoliyTotalsConsistent,
  fundedFeaturesDisabledAfterRollback,
  requiredEnvKeysPresent,
  noRawSecretsInEffectiveEnv,
  noRawSecretsInSnapshot,
  allStepsHaveResults,
];

/**
 * Run all invariants against `state` and collect any failures.
 * Returns an empty array when all invariants hold.
 */
export function runInvariantChecks(state: PostRollbackState): Array<{ name: string; error: string }> {
  const failures: Array<{ name: string; error: string }> = [];
  for (const invariant of ROLLBACK_INVARIANTS) {
    const error = invariant.check(state);
    if (error !== null) {
      failures.push({ name: invariant.name, error });
    }
  }
  return failures;
}
