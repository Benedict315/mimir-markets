#![cfg(test)]
//! Deterministic settlement dust in pool mode.
//!
//! A winning challenger's gross is `stake + floor(stake * creator_stake /
//! total_challenger_stake)`, which truncates. The truncated remainders add up to
//! the dust, a function of the claim's pools that does not depend on the order
//! challengers pull in. The final challenger to pull receives whatever
//! `remaining_escrow` holds — their formula share plus exactly that dust — so the
//! escrow empties instead of stranding atomic units.
//!
//! These tests pin the dust amount, the final challenger's entitlement, quote /
//! payout parity, and conservation across the whole pull sequence.

extern crate std;

use crate::test_common::{Fixture, USDC};
use crate::types::WinnerSide;

/// `floor(stake * creator_stake / total_challenger_stake)`, recomputed here so the
/// test does not simply restate the contract's arithmetic.
fn share(stake: i128, creator_stake: i128, total_challenger_stake: i128) -> i128 {
    stake * creator_stake / total_challenger_stake
}

/// A pool-mode claim with a 10 USDC creator and three equal 3 USDC challengers.
/// `total_challenger_stake` is 9 USDC, so each share is `floor`ed and one atomic
/// unit is left over.
fn three_challenger_claim(f: &Fixture) -> (u64, soroban_sdk::Address, [soroban_sdk::Address; 3]) {
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);
    let c3 = f.user(100 * USDC);

    let id = f.client().create_claim(&creator, &f.params(10 * USDC));
    f.client().challenge_claim(&c1, &id, &(3 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(3 * USDC), &None);
    f.client().challenge_claim(&c3, &id, &(3 * USDC), &None);

    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("challengers"),
        &90,
        &f.zero_hash(),
    );

    (id, creator, [c1, c2, c3])
}

#[test]
fn the_final_challenger_receives_their_formula_share_plus_the_exact_dust() {
    let f = Fixture::new(0, 0);
    let (id, _creator, [c1, c2, c3]) = three_challenger_claim(&f);

    let creator_stake = 10 * USDC;
    let total_challenger_stake = 9 * USDC;
    let inflow = creator_stake + total_challenger_stake;
    let formula = 3 * USDC + share(3 * USDC, creator_stake, total_challenger_stake);
    let dust = inflow - 3 * formula;
    assert!(dust > 0, "the fixture must truncate or it proves nothing");

    assert_eq!(f.client().get_claim(&id).remaining_escrow, inflow);

    // The first two pullers receive the truncated formula exactly.
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), formula);
    assert_eq!(f.client().claim_challenger_payout(&c2, &id), formula);
    assert_eq!(
        f.client().get_claim(&id).remaining_escrow,
        inflow - 2 * formula
    );

    // The final puller receives their formula share plus the independent dust.
    let final_quote = f.client().quote_challenger_payout(&id, &c3);
    assert_eq!(final_quote.gross, formula + dust);
    assert_eq!(
        f.client().claim_challenger_payout(&c3, &id),
        final_quote.net
    );
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn the_dust_amount_is_identical_whichever_order_challengers_pull_in() {
    let f = Fixture::new(0, 0);
    let (id, _creator, [c1, c2, c3]) = three_challenger_claim(&f);

    let creator_stake = 10 * USDC;
    let total_challenger_stake = 9 * USDC;
    let inflow = creator_stake + total_challenger_stake;
    let formula = 3 * USDC + share(3 * USDC, creator_stake, total_challenger_stake);
    let dust = inflow - 3 * formula;

    // Pull in a different order than the roster was built in. The recipient of
    // the dust changes; the amount does not.
    let first = f.client().quote_challenger_payout(&id, &c3);
    assert_eq!(first.gross, formula);
    assert_eq!(f.client().claim_challenger_payout(&c3, &id), first.net);

    let second = f.client().quote_challenger_payout(&id, &c1);
    assert_eq!(second.gross, formula);
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), second.net);

    let last = f.client().quote_challenger_payout(&id, &c2);
    assert_eq!(last.gross, formula + dust);
    assert_eq!(f.client().claim_challenger_payout(&c2, &id), last.net);

    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn no_dust_when_pool_shares_divide_exactly() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let c1 = f.user(100 * USDC);
    let c2 = f.user(100 * USDC);
    let c3 = f.user(100 * USDC);

    // Creator 9 USDC, challengers 3 USDC each: every share is exactly 3 USDC.
    let id = f.client().create_claim(&creator, &f.params(9 * USDC));
    f.client().challenge_claim(&c1, &id, &(3 * USDC), &None);
    f.client().challenge_claim(&c2, &id, &(3 * USDC), &None);
    f.client().challenge_claim(&c3, &id, &(3 * USDC), &None);
    f.advance_by(3_600);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Challengers,
        &f.str("won"),
        &90,
        &f.zero_hash(),
    );

    let expected = 6 * USDC; // stake 3 + share 3
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), expected);
    assert_eq!(f.client().claim_challenger_payout(&c2, &id), expected);
    // The final challenger too: nothing truncates, so nothing is absorbed.
    assert_eq!(f.client().claim_challenger_payout(&c3, &id), expected);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn conservation_holds_at_every_pull_with_a_fee_configured() {
    let f = Fixture::new(500, 0); // 5% platform fee on profit
    let (id, _creator, [c1, c2, c3]) = three_challenger_claim(&f);

    let creator_stake = 10 * USDC;
    let total_challenger_stake = 9 * USDC;
    let inflow = creator_stake + total_challenger_stake;
    let formula = 3 * USDC + share(3 * USDC, creator_stake, total_challenger_stake);
    let dust = inflow - 3 * formula;

    let mut paid = 0i128;
    for challenger in [&c1, &c2] {
        paid += f.client().claim_challenger_payout(challenger, &id);
        assert_eq!(
            paid + f.client().get_accrued_fees(&f.platform)
                + f.client().get_claim(&id).remaining_escrow,
            inflow,
            "paid + fees + escrow must equal the inflow after every pull"
        );
    }

    // The final puller's gross includes the dust; the fee is taken once.
    let final_quote = f.client().quote_challenger_payout(&id, &c3);
    assert_eq!(final_quote.gross, formula + dust);
    paid += f.client().claim_challenger_payout(&c3, &id);

    assert_eq!(f.client().get_claim(&id).remaining_escrow, 0);
    assert_eq!(paid + f.client().get_accrued_fees(&f.platform), inflow);
    assert_eq!(f.escrow_balance(), f.client().get_accrued_fees(&f.platform));
}

#[test]
fn an_unclaimed_final_share_keeps_the_dust_in_escrow() {
    let f = Fixture::new(0, 0);
    let (id, _creator, [c1, _c2, _c3]) = three_challenger_claim(&f);

    let creator_stake = 10 * USDC;
    let total_challenger_stake = 9 * USDC;
    let inflow = creator_stake + total_challenger_stake;
    let formula = 3 * USDC + share(3 * USDC, creator_stake, total_challenger_stake);
    let dust = inflow - 3 * formula;

    // Only one of the three challengers pulls. The escrow keeps the other two
    // shares and the dust; nothing is overpaid.
    assert_eq!(f.client().claim_challenger_payout(&c1, &id), formula);
    assert_eq!(f.client().get_claim(&id).remaining_escrow, inflow - formula);
    assert!(f.client().get_claim(&id).remaining_escrow >= 2 * formula + dust);
    assert_eq!(
        f.escrow_balance(),
        f.client().get_claim(&id).remaining_escrow
    );
}
