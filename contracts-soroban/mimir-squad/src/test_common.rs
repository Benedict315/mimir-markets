#![cfg(test)]
//! Shared test fixture: a registered squad pool backed by a USDC Stellar Asset
//! Contract.

extern crate std;

use soroban_sdk::testutils::{Address as _, IssuerFlags, Ledger, StellarAssetContract};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, String};

use crate::contract::{MimirSquad, MimirSquadClient};

/// One whole USDC in atomic units at the 7 decimals a Stellar Asset Contract
/// exposes for a classic asset.
pub const USDC: i128 = 10_000_000;

pub const START_TIME: u64 = 1_700_000_000;
/// Comfortably inside [MIN_DURATION, MAX_DURATION].
pub const DEFAULT_DURATION: u64 = 3_600;

pub struct Fixture {
    pub env: Env,
    pub contract_id: Address,
    pub token_id: Address,
    pub oracle: Address,
    pub fee_recipient: Address,
    /// The asset contract behind [`Self::token_id`], kept so a test can reach
    /// its issuer: deauthorizing a balance is what a frozen trustline looks
    /// like to the pool, and it needs the issuer's `AUTH_REVOCABLE` flag.
    pub sac: StellarAssetContract,
}

impl Fixture {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = START_TIME);

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        // Lets a test revoke a balance's authorization, which is how a frozen
        // trustline is modelled. Unused by the other suites: the flag only
        // permits revocation, it does not deauthorize anything by itself.
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token_id = sac.address();
        let oracle = Address::generate(&env);
        let fee_recipient = Address::generate(&env);
        let contract_id = env.register(MimirSquad, ());

        MimirSquadClient::new(&env, &contract_id).initialize(&token_id, &oracle, &fee_recipient);

        Fixture {
            env,
            contract_id,
            token_id,
            oracle,
            fee_recipient,
            sac,
        }
    }

    pub fn client(&self) -> MimirSquadClient<'_> {
        MimirSquadClient::new(&self.env, &self.contract_id)
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    pub fn mint(&self, to: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, &self.token_id).mint(to, &amount);
    }

    /// A funded participant.
    pub fn user(&self, funding: i128) -> Address {
        let who = Address::generate(&self.env);
        self.mint(&who, funding);
        who
    }

    pub fn escrow_balance(&self) -> i128 {
        self.token().balance(&self.contract_id)
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    pub fn advance_to(&self, timestamp: u64) {
        self.env.ledger().with_mut(|li| li.timestamp = timestamp);
    }

    pub fn advance_by(&self, seconds: u64) {
        self.advance_to(self.now() + seconds);
    }

    pub fn str(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }

    /// A market with the default one-hour deadline.
    pub fn market(&self, captain: &Address, fee_bps: u32) -> u64 {
        self.client().create_market(
            captain,
            &self.str("Who wins?"),
            &(self.now() + DEFAULT_DURATION),
            &fee_bps,
        )
    }
}
