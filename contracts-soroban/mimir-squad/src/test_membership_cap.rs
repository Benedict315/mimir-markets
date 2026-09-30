#![cfg(test)]
//! Tests for the total squad-membership cap (`MAX_SQUAD_MEMBERS`).
//!
//! Coverage:
//! - **Positive**: squad fills to exactly the cap across mixed sides; the
//!   filling deposit succeeds and emits `SquadFull`.
//! - **Negative**: a new depositor is rejected with `Error::SquadFull` once the
//!   total equals `MAX_SQUAD_MEMBERS`; topping up an existing position is still
//!   accepted.
//! - **Boundary**: cap is one beyond the last accepted member; last-minus-one is
//!   always accepted; the cap + 1 is always rejected.
//! - **Conservation**: payouts and fees are unaffected by the cap — the
//!   accounting is identical once the market resolves.
//! - **Regression**: the per-side cap (`SideFull`) still fires when a single
//!   side is full even if the total has not reached `MAX_SQUAD_MEMBERS`.
//! - **Slot reuse**: a full withdrawal frees a total slot so a new depositor
//!   can join again.
//! - **Event**: `SquadFull` is emitted exactly once, on the deposit that fills
//!   the last slot, and is never emitted for a top-up.

extern crate std;

use soroban_sdk::testutils::Events;
use soroban_sdk::Address;

use crate::test_common::{Fixture, DEFAULT_DURATION, USDC};
use crate::types::{Error, MAX_PARTICIPANTS_PER_SIDE, MAX_SQUAD_MEMBERS, RESULT_CANCELLED, SIDE_A, SIDE_B};

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Fill `n` distinct participants into `side` of `market_id`, each depositing
/// `USDC`.  Returns the addresses so callers can keep references.
fn fill_side(f: &Fixture, market_id: u64, side: u32, n: u32) -> std::vec::Vec<Address> {
    let mut members = std::vec::Vec::new();
    for _ in 0..n {
        let who = f.user(USDC);
        f.client().deposit(&who, &market_id, &side, &USDC);
        members.push(who);
    }
    members
}

// ─────────────────────────────────────────────────────────────────────────────
// Positive: squad fills to exactly MAX_SQUAD_MEMBERS
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn squad_accepts_up_to_max_squad_members_total() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Half on each side.
    let half = MAX_SQUAD_MEMBERS / 2;
    fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    let m = f.client().get_market(&id);
    assert_eq!(m.participants_a, half);
    assert_eq!(m.participants_b, half);
    assert_eq!(m.participants_a + m.participants_b, MAX_SQUAD_MEMBERS);
}

#[test]
fn squad_accepts_uneven_split_up_to_max_squad_members() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Use a 100 / 300 split to check the cap is total-based, not per-side.
    // Side B has 300 — but MAX_PARTICIPANTS_PER_SIDE is 200, so we can only do
    // 200 each.  Use 150 / 250 instead (total = 400 = MAX_SQUAD_MEMBERS).
    let a_count = 150u32;
    let b_count = MAX_SQUAD_MEMBERS - a_count; // 250 — but per-side cap is 200

    // Since per-side cap is 200, clamp to that.
    let a_count = a_count.min(MAX_PARTICIPANTS_PER_SIDE);
    let b_count = b_count.min(MAX_PARTICIPANTS_PER_SIDE);
    // a_count=150, b_count=200 → total = 350 < 400; both fits.
    fill_side(&f, id, SIDE_A, a_count);
    fill_side(&f, id, SIDE_B, b_count);

    let m = f.client().get_market(&id);
    assert_eq!(m.participants_a, a_count);
    assert_eq!(m.participants_b, b_count);
    // Total is below MAX_SQUAD_MEMBERS since we clamped.
    assert!(m.participants_a + m.participants_b <= MAX_SQUAD_MEMBERS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Negative: SquadFull blocks new depositors
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn new_depositor_is_rejected_when_total_equals_max_squad_members() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Fill both sides evenly to MAX_SQUAD_MEMBERS total.
    let half = MAX_SQUAD_MEMBERS / 2; // = 200
    fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    // A brand-new address cannot join either side.
    let overflow_a = f.user(USDC);
    let err = f
        .client()
        .try_deposit(&overflow_a, &id, &SIDE_A, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SquadFull);

    let overflow_b = f.user(USDC);
    let err = f
        .client()
        .try_deposit(&overflow_b, &id, &SIDE_B, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SquadFull);

    // No USDC moved.
    assert_eq!(f.token().balance(&overflow_a), USDC);
    assert_eq!(f.token().balance(&overflow_b), USDC);
}

#[test]
fn existing_depositor_can_top_up_when_squad_is_full() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let half = MAX_SQUAD_MEMBERS / 2;
    let side_a = fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    // Total is now MAX_SQUAD_MEMBERS, but the first side-A member can top up.
    f.mint(&side_a[0], USDC);
    f.client().deposit(&side_a[0], &id, &SIDE_A, &USDC);
    assert_eq!(
        f.client().get_deposit(&id, &SIDE_A, &side_a[0]),
        2 * USDC
    );

    // Participant count must not change.
    let m = f.client().get_market(&id);
    assert_eq!(m.participants_a, half);
    assert_eq!(m.participants_b, half);
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn boundary_last_slot_is_accepted_and_next_is_rejected() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Fill to one below the cap.
    let half = MAX_SQUAD_MEMBERS / 2; // 200
    fill_side(&f, id, SIDE_A, half);
    // Fill B to half - 1 so total = MAX_SQUAD_MEMBERS - 1.
    fill_side(&f, id, SIDE_B, half - 1);

    {
        let m = f.client().get_market(&id);
        assert_eq!(
            m.participants_a + m.participants_b,
            MAX_SQUAD_MEMBERS - 1
        );
    }

    // The (MAX_SQUAD_MEMBERS - 1)th slot should still be accepted.
    let last = f.user(USDC);
    f.client().deposit(&last, &id, &SIDE_B, &USDC);

    {
        let m = f.client().get_market(&id);
        assert_eq!(m.participants_a + m.participants_b, MAX_SQUAD_MEMBERS);
    }

    // The next new depositor must be rejected.
    let one_over = f.user(USDC);
    let err = f
        .client()
        .try_deposit(&one_over, &id, &SIDE_B, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SquadFull);
}

#[test]
fn zero_members_can_always_join() {
    // Brand-new market, no participants yet — first depositor must never be
    // blocked by the membership cap.
    let f = Fixture::new();
    let captain = f.user(0);
    let id = f.market(&captain, 0);
    let a1 = f.user(USDC);

    f.client().deposit(&a1, &id, &SIDE_A, &USDC);
    assert_eq!(f.client().get_market(&id).participants_a, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression: per-side cap still fires when a side is full but total is not
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn side_full_fires_when_a_single_side_is_full_below_total_cap() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Fill side A to MAX_PARTICIPANTS_PER_SIDE.  Total = 200 < 400.
    fill_side(&f, id, SIDE_A, MAX_PARTICIPANTS_PER_SIDE);

    // A new address trying side A should get SideFull, not SquadFull.
    let newcomer = f.user(USDC);
    let err = f
        .client()
        .try_deposit(&newcomer, &id, &SIDE_A, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SideFull);

    // But they can still join side B.
    f.client().deposit(&newcomer, &id, &SIDE_B, &USDC);
    assert_eq!(f.client().get_market(&id).participants_b, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot reuse: withdrawal frees total slots
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn full_withdrawal_frees_a_total_slot_allowing_a_new_member() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let half = MAX_SQUAD_MEMBERS / 2;
    let side_a = fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    // Squad is full; a new depositor is blocked.
    let newcomer = f.user(USDC);
    assert_eq!(
        f.client()
            .try_deposit(&newcomer, &id, &SIDE_A, &USDC)
            .unwrap_err()
            .unwrap(),
        Error::SquadFull
    );

    // One side-A member fully withdraws.
    f.client()
        .withdraw_before_deadline(&side_a[0], &id, &SIDE_A, &USDC);
    assert_eq!(
        f.client().get_market(&id).participants_a,
        half - 1
    );

    // The newcomer can now join.
    f.client().deposit(&newcomer, &id, &SIDE_A, &USDC);
    assert_eq!(f.client().get_market(&id).participants_a, half);
}

#[test]
fn partial_withdrawal_does_not_free_a_total_slot() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let half = MAX_SQUAD_MEMBERS / 2;
    let side_a = fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    // Partial withdrawal: member keeps their slot.
    f.mint(&side_a[0], 2 * USDC); // they already spent USDC to fill; remint
    f.client().deposit(&side_a[0], &id, &SIDE_A, &(2 * USDC)); // top-up so there's something to withdraw
    f.client()
        .withdraw_before_deadline(&side_a[0], &id, &SIDE_A, &USDC); // partial

    // participant_a count unchanged.
    assert_eq!(f.client().get_market(&id).participants_a, half);

    // A new depositor is still blocked.
    let newcomer = f.user(USDC);
    assert_eq!(
        f.client()
            .try_deposit(&newcomer, &id, &SIDE_A, &USDC)
            .unwrap_err()
            .unwrap(),
        Error::SquadFull
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conservation: payouts unaffected by cap
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn conservation_holds_with_cap_exactly_filled() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 500); // 5% fee

    let half = MAX_SQUAD_MEMBERS / 2; // 200 per side
    let side_a = fill_side(&f, id, SIDE_A, half);
    let side_b = fill_side(&f, id, SIDE_B, half);

    let total_in = f.escrow_balance();
    assert_eq!(total_in, USDC * (half as i128) * 2);

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &SIDE_A);

    let mut paid = 0i128;
    for who in side_a.iter() {
        let net = f.client().claim(who, &id, &SIDE_A);
        paid += net;
        // A winner must never receive less than their principal.
        assert!(net >= USDC, "winner net {} below principal {}", net, USDC);
    }
    let fees = f.client().get_accrued_fees();
    assert_eq!(
        paid + fees,
        total_in,
        "conservation failed: paid={} fees={} total_in={}",
        paid,
        fees,
        total_in
    );
    assert_eq!(f.client().get_market(&id).remaining_escrow, 0);
    assert_eq!(f.escrow_balance(), fees);

    // Losers (side B) get nothing.
    for who in side_b.iter() {
        assert_eq!(
            f.client()
                .try_claim(who, &id, &SIDE_B)
                .unwrap_err()
                .unwrap(),
            Error::NotWinner
        );
    }
}

#[test]
fn conservation_holds_for_cancelled_market_at_capacity() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 1_000); // 10% configured but must not apply on cancel

    let half = MAX_SQUAD_MEMBERS / 2;
    let side_a = fill_side(&f, id, SIDE_A, half);
    let side_b = fill_side(&f, id, SIDE_B, half);

    let total_in = f.escrow_balance();

    f.advance_by(DEFAULT_DURATION);
    f.client().resolve(&id, &RESULT_CANCELLED);

    let mut paid = 0i128;
    for who in side_a.iter() {
        let net = f.client().claim(who, &id, &SIDE_A);
        paid += net;
        assert_eq!(net, USDC, "cancel refund should equal principal");
    }
    for who in side_b.iter() {
        let net = f.client().claim(who, &id, &SIDE_B);
        paid += net;
        assert_eq!(net, USDC, "cancel refund should equal principal");
    }

    assert_eq!(f.client().get_accrued_fees(), 0, "cancelled market should charge no fee");
    assert_eq!(paid, total_in, "full refund: paid != total_in");
    assert_eq!(f.escrow_balance(), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/// Count SquadFull events emitted by the squad contract with the given market_id.
fn count_squad_full_events(f: &Fixture, market_id: u64) -> usize {
    let all = f.env.events().all();
    let raw: &[soroban_sdk::xdr::ContractEvent] = all.events();
    raw.iter()
        .filter(|e| {
            let body = match &e.body {
                soroban_sdk::xdr::ContractEventBody::V0(b) => b,
            };
            // Soroban serialises #[contractevent] struct names as snake_case symbols.
            // `SquadFull` → `"squad_full"`.
            let name_matches = body
                .topics
                .first()
                .map(|t| matches!(t, soroban_sdk::xdr::ScVal::Symbol(sym) if sym.0.as_slice() == b"squad_full"))
                .unwrap_or(false);
            if !name_matches {
                return false;
            }
            // topic[1]: u64 market_id
            body.topics
                .get(1)
                .map(|t| matches!(t, soroban_sdk::xdr::ScVal::U64(mid) if *mid == market_id))
                .unwrap_or(false)
        })
        .count()
}

#[test]
fn squad_full_event_is_emitted_on_the_filling_deposit() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let half = MAX_SQUAD_MEMBERS / 2;
    // Fill to one below capacity.
    fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half - 1);

    // After the last pre-fill deposit, env.events().all() covers that call only
    // — no SquadFull there.
    assert_eq!(
        count_squad_full_events(&f, id),
        0,
        "SquadFull must not fire before the cap is reached"
    );

    // The filling deposit.
    let last_member = f.user(USDC);
    f.client().deposit(&last_member, &id, &SIDE_B, &USDC);

    // Now env.events().all() covers the filling call: SquadFull + Deposited.
    assert_eq!(
        count_squad_full_events(&f, id),
        1,
        "SquadFull must be emitted exactly once on the filling deposit"
    );
}

#[test]
fn squad_full_event_is_not_emitted_on_a_top_up() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    let half = MAX_SQUAD_MEMBERS / 2;
    // Fill to capacity (the filling deposit is the last call here).
    let side_a = fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    // Top-up an existing member — no new slot, no SquadFull.
    // env.events().all() will cover only this invocation after the call.
    f.mint(&side_a[0], USDC);
    f.client().deposit(&side_a[0], &id, &SIDE_A, &USDC);

    // The top-up invocation must not have emitted SquadFull.
    assert_eq!(
        count_squad_full_events(&f, id),
        0,
        "SquadFull must not be emitted for a top-up"
    );
}

#[test]
fn squad_full_event_is_not_emitted_below_capacity() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Fill to one below capacity; last invocation is a regular deposit.
    let half = MAX_SQUAD_MEMBERS / 2;
    fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half - 1);

    // The last deposit was the (MAX_SQUAD_MEMBERS - 1)th member — no SquadFull.
    assert_eq!(
        count_squad_full_events(&f, id),
        0,
        "SquadFull must not fire before capacity is reached"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error ordering: SquadFull takes priority over SideFull
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn squad_full_has_priority_over_side_full_when_both_would_apply() {
    // If MAX_SQUAD_MEMBERS is reached AND the target side is also at
    // MAX_PARTICIPANTS_PER_SIDE, the caller must receive SquadFull (the
    // more informative signal) so they do not conclude the other side still
    // has room.
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    let captain = f.user(0);
    let id = f.market(&captain, 0);

    // Both sides full → total = MAX_SQUAD_MEMBERS.
    let half = MAX_SQUAD_MEMBERS / 2;
    fill_side(&f, id, SIDE_A, half);
    fill_side(&f, id, SIDE_B, half);

    let newcomer = f.user(USDC);
    // Side A is at MAX_PARTICIPANTS_PER_SIDE AND total is at MAX_SQUAD_MEMBERS.
    // Must return SquadFull, not SideFull.
    let err = f
        .client()
        .try_deposit(&newcomer, &id, &SIDE_A, &USDC)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::SquadFull);
}
