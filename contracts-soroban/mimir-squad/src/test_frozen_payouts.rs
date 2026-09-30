#![cfg(test)]
//! Frozen (deauthorized) trustlines: a payout that cannot be delivered is
//! parked and retried, never dropped and never allowed to revert a claim.
//!
//! A Stellar Asset Contract refuses to credit a deauthorized balance, so the
//! transfer traps. Before parking, that trap aborted the whole `claim`: a winner
//! whose trustline was frozen could not settle at all, and `claim_fees` could be
//! blocked by a frozen fee recipient. These tests pin the parked path and the
//! accounting either side of it.

extern crate std;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::Address;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, RESULT_CANCELLED, SIDE_A, SIDE_B};

impl Fixture {
    /// Deauthorize a trustline, the way a frozen account is modelled: the
    /// balance can no longer be credited, so a transfer into it traps.
    pub fn freeze(&self, who: &Address, authorized: bool) {
        StellarAssetClient::new(&self.env, &self.token_id).set_authorized(who, &authorized);
    }
}

/// One market, one winning depositor on `SIDE_A`, resolved, with the winning
/// payout computed by the contract itself.
struct Settled {
    f: Fixture,
    winner: Address,
    id: u64,
    net: i128,
}

fn settled_market(fee_bps: u32) -> Settled {
    let f = Fixture::new();
    let captain = f.user(0);
    let winner = f.user(100 * USDC);
    let loser = f.user(100 * USDC);
    let id = f.market(&captain, fee_bps);

    f.client().deposit(&winner, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&loser, &id, &SIDE_B, &(30 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    let net = f.client().preview_claim(&id, &SIDE_A, &winner).net;
    assert_eq!(net, 37 * USDC, "gross 40 less a 10% fee on 30 profit");
    Settled { f, winner, id, net }
}

// ── The winner's payout ──────────────────────────────────────────────────────

#[test]
fn a_frozen_trustline_parks_the_payout_instead_of_reverting_the_claim() {
    let s = settled_market(1_000);
    let f = &s.f;
    let before = f.token().balance(&s.winner);

    f.freeze(&s.winner, false);

    // The claim settles: it must not trap just because the payout cannot move.
    assert_eq!(f.client().claim(&s.winner, &s.id, &SIDE_A), s.net);

    // Claimed, owed, and not paid: the amount is parked for the winner.
    assert!(f.client().has_claimed(&s.id, &SIDE_A, &s.winner));
    assert_eq!(f.client().parked_payout(&s.id, &SIDE_A, &s.winner), s.net);
    assert_eq!(f.token().balance(&s.winner), before);
    // The money is still in the contract, not stranded in a limbo balance.
    assert_eq!(f.escrow_balance(), s.net + f.client().get_accrued_fees());
    assert_eq!(f.client().get_market(&s.id).remaining_escrow, 0);
}

#[test]
fn a_parked_payout_moves_once_the_trustline_is_authorized_again() {
    let s = settled_market(1_000);
    let f = &s.f;
    let before = f.token().balance(&s.winner);
    f.freeze(&s.winner, false);
    f.client().claim(&s.winner, &s.id, &SIDE_A);

    f.freeze(&s.winner, true);
    assert_eq!(
        f.client().claim_parked_payout(&s.winner, &s.id, &SIDE_A),
        s.net
    );

    assert_eq!(f.token().balance(&s.winner), before + s.net);
    assert_eq!(f.client().parked_payout(&s.id, &SIDE_A, &s.winner), 0);
    // Only the fee is left behind now.
    assert_eq!(f.escrow_balance(), f.client().get_accrued_fees());
}

#[test]
fn a_parked_payout_pays_once_however_often_it_is_retried() {
    let s = settled_market(1_000);
    let f = &s.f;
    f.freeze(&s.winner, false);
    f.client().claim(&s.winner, &s.id, &SIDE_A);
    f.freeze(&s.winner, true);
    f.client().claim_parked_payout(&s.winner, &s.id, &SIDE_A);

    // A retry loop is idempotent: nothing left to move, nothing paid twice.
    assert_eq!(f.client().claim_parked_payout(&s.winner, &s.id, &SIDE_A), 0);
    assert_eq!(
        f.token().balance(&s.winner),
        90 * USDC + s.net,
        "100 funded less the 10 deposited, then the payout exactly once"
    );
}

#[test]
fn retrying_while_still_frozen_reports_the_parked_state_and_keeps_the_amount() {
    let s = settled_market(1_000);
    let f = &s.f;
    f.freeze(&s.winner, false);
    f.client().claim(&s.winner, &s.id, &SIDE_A);

    assert_eq!(
        f.client()
            .try_claim_parked_payout(&s.winner, &s.id, &SIDE_A)
            .unwrap_err()
            .unwrap(),
        Error::PayoutParked
    );
    // Refused, not lost: the amount is still parked and still in escrow.
    assert_eq!(f.client().parked_payout(&s.id, &SIDE_A, &s.winner), s.net);
    assert_eq!(f.escrow_balance(), s.net + f.client().get_accrued_fees());
}

#[test]
fn a_winner_with_a_healthy_trustline_never_touches_the_parked_path() {
    let s = settled_market(1_000);
    let f = &s.f;

    assert_eq!(f.client().claim(&s.winner, &s.id, &SIDE_A), s.net);
    assert_eq!(f.client().parked_payout(&s.id, &SIDE_A, &s.winner), 0);
    assert_eq!(f.token().balance(&s.winner), 90 * USDC + s.net);
}

// ── The fee recipient ────────────────────────────────────────────────────────

#[test]
fn a_frozen_fee_recipient_defers_fees_without_blocking_claims() {
    let s = settled_market(1_000);
    let f = &s.f;
    f.client().claim(&s.winner, &s.id, &SIDE_A);
    let fee = f.client().get_accrued_fees();
    assert_eq!(fee, 3 * USDC);

    f.freeze(&f.fee_recipient, false);
    assert_eq!(
        f.client().try_claim_fees().unwrap_err().unwrap(),
        Error::PayoutParked
    );

    // The call reverted, so nothing moved: the fee is still accrued, still in
    // escrow, and still owed. A frozen recipient cannot lose their fees by
    // trying to claim them.
    assert_eq!(f.client().get_accrued_fees(), fee);
    assert_eq!(f.escrow_balance(), fee);
    assert_eq!(f.token().balance(&f.fee_recipient), 0);

    // Retrying while still frozen is the same no-op, however often it happens.
    assert_eq!(
        f.client().try_claim_fees().unwrap_err().unwrap(),
        Error::PayoutParked
    );
    assert_eq!(f.client().get_accrued_fees(), fee);
    assert_eq!(f.escrow_balance(), fee);
}

#[test]
fn deferred_fees_are_paid_with_the_next_successful_claim() {
    let s = settled_market(1_000);
    let f = &s.f;
    f.client().claim(&s.winner, &s.id, &SIDE_A);
    let fee = f.client().get_accrued_fees();

    f.freeze(&f.fee_recipient, false);
    assert_eq!(
        f.client().try_claim_fees().unwrap_err().unwrap(),
        Error::PayoutParked
    );
    f.freeze(&f.fee_recipient, true);

    // The retry pulls everything that was owed, including whatever accrued
    // while the recipient was frozen.
    assert_eq!(f.client().claim_fees(), fee);
    assert_eq!(f.token().balance(&f.fee_recipient), fee);
    assert_eq!(f.client().get_accrued_fees(), 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn a_frozen_fee_recipient_does_not_block_the_next_market_paying_its_winner() {
    let s = settled_market(1_000);
    let f = &s.f;
    f.client().claim(&s.winner, &s.id, &SIDE_A);

    f.freeze(&f.fee_recipient, false);
    assert_eq!(
        f.client().try_claim_fees().unwrap_err().unwrap(),
        Error::PayoutParked
    );

    let other = f.user(100 * USDC);
    let captain = f.user(0);
    let second = f.market(&captain, 0);
    f.client().deposit(&other, &second, &SIDE_A, &(5 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&second, &SIDE_A);

    // The second market is fee-free, so its winner is paid in full even though
    // the first market's fee is stuck where only the recipient can move it.
    assert_eq!(f.client().claim(&other, &second, &SIDE_A), 5 * USDC);
    assert_eq!(f.token().balance(&other), 95 * USDC + 5 * USDC);
    assert_eq!(f.client().get_accrued_fees(), 3 * USDC);
    assert_eq!(f.escrow_balance(), 3 * USDC);
}

// ── The floor under both paths ───────────────────────────────────────────────

#[test]
fn parked_payouts_of_two_winners_are_counted_separately() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(30 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(40 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    f.freeze(&a1, false);
    f.freeze(&a2, false);
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 20 * USDC);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), 60 * USDC);

    assert_eq!(f.client().parked_payout(&id, &SIDE_A, &a1), 20 * USDC);
    assert_eq!(f.client().parked_payout(&id, &SIDE_A, &a2), 60 * USDC);
    assert_eq!(f.escrow_balance(), 80 * USDC);

    f.freeze(&a1, true);
    assert_eq!(f.client().claim_parked_payout(&a1, &id, &SIDE_A), 20 * USDC);
    // a2's share is untouched by a1's recovery.
    assert_eq!(f.client().parked_payout(&id, &SIDE_A, &a2), 60 * USDC);
    assert_eq!(f.escrow_balance(), 60 * USDC);
}

#[test]
fn a_cancelled_market_refund_is_parked_too() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);
    let id = f.market(&captain, 0);

    f.client().deposit(&a1, &id, &SIDE_A, &(10 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(10 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &RESULT_CANCELLED);

    f.freeze(&a1, false);
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), 10 * USDC);
    assert_eq!(f.client().parked_payout(&id, &SIDE_A, &a1), 10 * USDC);

    f.freeze(&a1, true);
    assert_eq!(f.client().claim_parked_payout(&a1, &id, &SIDE_A), 10 * USDC);
    // A refund pays the principal back in full: no fee was charged.
    assert_eq!(f.token().balance(&a1), 100 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);
}
