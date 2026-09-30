#![cfg(test)]
//! Batch-read claim state — `get_claims_batch`.
//!
//! # Coverage
//!
//! positive     – single id, several ids, full batch at MAX_BATCH_SIZE, empty vec
//! negative     – unknown id in batch, all unknown, batch too large, uninitialised
//! boundary     – id 0 (never assigned), exactly MAX_BATCH_SIZE, MAX_BATCH_SIZE+1
//! conservation – batch result values equal individual `get_claim` results;
//!                stake sums and field values are preserved exactly
//! regression   – existing `get_claim` is unaffected; no state mutation;
//!                duplicate ids return consistent values

extern crate std;

use soroban_sdk::testutils::Ledger;
use soroban_sdk::Vec;

use crate::test_common::{Fixture, USDC};
use crate::types::{ClaimState, Error, WinnerSide, MAX_BATCH_SIZE};

// ── helpers ───────────────────────────────────────────────────────────────────

/// Create `n` claims and return their ids.
fn create_claims(f: &Fixture, n: u32) -> std::vec::Vec<u64> {
    let mut ids = std::vec::Vec::new();
    for _ in 0..n {
        let creator = f.user(100 * USDC);
        let id = f.client().create_claim(&creator, &f.params(2 * USDC));
        ids.push(id);
    }
    ids
}

/// Build a `soroban_sdk::Vec<u64>` from a slice of u64.
fn sdk_ids(f: &Fixture, ids: &[u64]) -> Vec<u64> {
    let mut v: Vec<u64> = Vec::new(&f.env);
    for &id in ids {
        v.push_back(id);
    }
    v
}

// ── positive ──────────────────────────────────────────────────────────────────

#[test]
fn single_existing_id_returns_some() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 1);

    let batch = f.client().get_claims_batch(&sdk_ids(&f, &claim_ids));
    assert_eq!(batch.len(), 1);
    assert!(batch.get(0).unwrap().is_some(), "existing id should return Some");
}

#[test]
fn several_existing_ids_all_return_some() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 5);

    let batch = f.client().get_claims_batch(&sdk_ids(&f, &claim_ids));
    assert_eq!(batch.len(), 5, "length must equal number of ids");
    for i in 0..5 {
        assert!(
            batch.get(i).unwrap().is_some(),
            "slot {i} should be Some for existing claim"
        );
    }
}

#[test]
fn empty_vec_returns_empty_vec() {
    let f = Fixture::new(0, 0);
    let batch = f
        .client()
        .get_claims_batch(&sdk_ids(&f, &[]));
    assert_eq!(batch.len(), 0, "empty input must return empty output");
}

#[test]
fn full_batch_at_max_size_succeeds() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, MAX_BATCH_SIZE);

    let batch = f
        .client()
        .get_claims_batch(&sdk_ids(&f, &claim_ids));
    assert_eq!(
        batch.len(),
        MAX_BATCH_SIZE,
        "MAX_BATCH_SIZE ids must be accepted"
    );
    for i in 0..MAX_BATCH_SIZE {
        assert!(batch.get(i).unwrap().is_some());
    }
}

// ── negative ──────────────────────────────────────────────────────────────────

#[test]
fn unknown_id_returns_none_in_that_slot() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 2);

    // Mix: id[0] exists, id[1] exists, 999 does not.
    let ids = sdk_ids(&f, &[claim_ids[0], 999, claim_ids[1]]);
    let batch = f.client().get_claims_batch(&ids);

    assert_eq!(batch.len(), 3);
    assert!(batch.get(0).unwrap().is_some(), "first existing id must be Some");
    assert!(batch.get(1).unwrap().is_none(), "non-existent id must be None");
    assert!(batch.get(2).unwrap().is_some(), "second existing id must be Some");
}

#[test]
fn all_unknown_ids_return_all_none() {
    let f = Fixture::new(0, 0);
    let ids = sdk_ids(&f, &[100, 200, 300]);

    let batch = f.client().get_claims_batch(&ids);
    assert_eq!(batch.len(), 3);
    for i in 0..3 {
        assert!(
            batch.get(i).unwrap().is_none(),
            "slot {i} for unknown id should be None"
        );
    }
}

#[test]
fn batch_too_large_returns_err_batch_too_large() {
    let f = Fixture::new(0, 0);

    // Build a vec of MAX_BATCH_SIZE + 1 ids (they do not have to exist).
    let over: std::vec::Vec<u64> = (1u64..=(MAX_BATCH_SIZE as u64 + 1)).collect();
    let ids = sdk_ids(&f, &over);

    let result = f.client().try_get_claims_batch(&ids);
    let err = result.expect_err("over-sized batch must be rejected");
    let inner = err
        .unwrap_or_else(|e| panic!("expected contract error, got host error: {:?}", e));
    assert_eq!(
        inner,
        Error::BatchTooLarge,
        "error must be BatchTooLarge, got {:?}",
        inner
    );
}

#[test]
fn id_zero_is_never_assigned_and_returns_none() {
    // Claim ids start at 1 (set_claim_count starts from 0 + 1). Id 0 is
    // therefore never a valid claim and must always be None.
    let f = Fixture::new(0, 0);
    let _ = create_claims(&f, 3); // ensure a few claims exist

    let ids = sdk_ids(&f, &[0]);
    let batch = f.client().get_claims_batch(&ids);
    assert_eq!(batch.len(), 1);
    assert!(batch.get(0).unwrap().is_none(), "id 0 is never assigned, must be None");
}

// ── boundary ──────────────────────────────────────────────────────────────────

#[test]
fn exactly_max_batch_size_is_accepted() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, MAX_BATCH_SIZE);
    let ids = sdk_ids(&f, &claim_ids);

    // Must not return BatchTooLarge.
    let batch = f.client().get_claims_batch(&ids);
    assert_eq!(batch.len(), MAX_BATCH_SIZE);
}

#[test]
fn max_batch_size_plus_one_is_rejected() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, MAX_BATCH_SIZE);

    // Append one extra id beyond MAX_BATCH_SIZE.
    let mut over = claim_ids.clone();
    over.push(999_999);
    let ids = sdk_ids(&f, &over);

    let result = f.client().try_get_claims_batch(&ids);
    let inner = result
        .expect_err("over-sized batch must fail")
        .unwrap_or_else(|e| panic!("expected contract error: {:?}", e));
    assert_eq!(inner, Error::BatchTooLarge);
}

#[test]
fn single_element_batch_behaves_identically_to_get_claim() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 1);
    let id = claim_ids[0];

    let single = f.client().get_claim(&id);
    let batch = f.client().get_claims_batch(&sdk_ids(&f, &[id]));

    let from_batch = batch.get(0).unwrap().unwrap();
    assert_eq!(single.question, from_batch.question);
    assert_eq!(single.creator, from_batch.creator);
    assert_eq!(single.creator_stake, from_batch.creator_stake);
    assert_eq!(single.state, from_batch.state);
    assert_eq!(single.deadline, from_batch.deadline);
}

// ── conservation ─────────────────────────────────────────────────────────────

#[test]
fn batch_values_match_individual_get_claim_calls() {
    let f = Fixture::new(50, 50);
    let claim_ids = create_claims(&f, 4);

    let batch = f.client().get_claims_batch(&sdk_ids(&f, &claim_ids));

    for (i, &id) in claim_ids.iter().enumerate() {
        let individual = f.client().get_claim(&id);
        let from_batch = batch.get(i as u32).unwrap().unwrap();

        // Core economic fields.
        assert_eq!(
            individual.creator_stake, from_batch.creator_stake,
            "creator_stake mismatch at slot {i}"
        );
        assert_eq!(
            individual.total_challenger_stake, from_batch.total_challenger_stake,
            "total_challenger_stake mismatch at slot {i}"
        );
        assert_eq!(
            individual.reserved_creator_liability, from_batch.reserved_creator_liability,
            "reserved_creator_liability mismatch at slot {i}"
        );
        assert_eq!(
            individual.remaining_escrow, from_batch.remaining_escrow,
            "remaining_escrow mismatch at slot {i}"
        );
        assert_eq!(
            individual.state, from_batch.state,
            "state mismatch at slot {i}"
        );
        assert_eq!(
            individual.winner_side, from_batch.winner_side,
            "winner_side mismatch at slot {i}"
        );

        // Fee snapshot is preserved exactly.
        assert_eq!(
            individual.fees.platform_fee_bps, from_batch.fees.platform_fee_bps,
            "fee snapshot platform_fee_bps mismatch at slot {i}"
        );
        assert_eq!(
            individual.fees.agent_owner_fee_bps, from_batch.fees.agent_owner_fee_bps,
            "fee snapshot agent_owner_fee_bps mismatch at slot {i}"
        );

        // Hashes.
        assert_eq!(
            individual.context_hash, from_batch.context_hash,
            "context_hash mismatch at slot {i}"
        );
        assert_eq!(
            individual.evidence_hash, from_batch.evidence_hash,
            "evidence_hash mismatch at slot {i}"
        );
    }
}

#[test]
fn batch_returns_live_state_not_stale_snapshot() {
    // Resolve one claim after creating it; the batch should return the
    // post-resolution state, not the pre-resolution snapshot.
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);
    let id = f.client().create_claim(&creator, &f.params(10 * USDC));

    let challenger = f.user(10 * USDC);
    f.client()
        .challenge_claim(&challenger, &id, &(2 * USDC), &None);

    // Advance past the deadline and resolve.
    f.env.ledger().with_mut(|li| li.timestamp += 3_700);
    f.client().resolve_claim(
        &id,
        &WinnerSide::Creator,
        &f.str("creator wins"),
        &80,
        &f.zero_hash(),
    );

    let batch = f.client().get_claims_batch(&sdk_ids(&f, &[id]));
    let from_batch = batch.get(0).unwrap().unwrap();

    assert_eq!(
        from_batch.state,
        ClaimState::Resolved,
        "batch should reflect resolved state"
    );
    assert_eq!(
        from_batch.winner_side,
        WinnerSide::Creator,
        "batch should reflect the correct winner side"
    );
    assert!(
        from_batch.evidence_hash.is_some() || from_batch.resolution_summary.len() > 0,
        "batch should see the resolution summary"
    );
}

#[test]
fn batch_does_not_mutate_escrow_balance() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 3);
    let challenger = f.user(100 * USDC);
    f.client()
        .challenge_claim(&challenger, &claim_ids[0], &(2 * USDC), &None);

    let balance_before = f.escrow_balance();
    let _ = f.client().get_claims_batch(&sdk_ids(&f, &claim_ids));
    let balance_after = f.escrow_balance();

    assert_eq!(
        balance_before, balance_after,
        "a pure batch-read must not touch the escrow balance"
    );
}

#[test]
fn batch_includes_mixed_states() {
    // Create three claims: one Open, one Active, one Resolved.
    let f = Fixture::new(0, 0);

    let creator_open = f.user(100 * USDC);
    let id_open = f.client().create_claim(&creator_open, &f.params(5 * USDC));

    let creator_active = f.user(100 * USDC);
    let id_active = f.client().create_claim(&creator_active, &f.params(5 * USDC));
    let ch = f.user(10 * USDC);
    f.client()
        .challenge_claim(&ch, &id_active, &(2 * USDC), &None);

    let creator_resolved = f.user(100 * USDC);
    let id_resolved = f.client().create_claim(&creator_resolved, &f.params(5 * USDC));
    let ch2 = f.user(10 * USDC);
    f.client()
        .challenge_claim(&ch2, &id_resolved, &(2 * USDC), &None);
    f.env.ledger().with_mut(|li| li.timestamp += 3_700);
    f.client().resolve_claim(
        &id_resolved,
        &WinnerSide::Challengers,
        &f.str("challengers win"),
        &80,
        &f.zero_hash(),
    );

    let ids = sdk_ids(&f, &[id_open, id_active, id_resolved]);
    let batch = f.client().get_claims_batch(&ids);

    assert_eq!(batch.len(), 3);
    assert_eq!(
        batch.get(0).unwrap().unwrap().state,
        ClaimState::Open,
        "first claim should be Open"
    );
    assert_eq!(
        batch.get(1).unwrap().unwrap().state,
        ClaimState::Active,
        "second claim should be Active"
    );
    assert_eq!(
        batch.get(2).unwrap().unwrap().state,
        ClaimState::Resolved,
        "third claim should be Resolved"
    );
}

// ── regression ────────────────────────────────────────────────────────────────

#[test]
fn existing_get_claim_is_unaffected_after_batch_read() {
    // Call get_claims_batch and then verify get_claim still works correctly.
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 3);

    // Perform a batch read first.
    let _ = f
        .client()
        .get_claims_batch(&sdk_ids(&f, &claim_ids));

    // Individual reads must still work identically.
    for &id in &claim_ids {
        let claim = f.client().get_claim(&id);
        assert!(claim.creator_stake > 0, "get_claim must work after batch read");
    }
}

#[test]
fn duplicate_ids_in_batch_return_consistent_values() {
    // Duplicates are allowed and return the same claim value in both positions.
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 1);
    let id = claim_ids[0];

    // Submit id twice.
    let ids = sdk_ids(&f, &[id, id]);
    let batch = f.client().get_claims_batch(&ids);

    assert_eq!(batch.len(), 2, "length must match input length even with duplicates");

    let c0 = batch.get(0).unwrap().unwrap();
    let c1 = batch.get(1).unwrap().unwrap();

    assert_eq!(c0.creator, c1.creator, "duplicate slots must return the same creator");
    assert_eq!(
        c0.creator_stake, c1.creator_stake,
        "duplicate slots must return the same creator_stake"
    );
    assert_eq!(c0.state, c1.state, "duplicate slots must return the same state");
}

#[test]
fn output_length_always_equals_input_length() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 3);

    // Mix of existing and non-existing ids.
    let ids = sdk_ids(&f, &[claim_ids[0], 888, claim_ids[1], 999, claim_ids[2]]);
    let batch = f.client().get_claims_batch(&ids);

    assert_eq!(
        batch.len(),
        5,
        "output length must always equal input length"
    );
}

#[test]
fn batch_read_does_not_change_claim_count_or_platform_stats() {
    let f = Fixture::new(0, 0);
    let claim_ids = create_claims(&f, 4);

    let stats_before = f.client().get_platform_stats();

    let _ = f.client().get_claims_batch(&sdk_ids(&f, &claim_ids));

    let stats_after = f.client().get_platform_stats();
    assert_eq!(
        stats_before.total_claims, stats_after.total_claims,
        "total_claims must not change after a batch read"
    );
    assert_eq!(
        stats_before.resolved, stats_after.resolved,
        "resolved count must not change after a batch read"
    );
    assert_eq!(
        stats_before.fees_accrued, stats_after.fees_accrued,
        "fees_accrued must not change after a batch read"
    );
}
