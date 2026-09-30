//! Typed contract events, mirroring the `event` declarations in MimirSquad.sol.

use soroban_sdk::{contractevent, Address, String};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreated {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub captain: Address,
    pub deadline: u64,
    pub fee_bps: u32,
    pub question: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    #[topic]
    pub participant: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub market_id: u64,
    pub result: u32,
    pub pool_a: i128,
    pub pool_b: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub participant: Address,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

/// Pool market state transition event for lifecycle auditing.
/// Emitted on every state change with previous and new states.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketStateTransitioned {
    #[topic]
    pub market_id: u64,
    pub from_state: u32,
    pub to_state: u32,
    pub timestamp: u64,
}

/// Emitted when a pool market's deadline passes and it becomes eligible for resolution.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketDeadlineReached {
    #[topic]
    pub market_id: u64,
    pub deadline: u64,
    pub pool_a_total: i128,
    pub pool_b_total: i128,
}

/// Emitted when liquidity is added to a pool market.
/// Tracks pool depth changes for analytics and risk management.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityAdded {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    pub amount: i128,
    pub new_pool_total: i128,
    pub shares_issued: i128,
}

/// Emitted when liquidity is removed from a pool market before resolution.
/// Distinguishes between pre-deadline withdrawals and post-resolution claims.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityRemoved {
    #[topic]
    pub market_id: u64,
    #[topic]
    pub side: u32,
    pub amount: i128,
    pub new_pool_total: i128,
    pub shares_burned: i128,
}
