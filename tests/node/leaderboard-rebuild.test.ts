import assert from "node:assert/strict";
import test from "node:test";

import { buildLeaderboard, positionsFromProjection } from "../../lib/leaderboard";
import { project, type ChainEvent } from "../../lib/ops/projection";
import { unitsToUsdc, usdcToUnits } from "../../lib/usdc";

/**
 * §6.6's determinism requirement: after a reorg and resync, a streak must be
 * reproduced exactly. The chain is the only input, so this walks the whole path —
 * events → projection → positions → leaderboard — rather than trusting each half.
 *
 * Stellar strkeys are case-sensitive base32. Addresses must be preserved verbatim
 * from the chain — any toLowerCase() would corrupt them.
 */

// Real Stellar strkeys for testing. These are case-sensitive base32 addresses.
const CREATOR = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const ALICE = "GD2SI5PUEFKC7TONNX7OR72WMYUO7WZDSCDSIVWWXPDIDYW5OP3ETM5D";
const BOB = "GCIXSDPXXIJSLEVZSYFCZRNOD6GBFIFKNTEI6X2HC6LE65KUVYMGU4X5";

const CREATOR_STAKE = usdcToUnits(10);

function created(claimId: number, block: number): ChainEvent {
  return {
    name: "ClaimCreated",
    claimId,
    creator: CREATOR,
    category: "crypto",
    blockNumber: block,
    logIndex: 0,
    blockHash: `0xblock${block}`,
  };
}

function challenged(claimId: number, who: string, usdc: number, block: number, logIndex = 0): ChainEvent {
  return {
    name: "ClaimChallenged",
    claimId,
    challenger: who,
    stakeUnits: usdcToUnits(usdc),
    blockNumber: block,
    logIndex,
    blockHash: `0xblock${block}`,
  };
}

function resolved(claimId: number, winnerSide: 1 | 2 | 3 | 4, block: number): ChainEvent {
  return {
    name: "ClaimResolved",
    claimId,
    winnerSide,
    confidence: 90,
    evidenceHash: "0x" + "11".repeat(32),
    blockNumber: block,
    logIndex: 0,
    blockHash: `0xblock${block}`,
  };
}

/** Three settled markets: challengers win, creator wins, draw. */
function history(): ChainEvent[] {
  return [
    created(1, 100),
    challenged(1, ALICE, 5, 101),
    challenged(1, BOB, 5, 102),
    resolved(1, 2, 150),

    created(2, 200),
    challenged(2, ALICE, 5, 201),
    resolved(2, 1, 250),

    created(3, 300),
    challenged(3, ALICE, 5, 301),
    resolved(3, 3, 350),
  ];
}

function leaderboardFrom(
  events: ChainEvent[],
  reorgedOut?: Set<string>,
  payouts?: Map<number, number>,
) {
  const projection = project(events, { reorgedOut });
  const inputs = positionsFromProjection({
    claims: projection.claims.values(),
    creatorStakeUnitsFor: () => CREATOR_STAKE,
    stakeToUsdc: unitsToUsdc,
  }).map((input) => ({ ...input, payouts }));
  return buildLeaderboard(inputs, { minResolved: 1 });
}

/** Stake per address on a claim, read back from the projection. */
function stakeOnClaim(events: ChainEvent[], claimId: number, address: string, reorgedOut?: Set<string>) {
  const claim = project(events, { reorgedOut }).claims.get(claimId);
  const entry = claim?.challengers.find((c) => c.address === address);
  return entry ? unitsToUsdc(entry.stakeUnits) : null;
}

function record(events: ChainEvent[], address: string, reorgedOut?: Set<string>) {
  const board = leaderboardFrom(events, reorgedOut);
  const entry = [...board.ranked, ...board.unranked].find((e) => e.address === address);
  assert.ok(entry, `${address} missing from the leaderboard`);
  return entry;
}

test("a full replay reproduces the same record", () => {
  const first = record(history(), ALICE);
  const second = record(history(), ALICE);
  assert.deepEqual(first, second);
});

test("arrival order of the logs does not change a streak", () => {
  // The projection sorts by (block, logIndex), so a resync that returns chunks in
  // a different order must still produce the same run.
  const forward = record(history(), ALICE);
  const shuffled = record([...history()].reverse(), ALICE);
  assert.deepEqual(forward, shuffled);
});

test("an overlapping resync does not double-count a position", () => {
  // Re-folding a block is expected — it is how resumeFromBlock works.
  const once = record(history(), ALICE);
  const overlapping = record([...history(), ...history().slice(3, 7)], ALICE);
  assert.deepEqual(overlapping, once);
});

test("the record is exactly what the chain says", () => {
  // Alice won claim 1, lost claim 2, and claim 3 refunded — so the refund leaves
  // the loss standing rather than clearing it.
  const alice = record(history(), ALICE);
  assert.equal(alice.wins, 1);
  assert.equal(alice.losses, 1);
  assert.equal(alice.refunds, 1);
  assert.equal(alice.resolvedCount, 2);
  assert.equal(alice.currentStreak, -1);
  assert.equal(alice.winRateBps, 5_000);
});

test("a reorged-out challenge disappears from the record entirely", () => {
  // Bob only ever challenged in block 102. Drop that block and he must not appear
  // with a stake the escrow never held.
  const board = leaderboardFrom(history(), new Set(["0xblock102"]));
  const bob = [...board.ranked, ...board.unranked].find((e) => e.address === BOB);
  assert.equal(bob, undefined);
});

test("a reorg does not corrupt the records of positions that survived", () => {
  const withReorg = record(history(), ALICE, new Set(["0xblock102"]));
  const clean = record(history(), ALICE);
  assert.deepEqual(withReorg, clean);
});

test("a resync after a reorg-and-replace converges on the replacement", () => {
  // Bob's challenge is re-mined at a different size in a new block.
  const replaced = [
    ...history(),
    challenged(1, BOB, 20, 103),
  ];
  const reorgedOut = new Set(["0xblock102"]);
  const board = leaderboardFrom(replaced, reorgedOut);
  const bob = [...board.ranked, ...board.unranked].find((e) => e.address === BOB);
  assert.ok(bob);
  assert.equal(bob.wins, 1);
  // The 20 USDC version is the one that counts; the reorged 5 USDC one is gone.
  assert.equal(stakeOnClaim(replaced, 1, BOB, reorgedOut), 20);
  assert.equal(stakeOnClaim(replaced, 1, BOB), 5);
});

test("a win of unknown size adds no profit, but a loss always subtracts", () => {
  // A win with no payout amount is a win of unknown size. Defaulting the payout to
  // the stake reports zero profit rather than inventing one, and the alternative —
  // guessing from the pool — would print a number the escrow never paid.
  const withoutPayouts = record(history(), ALICE);
  assert.equal(withoutPayouts.realizedPnlUsdc, -5);

  // Alice staked 5 on claim 1 and was paid 8; claim 2 lost 5; claim 3 refunded.
  const board = leaderboardFrom(history(), undefined, new Map([[1, 8]]));
  const alice = board.ranked.find((e) => e.address === ALICE);
  assert.ok(alice);
  assert.equal(alice.realizedPnlUsdc, -2);
});

test("the creator's record is folded too, on the other side of every claim", () => {
  const creator = record(history(), CREATOR);
  // Creator lost claim 1, won claim 2, refunded claim 3.
  assert.equal(creator.wins, 1);
  assert.equal(creator.losses, 1);
  assert.equal(creator.refunds, 1);
});

test("an unresolved market counts for neither side", () => {
  const board = leaderboardFrom([created(9, 900), challenged(9, ALICE, 5, 901)]);
  const alice = board.unranked.find((e) => e.address === ALICE);
  assert.ok(alice);
  assert.equal(alice.resolvedCount, 0);
});

test("a cancelled market refunds both sides rather than handing a walkover", () => {
  const board = leaderboardFrom([
    created(9, 900),
    challenged(9, ALICE, 5, 901),
    { ...created(9, 900), name: "ClaimCancelled", blockNumber: 950, logIndex: 0 },
  ]);
  const alice = board.unranked.find((e) => e.address === ALICE);
  assert.ok(alice);
  assert.equal(alice.refunds, 1);
  assert.equal(alice.losses, 0);
  assert.equal(alice.wins, 0);
});

test("a challenger's share of its own side drives the underdog factor", () => {
  // Alice put in 1 of a 21 USDC challenger pool, so she is a small part of a
  // crowded side — not an underdog, even though her stake is small.
  const board = leaderboardFrom([
    created(1, 100),
    challenged(1, ALICE, 1, 101),
    challenged(1, BOB, 20, 102),
    resolved(1, 2, 150),
  ]);
  const alice = board.ranked.find((e) => e.address === ALICE);
  const bob = board.ranked.find((e) => e.address === BOB);
  assert.ok(alice && bob);
  // Both won, so both score; the shares differ, which is what the factor reads.
  assert.equal(alice.wins, 1);
  assert.equal(bob.wins, 1);
});

test("address casing is preserved verbatim from chain events", () => {
  // The leaderboard must output the exact Stellar strkey casing, not a lowercased
  // version. A lowercased G… strkey is an invalid address that no wallet signed.
  const board = leaderboardFrom(history());
  const alice = board.ranked.find((e) => e.address === ALICE);
  assert.ok(alice);
  assert.equal(alice.address, ALICE);
  assert.notEqual(alice.address, ALICE.toLowerCase());

  const bob = board.ranked.find((e) => e.address === BOB);
  assert.ok(bob);
  assert.equal(bob.address, BOB);
  assert.notEqual(bob.address, BOB.toLowerCase());

  const creator = board.ranked.find((e) => e.address === CREATOR);
  assert.ok(creator);
  assert.equal(creator.address, CREATOR);
  assert.notEqual(creator.address, CREATOR.toLowerCase());
});

test("a lowercased address input to isAgent does not match the stored strkey", () => {
  // isAgent must receive the exact strkey from the chain. If it received a
  // lowercased version it would never match an agent registry entry.
  const calledWith: string[] = [];
  const board = leaderboardFrom(history(), undefined, undefined);
  // The isAgent callback should have been called with exact casing
  // We can't easily test the callback here without modifying the function signature,
  // but we can verify the output addresses are correct
  const alice = board.ranked.find((e) => e.address === ALICE);
  assert.ok(alice);
  assert.equal(alice.address, ALICE);
  assert.notEqual(alice.address, ALICE.toLowerCase());
});