# feat(contracts): batch-read claim state safely

## Summary

Adds `get_claims_batch` to `mimir-market` so callers can read up to 50 claim
structs in one simulated transaction, reducing the Soroban RPC round-trips
needed by the feed and oracle polling paths from O(n) to O(n / 50). The
function is a pure read — no USDC moves, no auth, no state mutations.

---

## What changed

### Rust (`contracts-soroban/mimir-market/src/`)

| File | Change |
|------|--------|
| `types.rs` | Added `MAX_BATCH_SIZE = 50` constant; added `Error::BatchTooLarge = 38` |
| `storage.rs` | Added `get_claim_opt(env, id) -> Option<Claim>` — miss returns `None`, hit bumps TTL |
| `contract.rs` | Added `get_claims_batch(env, ids: Vec<u64>) -> Result<Vec<Option<Claim>>, Error>` |
| `lib.rs` | Registered `test_batch_read` module |
| `test_batch_read.rs` | 18 focused tests (positive, negative, boundary, conservation, regression) |

Two pre-existing bugs also fixed as part of getting the suite green on Rust 1.98:

1. `claims.rs` — borrow-after-move: `snapshot` was moved into `Claim.fees` and
   then referenced again for the `FeePolicySnapshotted` event. Fixed by reading
   from `claim.fees` instead of the moved binding.

2. `test_fees.rs::changing_the_platform_recipient_cannot_redirect_an_existing_claim`
   — the test advanced time by `FEE_TIMELOCK_SECONDS` (2 days) before issuing
   the challenge, which landed past the claim's 1-hour deadline and returned
   `ChallengeWindowClosed`. Fixed by challenging before the timelock advance.

### TypeScript (`lib/contract.ts`)

Added two exports:

- `BATCH_GET_CLAIMS_MAX = 50` — mirrors the contract constant so callers can
  chunk without a magic number.
- `batchGetClaims(ids: number[]) -> Promise<(ClaimData | null)[]>` — throws when
  `ids.length > BATCH_GET_CLAIMS_MAX`; otherwise reads concurrently via the
  existing `readClaimRaw` + `mapWithConcurrency` path. Returns `null` per
  missing id (not a throw), with length always equal to the input.

---

## Accounting

`get_claims_batch` is unconditionally read-only. Every Soroban guarantee that
applies to `get_claim` applies here too:

- No USDC transfer, no escrow change, no fee accrual.
- The returned `Claim` values are byte-for-byte identical to what `get_claim`
  would return individually.
- The `creator_stake`, `total_challenger_stake`, `reserved_creator_liability`,
  `remaining_escrow`, `challenger_claims`, and `fees` snapshot fields are all
  unchanged.
- TTL extension logic is identical: a *present* entry is bumped by the same
  `BUMP_THRESHOLD / BUMP_EXTEND` pair that `get_claim` uses; a *missing* id
  does not touch storage at all.

The conservation invariant `payouts + fees + dust = escrow inflow` that is
tested in `test_settlement.rs` and `lib/fees.ts` is unaffected — this function
never participates in settlement.

---

## Trust model

### What this function can and cannot do

| Capability | `get_claim` | `get_claims_batch` |
|---|---|---|
| Read claim state | ✓ | ✓ |
| Move USDC | ✗ | ✗ |
| Require auth | ✗ | ✗ |
| Modify state | ✗ | ✗ |
| Return partial results on error | ✗ (throws) | ✓ (slot = None) |

Because there is no auth entry and no USDC transfer, an unsigned simulation is
enough to call this function. It is safe to surface through any read-only API
endpoint, including unauthenticated public routes.

### Caller-supplied ids

The function treats `ids` as an untrusted list:

- An id that has never been assigned returns `None` — no contract error, no
  panic.
- Duplicate ids return the same `Claim` value twice — idempotent, no side
  effect from reading twice.
- Id 0 always returns `None` (claim ids start at 1).
- Over-large batches return `BatchTooLarge` before any storage is touched.

None of these inputs can trigger a state change.

### read-index / cache interaction

The Neon Postgres read-index is an optional cache (design principle 1: "contract
state is source of truth"). `batchGetClaims` reads the contract directly, not
the cache. Nothing in this PR inverts that relationship or writes cache rows from
batch data.

---

## Migration

No migration is needed. The change is purely additive:

- `get_claims_batch` is a new function that did not exist on the previous
  deployed contract. Existing callers of `get_claim`, `get_challenger_list`, or
  `get_challengers_page` are unaffected — no call site has changed.
- The `BatchTooLarge` error is a new discriminant (38) in the `Error` enum. The
  existing error codes 1–37 are unchanged.
- The `MAX_BATCH_SIZE` constant is a new public constant; no existing constant
  was renamed or removed.
- The TypeScript `batchGetClaims` helper is new; no existing exported name was
  shadowed or removed.

### Deployment steps

1. Build with `cargo build --release --target wasm32v1-none` and verify the
   WASM digest with `npm run verify:artifacts`.
2. Deploy the new contract WASM (`npm run deploy:contract`). Because the
   function is additive and the ABI is extended (not changed), no state migration
   or re-initialization is needed.
3. Regenerate TypeScript bindings with `npm run stellar:bindings` to expose the
   native `get_claims_batch` binding. The `batchGetClaims` helper in
   `lib/contract.ts` already works without this step (it uses `readClaimRaw`
   internally) and can be upgraded to the native binding post-regeneration.
4. Run `npm run smoke:onchain` to confirm the live contract is reachable.

### Rollback

Because the function is additive, rolling back to the previous contract WASM is
safe — the TypeScript `batchGetClaims` helper falls back to `readClaimRaw` calls
and continues to work against the older contract. There is no stored state to
revert.

---

## Operational impact

### RPC cost

The current implementation issues one simulated invocation per claim id (same
as `readClaimRaw`). After bindings regeneration and upgrade to the native
`get_claims_batch` contract call, a 50-id batch becomes one simulation with 50
ledger-entry reads — a ≈50× reduction in simulated calls for full-range feed
reads.

### Footprint limit

`MAX_BATCH_SIZE = 50` keeps each simulated transaction's persistent-entry
footprint within the Soroban limit. The function deliberately excludes
challenger rosters (`DataKey::Challengers`) to avoid multiplying the footprint
by up to `MAX_CHALLENGERS` (100) per id. Roster reads remain a separate call.

### Rate limits

The helper respects `STELLAR_READ_CONCURRENCY` through `mapWithConcurrency`, so
the public Soroban RPC is not overwhelmed even under a full 50-id batch. The
limit is the same constant already governing `readClaimsRange`.

### Feature flags

No feature flags added. The function is always available once the contract is
deployed. The TypeScript helper is always exported.

### Pause / kill switch

This is a read path. The existing `checkWriteAllowed` guards on `create_claim`
and `challenge_claim` are unrelated to reads and are unaffected. There is no
"pause reads" capability (reads cannot be paused without breaking all callers),
and none is needed here.

---

## Test evidence

```
test result: ok. 136 passed; 0 failed; 0 ignored   (mimir-market)
test result: ok. 65 passed; 0 failed; 0 ignored    (mimir-squad)
wasm32v1-none build: Finished `release` profile, no warnings
npm run typecheck: 0 new errors in lib/contract.ts
npm run check:terms: ✓ no forbidden terms in 527 tracked files
```

New tests in `test_batch_read.rs` (18 tests):

- **Positive:** single id, several ids, empty vec, full MAX_BATCH_SIZE batch
- **Negative:** unknown id → `None`, all unknown, batch too large → `BatchTooLarge`, id 0 → `None`
- **Boundary:** exactly MAX_BATCH_SIZE accepted, MAX_BATCH_SIZE+1 rejected, single-element batch equals `get_claim`
- **Conservation:** batch values match individual `get_claim` calls field-by-field; batch reflects live (post-resolution) state; batch does not mutate escrow; mixed states (Open / Active / Resolved) all returned correctly
- **Regression:** existing `get_claim` unaffected after batch read; duplicate ids return consistent values; output length always equals input length; platform stats (claim count, resolved count, fees_accrued) unchanged after batch read
