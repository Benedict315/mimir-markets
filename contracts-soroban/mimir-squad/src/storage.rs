//! Storage keys and typed accessors.

use soroban_sdk::{contracttype, Address, Env};

use crate::types::{Error, Market};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Init,
    Usdc,
    Oracle,
    FeeRecipient,
    MarketCount,
    AccruedFees,
    Market(u64),
    /// (market, side, participant) -> deposited units. Shares equal units.
    Deposit(u64, u32, Address),
    /// (market, side, participant) -> already claimed.
    Claimed(u64, u32, Address),
    /// (market, side, participant) -> payout settled in the ledger but not
    /// delivered, because the token transfer trapped (frozen or deauthorized
    /// trustline). Parked until `claim_parked_payout` can move it.
    Payout(u64, u32, Address),
}

const BUMP_THRESHOLD: u32 = 120_960;
const BUMP_EXTEND: u32 = 518_400;

// ── Config ───────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Init)
}

pub fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Init, &true);
}

fn address(env: &Env, key: DataKey) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&key)
        .ok_or(Error::NotInitialized)
}

pub fn usdc(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::Usdc)
}

pub fn oracle(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::Oracle)
}

pub fn fee_recipient(env: &Env) -> Result<Address, Error> {
    address(env, DataKey::FeeRecipient)
}

pub fn set_config(env: &Env, usdc: &Address, oracle: &Address, fee_recipient: &Address) {
    env.storage().instance().set(&DataKey::Usdc, usdc);
    env.storage().instance().set(&DataKey::Oracle, oracle);
    env.storage()
        .instance()
        .set(&DataKey::FeeRecipient, fee_recipient);
}

// ── Counters ─────────────────────────────────────────────────────────────────

pub fn market_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MarketCount)
        .unwrap_or(0)
}

pub fn set_market_count(env: &Env, value: u64) {
    env.storage().instance().set(&DataKey::MarketCount, &value);
}

pub fn accrued_fees(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::AccruedFees)
        .unwrap_or(0)
}

pub fn set_accrued_fees(env: &Env, value: i128) {
    env.storage().instance().set(&DataKey::AccruedFees, &value);
}

// ── Markets ──────────────────────────────────────────────────────────────────

pub fn get_market(env: &Env, id: u64) -> Result<Market, Error> {
    let key = DataKey::Market(id);
    let market: Market = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::MarketNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
    Ok(market)
}

pub fn set_market(env: &Env, id: u64, market: &Market) {
    let key = DataKey::Market(id);
    env.storage().persistent().set(&key, market);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Deposits & claims ────────────────────────────────────────────────────────

pub fn deposit_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Deposit(id, side, who.clone()))
        .unwrap_or(0)
}

pub fn set_deposit(env: &Env, id: u64, side: u32, who: &Address, value: i128) {
    let key = DataKey::Deposit(id, side, who.clone());
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

pub fn has_claimed(env: &Env, id: u64, side: u32, who: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Claimed(id, side, who.clone()))
}

pub fn mark_claimed(env: &Env, id: u64, side: u32, who: &Address) {
    let key = DataKey::Claimed(id, side, who.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}

// ── Parked payouts ───────────────────────────────────────────────────────────

/// Payout settled in the ledger but not delivered yet. Zero means nothing is
/// parked, and writing zero removes the entry rather than storing a zero.
pub fn payout_of(env: &Env, id: u64, side: u32, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Payout(id, side, who.clone()))
        .unwrap_or(0)
}

pub fn set_payout(env: &Env, id: u64, side: u32, who: &Address, value: i128) {
    let key = DataKey::Payout(id, side, who.clone());
    if value == 0 {
        env.storage().persistent().remove(&key);
        return;
    }
    env.storage().persistent().set(&key, &value);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_EXTEND);
}
