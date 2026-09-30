#![cfg(test)]
//! Deterministic settlement dust.
//!
//! A winning pool's shares truncate, so `floor(total * principal / winner_pool)`
//! can leave a few atomic units over. The remainder — the dust — is a function
//! of the pools alone, so it is the same whichever order the winners claim in.
//! The final winner receives their formula share plus exactly that dust, and the
//! escrow empties to zero.
//!
//! These tests pin all three facts: the dust amount is order-independent, the
//! final winner's payout is their formula share plus the dust, and preview and
//! payout agree because both read the same `winner_gross`.

extern crate std;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{SIDE_A, SIDE_B};

/// `floor((pool_a + pool_b) * principal / winner_pool)` — the non-final winner's
/// formula, recomputed here so the test does not trust the contract's own math.
fn formula(principal: i128, winner_pool: i128, total: i128) -> i128 {
    total * principal / winner_pool
}

/// Three winners of one USDC each, a seven USDC losing pool. The winning pool is
/// 3 USDC, the total 10 USDC, so each formula share is `floor(1_000_000_0 * ...)`
/// and the remainder is a single atomic unit.
fn three_winner_market(f: &Fixture, fee_bps: u32) -> (u64, [soroban_sdk::Address; 3]) {
    let captain = f.user(0);
    let winner_a = f.user(100 * USDC);
    let winner_b = f.user(100 * USDC);
    let winner_c = f.user(100 * USDC);
    let loser = f.user(100 * USDC);

    let id = f.market(&captain, fee_bps);
    f.client().deposit(&winner_a, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&winner_b, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&winner_c, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&loser, &id, &SIDE_B, &(7 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    (id, [winner_a, winner_b, winner_c])
}

#[test]
fn the_final_winner_receives_their_formula_share_plus_the_exact_dust() {
    let f = Fixture::new();
    let (id, [a1, a2, a3]) = three_winner_market(&f, 0);

    let total = 10 * USDC;
    let winner_pool = 3 * USDC;
    let share = formula(1 * USDC, winner_pool, total); // 3_333_333
    let expected_dust = total - 3 * share;
    assert!(
        expected_dust > 0,
        "the fixture must truncate or it proves nothing"
    );

    assert_eq!(f.client().get_market(&id).remaining_escrow, total);

    // The two non-final winners get the truncated formula exactly.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), share);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), share);
    assert_eq!(
        f.client().get_market(&id).remaining_escrow,
        total - 2 * share
    );

    // The final winner receives the formula share the two before them received,
    // plus every remaining atomic unit.
    let final_payout = f.client().claim(&a3, &id, &SIDE_A);
    assert_eq!(final_payout, share + expected_dust);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn the_dust_amount_is_identical_whichever_order_the_winners_claim_in() {
    let f = Fixture::new();
    let (id, [a1, a2, a3]) = three_winner_market(&f, 0);

    let total = 10 * USDC;
    let winner_pool = 3 * USDC;
    let share = formula(1 * USDC, winner_pool, total);
    let dust = total - 3 * share;

    // Claim in a different order than the roster was built in. The recipient of
    // the dust changes; the amount does not.
    assert_eq!(f.client().claim(&a3, &id, &SIDE_A), share);
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), share);
    let final_payout = f.client().claim(&a2, &id, &SIDE_A);

    assert_eq!(final_payout, share + dust);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn no_dust_when_the_winning_pool_divides_the_total_exactly() {
    let f = Fixture::new();
    let captain = f.user(0);
    let a1 = f.user(100 * USDC);
    let a2 = f.user(100 * USDC);
    let a3 = f.user(100 * USDC);
    let b1 = f.user(100 * USDC);

    // Winning pool 3 USDC, total 9 USDC: every share is exactly 3 USDC.
    let id = f.market(&captain, 0);
    f.client().deposit(&a1, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&a2, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&a3, &id, &SIDE_A, &(1 * USDC));
    f.client().deposit(&b1, &id, &SIDE_B, &(6 * USDC));
    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    let expected = 3 * USDC;
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), expected);
    assert_eq!(f.client().claim(&a2, &id, &SIDE_A), expected);
    // Final winner too: nothing truncates, so nothing is absorbed.
    assert_eq!(f.client().claim(&a3, &id, &SIDE_A), expected);
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), 0);
}

#[test]
fn conservation_holds_at_every_pull_with_a_fee_configured() {
    let f = Fixture::new();
    let (id, [a1, a2, a3]) = three_winner_market(&f, 500); // 5% profit fee

    let total = 10 * USDC;
    let winner_pool = 3 * USDC;
    let share = formula(1 * USDC, winner_pool, total);
    let dust = total - 3 * share;

    let mut paid = 0i128;
    for winner in [&a1, &a2] {
        paid += f.client().claim(winner, &id, &SIDE_A);
        assert_eq!(
            paid + f.client().get_accrued_fees() + f.client().get_market(&id).remaining_escrow,
            total,
            "paid + fees + escrow must equal the inflow after every pull"
        );
    }

    // The final winner's gross — before the fee — is their formula share plus the
    // dust; the net is that less the profit fee.
    let final_preview = f.client().preview_claim(&id, &SIDE_A, &a3);
    assert_eq!(final_preview.gross, share + dust);
    let final_payout = f.client().claim(&a3, &id, &SIDE_A);
    assert_eq!(final_payout, final_preview.net);
    paid += final_payout;

    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(paid + f.client().get_accrued_fees(), total);
    assert_eq!(f.escrow_balance(), f.client().get_accrued_fees());
}

#[test]
fn preview_matches_the_final_payout_and_is_zero_after_the_pull() {
    let f = Fixture::new();
    let (id, [a1, a2, a3]) = three_winner_market(&f, 500);

    f.client().claim(&a1, &id, &SIDE_A);

    // The final winner is previewed the same `winner_gross` the payout will use.
    let preview = f.client().preview_claim(&id, &SIDE_A, &a3);
    let net = f.client().claim(&a3, &id, &SIDE_A);
    assert_eq!(preview.net, net);
    assert_eq!(preview.gross - preview.fee, net);

    // `claim` is a no-op after the pull, so the preview must be too.
    let after = f.client().preview_claim(&id, &SIDE_A, &a3);
    assert_eq!(after.gross, 0);
    assert_eq!(after.net, 0);

    // Unrelated: `a2` is the last remaining winner and still previews cleanly.
    let remaining = f.client().preview_claim(&id, &SIDE_A, &a2);
    assert_eq!(remaining.net, f.client().claim(&a2, &id, &SIDE_A));
}

#[test]
fn an_unclaimed_final_share_keeps_the_dust_in_escrow() {
    let f = Fixture::new();
    let (id, [a1, _a2, _a3]) = three_winner_market(&f, 0);

    let total = 10 * USDC;
    let winner_pool = 3 * USDC;
    let share = formula(1 * USDC, winner_pool, total);
    let dust = total - 3 * share;

    // Only one of the three winners pulls. The escrow keeps the other two shares
    // and the dust; nothing is overpaid.
    assert_eq!(f.client().claim(&a1, &id, &SIDE_A), share);
    assert_eq!(f.client().get_market(&id).remaining_escrow, total - share);
    assert!(f.client().get_market(&id).remaining_escrow >= 2 * share + dust);
    assert_eq!(
        f.escrow_balance(),
        f.client().get_market(&id).remaining_escrow
    );
}
