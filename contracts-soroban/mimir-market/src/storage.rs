//! Storage keys and typed accessors.
//!
//! Globals live in instance storage (small, always loaded with the contract).
//! Per-claim and per-address rows live in persistent storage.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::types::{Challenger, Claim, Error, FeePolicy, PendingFeePolicy, RematchStatus};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// One-time initialisation guard.
    Init,
    Owner,
    Oracle,
    Usdc,
    Policy,
    Pending,
    ClaimCount,
    TotalResolved,
    FeesAccrued,
    FeesClaimed,
    Claim(u64),
    Challengers(u64),
    /// Pull-payment fallback for failed payout pushes.
    Withdrawable(Address),
    /// Accrued, unclaimed fees. Always pulled, never pushed.
    Accrued(Address),
    /// Rematch parent link validation cache: (parent_id, child_id) -> RematchStatus
    RematchParent(u64, u64),
}

/// Persistent entries are bumped to roughly 30 days of ledgers on touch so an
/// open market cannot be archived out from under its participants.
const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;

// ── Globals ──────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Init)
}

pub fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Init, &true);
}

pub fn owner(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Owner)
        .ok_or(Error::NotInitialized)
}

pub fn set_owner(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Owner, who);
}

pub fn oracle(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(Error::NotInitialized)
}

pub fn set_oracle(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Oracle, who);
}

pub fn usdc(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Usdc)
        .ok_or(Error::NotInitialized)
}

pub fn set_usdc(env: &Env, who: &Address) {
    env.storage().instance().set(&DataKey::Usdc, who);
}

pub fn fee_policy(env: &Env) -> Result<FeePolicy, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Policy)
        .ok_or(Error::NotInitialized)
}

pub fn set_fee_policy(env: &Env, policy: &FeePolicy) {
    env.storage().instance().set(&DataKey::Policy, policy);
}

pub fn pending_fee_policy(env: &Env) -> Option<PendingFeePolicy> {
    env.storage().instance().get(&DataKey::Pending)
}

pub fn set_pending_fee_policy(env: &Env, pending: &PendingFeePolicy) {
    env.storage().instance().set(&DataKey::Pending, pending);
}

pub fn clear_pending_fee_policy(env: &Env) {
    env.storage().instance().remove(&DataKey::Pending);
}

fn counter(env: &Env, key: DataKey) -> u64 {
    env.storage().instance().get(&key).unwrap_or(0)
}

fn set_counter(env: &Env, key: DataKey, value: u64) {
    env.storage().instance().set(&key, &value);
}

pub fn claim_count(env: &Env) -> u64 {
    counter(env, DataKey::ClaimCount)
}

pub fn set_claim_count(env: &Env, value: u64) {
    set_counter(env, DataKey::ClaimCount, value);
}

pub fn total_resolved(env: &Env) -> u64 {
    counter(env, DataKey::TotalResolved)
}

pub fn bump_total_resolved(env: &Env) {
    let next = total_resolved(env) + 1;
    set_counter(env, DataKey::TotalResolved, next);
}

fn amount(env: &Env, key: DataKey) -> i128 {
    env.storage().instance().get(&key).unwrap_or(0)
}

pub fn lifetime_fees_accrued(env: &Env) -> i128 {
    amount(env, DataKey::FeesAccrued)
}

pub fn add_lifetime_fees_accrued(env: &Env, delta: i128) {
    let next = lifetime_fees_accrued(env) + delta;
    env.storage().instance().set(&DataKey::FeesAccrued, &next);
}

pub fn lifetime_fees_claimed(env: &Env) -> i128 {
    amount(env, DataKey::FeesClaimed)
}

pub fn add_lifetime_fees_claimed(env: &Env, delta: i128) {
    let next = lifetime_fees_claimed(env) + delta;
    env.storage().instance().set(&DataKey::FeesClaimed, &next);
}

// ── Claims ───────────────────────────────────────────────────────────────────

pub fn get_claim(env: &Env, id: u64) -> Result<Claim, Error> {
    let key = DataKey::Claim(id);
    let claim: Claim = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::ClaimNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    Ok(claim)
}

/// Return `Some(claim)` if the entry exists, `None` if it does not.
///
/// Unlike [`get_claim`], a miss does NOT bump the TTL (there is nothing to
/// extend) and does NOT return an error, so it is the right primitive for
/// batch reads where a missing id is a normal, non-fatal answer.
///
/// A present entry still receives its usual TTL extension so an open market
/// cannot expire while a batch is being constructed.
pub fn get_claim_opt(env: &Env, id: u64) -> Option<Claim> {
    let key = DataKey::Claim(id);
    match env.storage().persistent().get::<_, Claim>(&key) {
        Some(claim) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            Some(claim)
        }
        None => None,
    }
}

pub fn set_claim(env: &Env, id: u64, claim: &Claim) {
    let key = DataKey::Claim(id);
    env.storage().persistent().set(&key, claim);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn challengers(env: &Env, id: u64) -> Vec<Challenger> {
    let key = DataKey::Challengers(id);
    match env.storage().persistent().get::<_, Vec<Challenger>>(&key) {
        Some(list) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
            list
        }
        None => Vec::new(env),
    }
}

pub fn set_challengers(env: &Env, id: u64, list: &Vec<Challenger>) {
    let key = DataKey::Challengers(id);
    env.storage().persistent().set(&key, list);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Per-address rows ─────────────────────────────────────────────────────────

fn address_i128(env: &Env, key: DataKey) -> i128 {
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn set_address_i128(env: &Env, key: DataKey, value: i128) {
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn withdrawable(env: &Env, who: &Address) -> i128 {
    address_i128(env, DataKey::Withdrawable(who.clone()))
}

pub fn add_withdrawable(env: &Env, who: &Address, delta: i128) {
    let key = DataKey::Withdrawable(who.clone());
    let next = address_i128(env, key.clone()) + delta;
    set_address_i128(env, key, next);
}

pub fn clear_withdrawable(env: &Env, who: &Address) {
    set_address_i128(env, DataKey::Withdrawable(who.clone()), 0);
}

pub fn accrued_fees(env: &Env, who: &Address) -> i128 {
    address_i128(env, DataKey::Accrued(who.clone()))
}

pub fn add_accrued_fees(env: &Env, who: &Address, delta: i128) {
    let key = DataKey::Accrued(who.clone());
    let next = address_i128(env, key.clone()) + delta;
    set_address_i128(env, key, next);
}

pub fn clear_accrued_fees(env: &Env, who: &Address) {
    set_address_i128(env, DataKey::Accrued(who.clone()), 0);
}

// ── Rematch Parent Link Validation ───────────────────────────────────────────

pub fn get_rematch_parent_status(
    env: &Env,
    parent_id: u64,
    child_id: u64,
) -> Option<RematchStatus> {
    let key = DataKey::RematchParent(parent_id, child_id);
    env.storage().persistent().get(&key)
}

pub fn set_rematch_parent_status(
    env: &Env,
    parent_id: u64,
    child_id: u64,
    status: &RematchStatus,
) {
    let key = DataKey::RematchParent(parent_id, child_id);
    env.storage().persistent().set(&key, status);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn clear_rematch_parent_status(env: &Env, parent_id: u64, child_id: u64) {
    let key = DataKey::RematchParent(parent_id, child_id);
    env.storage().persistent().remove(&key);
}
