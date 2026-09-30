#![cfg(test)]
//! The anti-sniping challenge lock window, asserted at the ledger edges.
//!
//! `challenge_claim` refuses a challenge that would land too close to the
//! claim's deadline:
//!
//! ```text
//! now + CHALLENGE_LOCK_SECONDS > deadline  ->  Error::ChallengeWindowClosed
//! ```
//!
//! The comparison is strict, so the boundary is inclusive on the market's side:
//! `now = deadline - CHALLENGE_LOCK_SECONDS` is the LAST accepted ledger second
//! and `now = deadline - CHALLENGE_LOCK_SECONDS + 1` is the first refused one.
//! Every test here states an edge in exactly those terms:
//!
//! * the last accepted second, and the first refused one;
//! * the deadline second itself, where the challenge door is already shut and
//!   `transition_deadline` (which requires `now >= deadline`) becomes legal;
//! * the two degenerate markets — one created with less than the window left to
//!   live, which can never be challenged at all, and one created with exactly
//!   the window left to live, which is challengeable in exactly one second;
//! * the arithmetic edge, where `now + CHALLENGE_LOCK_SECONDS` overflows.
//!
//! A refused challenge must also be inert: it must not move money or touch the
//! roster. `escrow::pull` runs after the window check, so these tests assert
//! balances and state, not just the error code.
//!
//! The off-chain mirror of the same rule, `lib/contract.ts::isVSJoinable`, is
//! held to the same second by the lock-window tests in
//! `tests/node/contract-smoke.test.ts`.

extern crate std;

use soroban_sdk::Address;

use crate::test_common::{Fixture, USDC};
use crate::types::{ClaimState, Error, CHALLENGE_LOCK_SECONDS};

/// Tokens delivered to `who` plus anything parked for later withdrawal. A payout
/// that cannot be transferred is parked rather than lost, so conservation has to
/// be read across both.
fn credited(f: &Fixture, who: &Address) -> i128 {
    f.token().balance(who) + f.client().get_withdrawable(who)
}

/// Every refused challenge in this module is asserted the same way: the error,
/// and the absence of any effect on escrow, roster, or claim state.
fn assert_refused(f: &Fixture, challenger: &Address, id: u64, context: &str) {
    let err = f
        .client()
        .try_challenge_claim(challenger, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ChallengeWindowClosed, "{context}");

    assert_eq!(f.token().balance(challenger), 100 * USDC, "{context}");
    assert_eq!(f.escrow_balance(), 10 * USDC, "{context}");
    assert_eq!(f.client().get_challenger_list(&id).len(), 0, "{context}");

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.state, ClaimState::Open, "{context}");
    assert_eq!(claim.challenger_count, 0, "{context}");
    assert_eq!(claim.total_challenger_stake, 0, "{context}");
}

// ── The window's own edges ────────────────────────────────────────────────────

/// The last second inside the window is accepted, and the challenge settles in
/// full: roster entry, counters, and escrow.
#[test]
fn the_last_second_of_the_lock_window_is_accepted() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    f.advance_to(deadline - CHALLENGE_LOCK_SECONDS);
    f.client()
        .challenge_claim(&challenger, &id, &(5 * USDC), &None);

    let claim = f.client().get_claim(&id);
    assert_eq!(claim.state, ClaimState::Active);
    assert_eq!(claim.challenger_count, 1);
    assert_eq!(claim.total_challenger_stake, 5 * USDC);

    let roster = f.client().get_challenger_list(&id);
    assert_eq!(roster.len(), 1);
    assert_eq!(roster.get(0).unwrap().address, challenger);
    assert_eq!(roster.get(0).unwrap().stake, 5 * USDC);

    // Conservation: both stakes are in escrow, and the challenger paid exactly
    // its stake.
    assert_eq!(f.escrow_balance(), 15 * USDC);
    assert_eq!(f.token().balance(&challenger), 95 * USDC);
}

/// One second later the window is shut — this is the exact second the boundary
/// flips, so both sides of it are asserted together.
#[test]
fn the_first_second_inside_the_lock_window_is_refused() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    f.advance_to(deadline - CHALLENGE_LOCK_SECONDS + 1);
    assert_refused(&f, &challenger, id, "first second inside the window");
}

/// A refusal is inert at every refused offset: one second inside the window, the
/// deadline second, and one second past it.
#[test]
fn a_refused_challenge_moves_no_money_at_any_offset() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    let offsets = [
        (1u64, "the first second inside the window"),
        (CHALLENGE_LOCK_SECONDS, "the deadline second"),
        (CHALLENGE_LOCK_SECONDS + 1, "one second past the deadline"),
    ];
    for (offset, context) in offsets {
        let challenger = f.user(100 * USDC);
        f.advance_to(deadline - CHALLENGE_LOCK_SECONDS + offset);
        assert_refused(&f, &challenger, id, context);
    }
}

/// The deadline second closes the challenge door and opens the deadline
/// transition in the same ledger second, because the two rules meet exactly
/// there: the window needs `now + CHALLENGE_LOCK_SECONDS <= deadline`, the
/// transition needs `now >= deadline`.
#[test]
fn the_deadline_second_closes_the_window_and_permits_the_transition() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let params = f.params(10 * USDC);
    let deadline = params.deadline;
    let id = f.client().create_claim(&creator, &params);

    f.advance_to(deadline);
    assert_refused(&f, &challenger, id, "the deadline second");

    // Same second, and the market may now be transitioned. It has no
    // challengers, so the creator's stake comes back in full and no fee is
    // charged: 90 USDC left after staking plus the 10 USDC refund is whole again.
    f.client().transition_deadline(&id);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Cancelled);
    assert_eq!(credited(&f, &creator), 100 * USDC);
    assert_eq!(f.escrow_balance(), 0);

    // A cancelled market is refused before the window is ever consulted, so a
    // late challenger is told the market is no longer open rather than that the
    // window closed.
    let late = f.user(100 * USDC);
    let err = f
        .client()
        .try_challenge_claim(&late, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ClaimNotOpen);
}

// ── Degenerate markets ────────────────────────────────────────────────────────

/// A market created with less than the window left to live has an empty window:
/// every possible challenge is refused, on the creation second and on every
/// second after it, while the claim itself is still Open.
#[test]
fn a_market_with_less_than_the_window_to_live_can_never_be_challenged() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let deadline = f.env.ledger().timestamp() + CHALLENGE_LOCK_SECONDS - 1;
    let mut params = f.params(10 * USDC);
    params.deadline = deadline;
    let id = f.client().create_claim(&creator, &params);

    // Refused on the second it was created ...
    assert_refused(&f, &challenger, id, "the creation second");

    // ... and on the last second of its life, with a second still to run. The
    // claim is Open at that point, so it is the window — not the state — that
    // refuses.
    f.advance_to(deadline - 1);
    assert_refused(&f, &challenger, id, "the last second of its life");
}

/// A market created with exactly the window left to live is the tightest market
/// that can be challenged at all: it is joinable in the second it was created
/// and in no other.
#[test]
fn a_market_with_exactly_the_window_to_live_is_challengeable_for_one_second() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let first = f.user(100 * USDC);
    let deadline = f.env.ledger().timestamp() + CHALLENGE_LOCK_SECONDS;
    let mut params = f.params(10 * USDC);
    params.deadline = deadline;
    let id = f.client().create_claim(&creator, &params);

    // The creation second is also the last accepted second.
    f.client().challenge_claim(&first, &id, &(5 * USDC), &None);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Active);

    // One second later the window is shut, even though the market still has 59
    // seconds to run.
    f.advance_by(1);
    let second = f.user(100 * USDC);
    let err = f
        .client()
        .try_challenge_claim(&second, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::ChallengeWindowClosed);
    assert_eq!(f.client().get_claim(&id).challenger_count, 1);
}

/// The deadline must be strictly in the future, so the degenerate window above
/// can only be reached with a deadline of at least one second.
#[test]
fn a_deadline_exactly_now_is_refused_at_creation() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let mut params = f.params(10 * USDC);
    params.deadline = f.env.ledger().timestamp();

    let err = f
        .client()
        .try_create_claim(&creator, &params)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::DeadlineInPast);
    assert_eq!(f.escrow_balance(), 0);
}

// ── Arithmetic edge ───────────────────────────────────────────────────────────

/// At the top of the `u64` range the guard itself overflows, so the caller gets
/// `Error::Overflow` rather than a trap or a silently wrong window comparison —
/// even though the deadline has long passed and the window is also closed.
#[test]
fn a_timestamp_at_the_top_of_u64_reports_overflow() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let challenger = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    // Largest second whose `now + CHALLENGE_LOCK_SECONDS` still does not fit.
    f.advance_to(u64::MAX - (CHALLENGE_LOCK_SECONDS - 1));
    let err = f
        .client()
        .try_challenge_claim(&challenger, &id, &(5 * USDC), &None)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Overflow);

    // The overflow is returned before the deadline comparison, and before any
    // money moves: the refusal is still inert.
    assert_eq!(f.token().balance(&challenger), 100 * USDC);
    assert_eq!(f.escrow_balance(), 10 * USDC);
    assert_eq!(f.client().get_claim(&id).state, ClaimState::Open);
}
