# Deployment Rollback Rehearsal

A deterministic dry run that verifies a Mimir deployment can be rolled back safely before any live change is shipped. Designed around funded-feature safety: it will fail closed rather than silently leaving a USDC-moving feature enabled against a reverted contract.

---

## Why this exists

Mimir ships funded features — capability flags that can move real USDC (staking, copy trading, BYOA funded actions, fee policy). Rolling back any of these without a checklist risks:

- A funded feature flag left enabled after the contract id is reverted (money can flow against the wrong contract).
- A deployment-critical env key silently cleared (the app starts but cannot connect to the chain).
- A raw secret inadvertently surfaced in a snapshot or incident report.
- A fee policy above the hard cap (1 000 bps) restored from a stale backup.

The rehearsal makes every one of these a hard failure **before** the deploy exits the PR review phase.

---

## Quick start

```bash
# From a clean checkout — no credentials needed.
npm run rollback:rehearsal

# Against a live .env.local (does not touch the chain or the filesystem).
npm run rollback:rehearsal:live
```

Both commands exit 0 on success and 1 on any invariant violation.

---

## How it works

The rehearsal runs four phases in order:

```
snapshot → verify_pre → simulate → verify_post
```

### Phase 1 — snapshot

Captures the current deployment configuration into a `DeploymentSnapshot`:

- Env key → value map (secrets are replaced by `[redacted]` at capture time — they never enter the snapshot)
- Feature flag state (`MIMIR_FEATURE_*`)
- Pause state (`MIMIR_PAUSE_*`)
- Fee policy (`STELLAR_PLATFORM_FEE_BPS`, `STELLAR_AGENT_OWNER_FEE_BPS`)
- Contract ids (`NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID`, etc.)

In CI, where no `.env.local` is configured, the script uses a deterministic fixture (`FIXTURE_ENV` in `scripts/rollback-rehearsal.ts`) that exercises every code path without requiring credentials.

### Phase 2 — simulate rollback

Applies each step of the rollback plan to an in-memory copy of the state:

| Step kind | What it does |
|---|---|
| `pause_capability` | Sets a capability to paused (`MIMIR_PAUSE_*=1`). Applied **first** — fail closed. |
| `revert_feature_flag` | Resets a feature flag to its snapshot value. Applied **after** pauses. |
| `restore_env_key` | Restores an env key to its snapshot value. |
| `restore_contract_id` | Restores a contract id env key. |
| `verify_fee_invariant` | Checks fee policy is within cap and legs are non-negative. |
| `verify_no_secret_leak` | Checks no raw secrets in the effective env or snapshot. |
| `verify_env_keys_present` | Checks all deployment-critical keys are non-empty. |

No files are written. No chain calls are made. The simulation is purely in-memory.

### Phase 3 — verify_post (invariants)

After all steps, the following invariants are checked:

| Invariant | What it enforces |
|---|---|
| `fee_policy_within_cap` | `platformFeeBps + agentOwnerFeeBps <= 1 000` — the hard cap from `mimir-market/src/types.rs` |
| `fee_legs_non_negative` | Neither fee leg is negative (integer underflow guard) |
| `fee_policy_totals_consistent` | `totalFeeBps == platformFeeBps + agentOwnerFeeBps` |
| `funded_features_disabled_after_rollback` | `fee_policy`, `copy_trading`, `byoa_funded_actions`, `agent_baskets` are all off |
| `required_env_keys_present` | Seven deployment-critical keys are non-empty |
| `no_raw_secrets_in_effective_env` | No raw Stellar seeds in the post-rollback env |
| `no_raw_secrets_in_snapshot` | No raw Stellar seeds in the snapshot itself |
| `all_steps_have_results` | Every step produced a result (no silent exits) |

---

## Executing a real rollback

> The rehearsal is not a substitute for a runbook. It proves the plan is internally consistent; the operator still executes each step.

1. **Before shipping a funded feature**, capture a snapshot and run the rehearsal:

   ```bash
   npm run rollback:rehearsal:live
   ```

   Commit the exit code to your PR checklist. If it exits non-zero, fix the cause before merging.

2. **During an incident**, follow this order to fail closed as quickly as possible:

   ```
   a. Pause write capabilities immediately (no deploy needed, immediate effect):
      MIMIR_PAUSE_STAKE=1 MIMIR_PAUSE_CREATE_MARKET=1 ... (redeploy Railway env vars or update .env)

   b. Disable funded feature flags:
      MIMIR_FEATURE_FEE_POLICY=0 MIMIR_FEATURE_COPY_TRADING=0 ...

   c. Restore contract ids in .env.local:
      NEXT_PUBLIC_STELLAR_MARKET_CONTRACT_ID=<previous value>

   d. Redeploy Vercel + Railway with the restored env.

   e. Run the rehearsal one more time to verify the restored state:
      npm run rollback:rehearsal:live

   f. Un-pause write capabilities only after verification passes.
   ```

3. **After the incident**, run the full rehearsal with the pre-incident snapshot as the fixture to produce a post-incident verification record.

---

## Artifact and secret handling

| Artifact | Stored? | Contains secrets? |
|---|---|---|
| Snapshot (in-memory, rehearsal only) | No | Secrets redacted to `[redacted]` |
| Step results (printed to stdout) | No | Secrets never printed |
| Rollback plan | No | Secrets never included |
| `.env.local` | Yes (gitignored) | Seeds present, never committed |

The rehearsal **never writes to disk**. If you want to persist a snapshot for audit purposes, pipe stdout to a file — all secret values will already be redacted.

---

## Failure behavior

A rehearsal failure is **not** the same as a real rollback failure. The rehearsal is a dry run: it cannot block a deploy by itself. The contract is:

- CI runs `npm run rollback:rehearsal` and will fail the build if the rehearsal exits non-zero.
- A PR author must fix the rehearsal before merging.
- A rehearsal that exits 0 means: given the current fixture, the rollback plan is internally consistent and all invariants hold. It does not mean the production state is safe — it means the tooling works.

Failures are always **actionable**: every failed step has a message explaining exactly what was wrong. No failure is silent.

---

## Testing

```bash
# Run the rollback tests in isolation.
node --import tsx --test tests/node/rollback.test.ts

# Or run all node tests (includes rollback).
npm run test:smoke
```

The test file (`tests/node/rollback.test.ts`) covers:

- Positive: clean fixture passes end-to-end
- Negative: each invariant can be individually violated and caught
- Failure: missing step targets, bad fee policy, secret leaks
- Regression: raw secrets cannot leak through snapshot capture

All tests are deterministic — no network, no filesystem, no real secrets.

---

## Adding a new invariant

1. Add the check function to `lib/rollback/verify.ts` as an `InvariantCheck`.
2. Add it to the `ROLLBACK_INVARIANTS` array.
3. Add a test in `tests/node/rollback.test.ts` that violates the invariant and checks it is caught.
4. Run `npm run typecheck && npm run test:smoke` to confirm everything is green.

---

## Files

| File | Purpose |
|---|---|
| `lib/rollback/types.ts` | Shared types: snapshots, steps, results, secret detection |
| `lib/rollback/verify.ts` | Invariant check functions |
| `lib/rollback/machine.ts` | State machine: `captureSnapshot`, `buildRollbackPlan`, `rehearse` |
| `lib/rollback/index.ts` | Public API barrel export |
| `scripts/rollback-rehearsal.ts` | CLI script: fixture, plan building, output |
| `tests/node/rollback.test.ts` | Full test coverage |
| `docs/ROLLBACK.md` | This document |
