# Claim metadata bounds

Every free-text field a caller commits to a `Claim` is now bounded, at the
contract boundary, before any money moves. Previously the fields mirrored
Solidity `string` and were unbounded: a caller could store an arbitrarily large
question, position, resolution URL, category, market-config string or oracle
summary in one persistent entry, paying a per-byte rent the contract carries and
forcing every indexer and agent to re-read it.

## The bounds

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_METADATA_BYTES` | 512 | Per-field cap for any single metadata string. |
| `MAX_CLAIM_METADATA_BYTES` | 2 048 | Aggregate cap across every metadata string on one claim. |

`mimir-market` checks the fields `question`, `creator_position`,
`counter_position`, `resolution_url`, `category`, `market_type`,
`handicap_line`, `settlement_rule` and the oracle's `resolution_summary`.
`mimir-squad` applies the same 512-byte cap to the market `question`
(`MAX_QUESTION_BYTES`).

Empty fields still fall back to their existing defaults (`custom`, `binary`);
the fallback bytes are counted as they will be stored, so the budget describes
the claim that is actually written. `odds_mode` is normalized to `fixed`/`pool`
on write and is not free text, and the invite key is hashed under
`MAX_INVITE_KEY_BYTES`, so neither is part of the metadata budget.

## Errors

Two typed errors were appended to `mimir-market::Error`, and one to
`mimir-squad::Error`. Discriminants are appended, never renumbered, so the
existing error ABI is unchanged.

| Error | Codes | Raised when |
| --- | --- | --- |
| `MetadataTooLong` | market `41` | One string exceeds `MAX_METADATA_BYTES` (`mimir-squad` uses `QuestionTooLong`, `27`). |
| `ClaimMetadataTooLong` | market `42` | A claim's combined metadata would exceed `MAX_CLAIM_METADATA_BYTES`. |

An over-long value is **refused, never truncated**: what is stored is exactly
what the caller supplied, so a digest, URL or settlement rule is never silently
cut to a different value.

## Where it is enforced

- `create_claim` validates the whole `CreateParams` metadata budget **before**
  `escrow::pull`, so a rejected claim moves no money and consumes no claim id.
- `resolve_claim` / `resolve_claim_versioned` validates the `resolution_summary`
  before any state is written, so a rejected summary leaves the claim `Active`
  and the escrow untouched.

## Accounting and trust

The bound is pure input validation: no payment, fee, escrow or permission path
changes, and conservation is unaffected. Because both checks run before the
first storage write and before `escrow::pull`, a rejected call is a no-op — the
same fail-closed shape as `StakeTooSmall` or `InvalidConfidence`. No new
auth is required, and the metadata was already public on chain, so no secret or
private value becomes representable.

## Migration

No on-chain data migration is required. The bound is enforced on new writes,
and existing claims are read as they always were. A claim whose free text
predates the bound (already over the aggregate budget) can still resolve: the
summary's own 512-byte cap still applies, but the aggregate check is skipped for
that claim, so an existing funded market is never bricked by the new limit. This
is covered by `a_legacy_over_budget_claim_can_still_resolve`.

## Operational notes

- Callers (UI, workers, agents) should validate before submitting and surface
  `MetadataTooLong` / `ClaimMetadataTooLong` (`41` / `42`) as an input error, not
  a retryable one.
- Indexers do not need a schema change: the stored shapes are unchanged, and
  errors only appear on rejected transactions.
- There is no feature flag: the bound is unconditional, so there is nothing to
  toggle at deploy time.

## Rollback

Rollback is a code revert. No data was rewritten and no flag needs unwinding;
claims created under the bound remain valid, and reverting simply removes the
enforcement (the stored fields read exactly as before).

## Verification

Focused tests live in `contracts-soroban/mimir-market/src/test_lifecycle.rs`
(creation bounds, exact-boundary aggregate, no-money-moved) and
`test_verdict.rs` (summary bounds, aggregate interaction, legacy compatibility),
plus `mimir-squad` `test_lifecycle.rs`. Run them with:

```bash
cd contracts-soroban
cargo test -p mimir-market
cargo test -p mimir-squad
cargo build -p mimir-market --target wasm32-unknown-unknown --release
cargo build -p mimir-squad --target wasm32-unknown-unknown --release
```
