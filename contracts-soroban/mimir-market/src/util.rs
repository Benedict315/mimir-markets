//! Small helpers: string hashing, metadata bounds, and string equality.

use soroban_sdk::{Bytes, BytesN, Env, String};

use crate::types::{
    Claim, CreateParams, Error, MAX_CLAIM_METADATA_BYTES, MAX_INVITE_KEY_BYTES, MAX_METADATA_BYTES,
};

/// keccak256 of a `String`'s UTF-8 bytes.
///
/// Soroban's `env.crypto()` exposes `keccak256`, so the invite-key hash is
/// byte-for-byte identical to the Solidity `keccak256(bytes(inviteKey))`. The
/// only difference is the length bound: marshalling a host `String` into guest
/// memory needs a fixed buffer, hence [`MAX_INVITE_KEY_BYTES`].
pub fn hash_string(env: &Env, s: &String) -> Result<BytesN<32>, Error> {
    let len = s.len();
    if len > MAX_INVITE_KEY_BYTES {
        return Err(Error::InviteKeyTooLong);
    }
    let mut buf = [0u8; MAX_INVITE_KEY_BYTES as usize];
    let slice = &mut buf[..len as usize];
    s.copy_into_slice(slice);
    let bytes = Bytes::from_slice(env, slice);
    Ok(env.crypto().keccak256(&bytes).to_bytes())
}

pub fn is_fixed_odds(env: &Env, odds_mode: &String) -> bool {
    *odds_mode == String::from_str(env, "fixed")
}

/// `value` when non-empty, otherwise `fallback`.
pub fn or_default(env: &Env, value: &String, fallback: &str) -> String {
    if value.is_empty() {
        String::from_str(env, fallback)
    } else {
        value.clone()
    }
}

// ── Metadata bounds ──────────────────────────────────────────────────────────

/// Check one metadata string against the per-field cap and return its byte
/// length so callers can accumulate the claim's total.
fn metadata_len(s: &String) -> Result<u32, Error> {
    let len = s.len();
    if len > MAX_METADATA_BYTES {
        return Err(Error::MetadataTooLong);
    }
    Ok(len)
}

/// Sum `metadata_len` over a slice of strings, failing on overflow.
fn metadata_sum(values: &[&String]) -> Result<u32, Error> {
    let mut total = 0u32;
    for value in values {
        total = total
            .checked_add(metadata_len(*value)?)
            .ok_or(Error::Overflow)?;
    }
    Ok(total)
}

/// Sum raw byte lengths of stored strings, failing only on overflow.
fn raw_len_sum(values: &[&String]) -> Result<u32, Error> {
    let mut total = 0u32;
    for value in values {
        total = total.checked_add(value.len()).ok_or(Error::Overflow)?;
    }
    Ok(total)
}

/// Bound every free-text field a `create_claim` caller commits to storage.
///
/// Each field is checked against [`MAX_METADATA_BYTES`] and their sum against
/// [`MAX_CLAIM_METADATA_BYTES`]. The normalized fallbacks (`custom` /
/// `binary`) are counted as they will actually be stored, so the budget
/// describes the claim that is written. Called before any funds move: an
/// over-long claim is refused with nothing escrowed.
pub fn validate_create_metadata(env: &Env, params: &CreateParams) -> Result<(), Error> {
    let category = or_default(env, &params.category, "custom");
    let market_type = or_default(env, &params.market_type, "binary");
    let total = metadata_sum(&[
        &params.question,
        &params.creator_position,
        &params.counter_position,
        &params.resolution_url,
        &category,
        &market_type,
        &params.handicap_line,
        &params.settlement_rule,
    ])?;
    if total > MAX_CLAIM_METADATA_BYTES {
        return Err(Error::ClaimMetadataTooLong);
    }
    Ok(())
}

/// The combined metadata length of an already-stored claim.
///
/// Stored fields are summed without the per-field cap: a legacy claim created
/// before the bound may hold longer strings and must still be able to resolve.
pub fn stored_metadata_len(claim: &Claim) -> Result<u32, Error> {
    raw_len_sum(&[
        &claim.question,
        &claim.creator_position,
        &claim.counter_position,
        &claim.resolution_url,
        &claim.category,
        &claim.market.market_type,
        &claim.market.handicap_line,
        &claim.market.settlement_rule,
    ])
}

/// Bound the oracle's `resolution_summary` against the same aggregate budget.
///
/// A claim created under the budget cannot exceed it when the summary lands.
/// A claim whose free text predates the bound (created before this rule) is
/// still allowed to resolve: only the summary's own per-field cap applies to
/// it, so an existing funded market is never bricked by the new limit — this is
/// the migration path, and it needs no on-chain data change.
pub fn validate_resolution_summary(claim: &Claim, summary: &String) -> Result<(), Error> {
    let summary_len = metadata_len(summary)?;
    let stored = stored_metadata_len(claim)?;
    if stored <= MAX_CLAIM_METADATA_BYTES
        && stored.checked_add(summary_len).ok_or(Error::Overflow)? > MAX_CLAIM_METADATA_BYTES
    {
        return Err(Error::ClaimMetadataTooLong);
    }
    Ok(())
}
