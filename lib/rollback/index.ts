/**
 * Deployment rollback rehearsal — public API.
 *
 * The rollback rehearsal lets you verify that a deployment can be safely rolled
 * back before shipping. Run it against a snapshot of your pre-deploy config:
 *
 *   npm run rollback:rehearsal
 *
 * Or use the library directly from a test or script:
 *
 *   import { captureSnapshot, buildRollbackPlan, rehearse } from "../lib/rollback";
 *
 *   const snapshot = captureSnapshot(process.env, { label: "pre-deploy" });
 *   const plan = buildRollbackPlan(snapshot, "v1.2.0 rollback", {
 *     pauseCapabilities: ["stake", "create_market"],
 *     revertFeatures: ["fee_policy", "byoa_funded_actions"],
 *     restoreEnvKeys: ["*"],
 *   });
 *   const result = rehearse(plan);
 *   if (result.status !== "success") process.exit(1);
 *
 * See docs/ROLLBACK.md for full documentation.
 */
export { captureSnapshot, buildRollbackPlan, rehearse } from "./machine";
export { ROLLBACK_INVARIANTS, runInvariantChecks } from "./verify";
export type {
  DeploymentSnapshot,
  InvariantCheck,
  PostRollbackState,
  RehearsalResult,
  RehearsalStatus,
  RollbackPlan,
  RollbackStep,
  RollbackStepKind,
  SnapshotContractIds,
  SnapshotFeePolicy,
  StepResult,
  StepStatus,
} from "./types";
export { isSecretKey, appearsToContainSecret, SECRET_ENV_KEY_PATTERNS } from "./types";
