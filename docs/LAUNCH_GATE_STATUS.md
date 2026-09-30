# Launch gate status

Last code review: 2026-08-13. Chain-specific evidence requirements updated for
Stellar Testnet: 2026-08-19. A checked implementation gate means the repository has
the required policy, enforcement and automated tests. It does not substitute for the
external evidence below.

## Code-complete gates

| Gate | Evidence | Rollout state |
| --- | --- | --- |
| Duel | Equal stake is enforced in `mimir-market` (`DuelNeedsEqualStake`); payout conservation/profit tests and funnel analytics are in the full suite. | Enabled on the deployed Soroban contract; `npm run verify:deployment` is the check. |
| BYOA funded actions | Signed registry, owner revoke/rotation, atomic budgets, dry-run/simulation and durable audit records. | Off by default until deployment/review evidence is attached. |
| Copy trading | Owner-signed policy, exact on-chain USDC SAC allowance, pause/revoke, depth/cycle guard, atomic rolling caps and realized-loss ceiling. | Off by default until deployment/review evidence is attached. |
| Funded baskets safety boundary | `agent_baskets` is off by default and the accepted ADR forbids deposits before audit/legal/eligibility approval. | No real funds accepted. |
| Public operational status surface | `/api/health/status` unauthenticated telemetry, fail-closed DB & contract checks, withdrawal non-pausability invariant, zero-secret redaction, deterministic clean checkout verification. | Enabled across web routes; `npm run verify:status` is the check. |

## External evidence still required

These gates cannot be honestly completed from source code or synthetic tests:

1. Export enough non-internal production/testnet PostHog traffic and run `npm run verify:analytics -- <export.json>`. The command requires measurable create/stake funnels and at least 99% required-field completeness.
2. Deploy the clean-state contracts on Stellar Testnet (`npm run deploy:contract`), then run `npm run verify:deployment` and `npm run smoke:onchain --resolve --squad`, and retain the contract ids, the deployed WASM hash, ledger sequences, transaction hashes and resolve / refund / pull-payout evidence. `npm run smoke:x402` covers the payment scheme separately.
3. Obtain written product approval for automated-market precision, ambiguity and source-failure thresholds using real shadow-run observations.
4. Obtain an **independent audit of the Soroban contracts** (`contracts-soroban/mimir-market` and `contracts-soroban/mimir-squad`), plus the economic invariant review for funded baskets. The prior EVM review does not carry over — see the status note at the top of `MIMIR_V2_SECURITY_REVIEW.md` for what specifically did and did not survive the port, and for the Soroban-specific surface (authorization sites, storage TTL/archival, ledger-entry footprint under adversarial input, contract-account callers) an audit has to cover.
5. Complete legal/custody, sanctions/eligibility and mainnet launch review; configure redundant production Soroban RPC and Horizon providers and attach monitoring evidence.

Until each item has named approvers and immutable evidence, the corresponding TODO and money-moving feature flag remain open/off.
