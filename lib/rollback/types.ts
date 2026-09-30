/**
 * Shared types for the deployment rollback rehearsal.
 *
 * The rehearsal models the deploy-then-rollback lifecycle as a simple state
 * machine. All types here are plain data structures — no I/O, no side effects.
 * This makes them safe to import from tests and the script alike.
 *
 * A "rehearsal" is a dry run of a rollback: it takes a snapshot of the current
 * deployment config (env keys, contract ids, feature flag state, fee policy),
 * runs the rollback steps against that snapshot, and verifies that the resulting
 * state satisfies every invariant.
 *
 * Nothing in this file touches the chain. It is intentionally offline-safe so
 * CI can run it with no credentials.
 */

// ── Deployment snapshot ───────────────────────────────────────────────────────

/**
 * A point-in-time view of every config value that a rollback would need to
 * restore. Captured before a deploy begins and stored alongside the artifact
 * so a rollback can restore it exactly.
 */
export interface DeploymentSnapshot {
  /** ISO 8601 timestamp when this snapshot was captured. */
  capturedAt: string;

  /** Arbitrary label, e.g. "pre-v1.2.0-deploy". */
  label: string;

  /**
   * Env-key → value map of deployment-critical variables.
   * Secrets (keys whose names end in _SECRET or _SEED) are replaced by the
   * string "[redacted]" at capture time and are never written to disk.
   */
  env: Record<string, string>;

  /** Feature flag state at snapshot time (feature → enabled). */
  featureFlags: Record<string, boolean>;

  /** Pause state at snapshot time (capability → paused). */
  pauseState: Record<string, boolean>;

  /** Fee policy bps frozen in the snapshot. */
  feePolicy: SnapshotFeePolicy;

  /**
   * The set of contract ids that were live at snapshot time.
   * On Stellar Testnet these are `C…` strkeys.
   */
  contractIds: SnapshotContractIds;
}

export interface SnapshotFeePolicy {
  platformFeeBps: number;
  agentOwnerFeeBps: number;
  /** Combined total — must stay <= MAX_TOTAL_FEE_BPS (1 000). */
  totalFeeBps: number;
}

export interface SnapshotContractIds {
  market?: string;
  squad?: string;
  usdcSac?: string;
}

// ── Rollback step ─────────────────────────────────────────────────────────────

/**
 * A single discrete action in a rollback plan. Steps are deterministic: given
 * the same snapshot and environment they always produce the same result.
 */
export type RollbackStepKind =
  | "pause_capability"
  | "revert_feature_flag"
  | "restore_env_key"
  | "restore_contract_id"
  | "verify_fee_invariant"
  | "verify_no_secret_leak"
  | "verify_env_keys_present";

export interface RollbackStep {
  kind: RollbackStepKind;
  /** Human-readable description of what this step does. */
  description: string;
  /**
   * The key being acted on, e.g. the capability name, the feature flag name,
   * or the env var key. Optional for verification steps.
   */
  target?: string;
  /**
   * The value that will be restored, e.g. "1" (paused) or the contract id.
   * Not set for verification steps.
   */
  restoreValue?: string;
}

// ── Step execution result ─────────────────────────────────────────────────────

export type StepStatus = "pass" | "fail" | "skip";

export interface StepResult {
  step: RollbackStep;
  status: StepStatus;
  /** Why the step passed, failed, or was skipped. */
  message: string;
  /**
   * Duration of this step in milliseconds (wall-clock).
   * Populated by the machine, not the step itself.
   */
  durationMs: number;
}

// ── Rollback plan ─────────────────────────────────────────────────────────────

/**
 * The ordered list of steps that would execute during a real rollback. The plan
 * is generated from the snapshot + the list of funded features being rolled back.
 *
 * Ordering matters: pause first (fail-closed), then revert flags, then restore
 * env keys and contract ids, then verify invariants.
 */
export interface RollbackPlan {
  /** Human-readable name of what is being rolled back. */
  description: string;
  /**
   * The snapshot that defines the target post-rollback state.
   * The machine verifies that running all steps produces exactly this state.
   */
  snapshot: DeploymentSnapshot;
  steps: RollbackStep[];
}

// ── Rehearsal result ──────────────────────────────────────────────────────────

export type RehearsalStatus = "success" | "failure" | "partial";

export interface RehearsalResult {
  plan: RollbackPlan;
  stepResults: StepResult[];
  status: RehearsalStatus;
  /** Total wall-clock duration across all steps, in milliseconds. */
  totalDurationMs: number;
  /**
   * Number of steps that failed. Zero when status is "success".
   * The rehearsal is a dry run — no real deployment state is changed.
   */
  failedSteps: number;
  /**
   * Number of steps that were skipped, e.g. because a prerequisite failed.
   */
  skippedSteps: number;
  /**
   * Human-readable summary suitable for a PR description or incident report.
   * Does not contain secret values.
   */
  summary: string;
}

// ── Verification invariant ────────────────────────────────────────────────────

/**
 * An invariant check applied to a post-rollback state. Mirrors the structure
 * of the economic invariants in docs/ECONOMIC_INVARIANTS.md.
 */
export interface InvariantCheck {
  name: string;
  description: string;
  /**
   * Returns null when the invariant holds, or an error message when it does not.
   * Must be a pure function.
   */
  check: (state: PostRollbackState) => string | null;
}

/**
 * The effective environment after all rollback steps have been simulated.
 * This is what the verify phase runs its invariant checks against.
 */
export interface PostRollbackState {
  /** The original pre-rollback snapshot. */
  snapshot: DeploymentSnapshot;
  /** The env map after restore_env_key steps have been applied. */
  effectiveEnv: Record<string, string>;
  /** The feature flag map after revert_feature_flag steps have been applied. */
  effectiveFeatureFlags: Record<string, boolean>;
  /** The pause map after pause_capability steps have been applied. */
  effectivePauseState: Record<string, boolean>;
  /** Fee policy after any fee-related restore steps. */
  effectiveFeePolicy: SnapshotFeePolicy;
  /** The step results produced by the machine, available for invariant checks. */
  stepResults: StepResult[];
}

// ── Secret detection ──────────────────────────────────────────────────────────

/**
 * Patterns that, if found in an env value, indicate the value is a secret that
 * must not appear in any output or snapshot.
 *
 * These mirror real conventions in this project:
 *  - Stellar seed phrases begin with 'S' followed by 55 uppercase base32 chars
 *  - Keys named *_SECRET, *_SEED, or *_MNEMONIC hold secrets
 */
export const SECRET_ENV_KEY_PATTERNS: RegExp[] = [
  /_SECRET$/,
  /_SEED$/,
  /_MNEMONIC$/,
  /_PRIVATE_KEY$/,
];

/**
 * A Stellar secret seed starts with S and is 56 characters of uppercase base32.
 * Matches on the value, not the key name.
 */
export const STELLAR_SECRET_VALUE_PATTERN: RegExp = /\bS[A-Z2-7]{55}\b/;

/**
 * Returns true if the env key name indicates a secret and must be redacted.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Returns true if the value looks like a raw secret (e.g. a Stellar seed).
 */
export function appearsToContainSecret(value: string): boolean {
  return STELLAR_SECRET_VALUE_PATTERN.test(value);
}
