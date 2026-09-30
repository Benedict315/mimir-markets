import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  getVSTotalPot,
  isVSJoinable,
  isVSPrivate,
  mapClaimToVS,
  VS_CHALLENGE_LOCK_SECONDS,
  type ClaimData,
} from "../../lib/contract";
import { CHALLENGE_LOCK_SECONDS as SCRIPT_CHALLENGE_LOCK_SECONDS } from "../../scripts/lib/stellar-env";

// Real `G…` strkeys. Case matters: `isSameAddress` in lib/contract.ts compares
// exactly, because base32 strkeys are case-sensitive and the EVM
// `toLowerCase()` pairing would corrupt them.
const CREATOR    = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const CHALLENGER = "GDZCBCIU6EI5FM5UC5IAWRT5ZY76OK4QDX5BEELC5V3NTNGAUIX5X4UH";
const OTHER_1    = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_2    = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const OUTSIDER   = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

function makeClaim(overrides: Partial<ClaimData> = {}): ClaimData {
  return {
    id: 4,
    creator: CREATOR,
    question: "Will BTC close above 100k?",
    creator_position: "Yes",
    counter_position: "No",
    resolution_url: "https://example.com/source",
    creator_stake: 5,
    total_challenger_stake: 3,
    reserved_creator_liability: 0,
    available_creator_liability: 5,
    // Far future — isVSJoinable compares against the real clock, so a past
    // deadline silently turns every joinability assertion false.
    deadline: 4_100_000_000,
    state: "active",
    winner_side: "",
    resolution_summary: "",
    confidence: 0,
    category: "crypto",
    parent_id: 0,
    challenger_count: 1,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 0,
    handicap_line: "",
    settlement_rule: "",
    max_challengers: 3,
    created_at: 0,
    visibility: "private",
    is_private: true,
    challengers: [
      {
        address: CHALLENGER,
        stake: 3,
        potential_payout: 8,
      },
    ],
    first_challenger: CHALLENGER,
    challenger_addresses: [CHALLENGER],
    total_pot: 8,
    ...overrides,
  };
}

test("mapClaimToVS keeps compatibility fields for active private claims", () => {
  const vs = mapClaimToVS(makeClaim());

  assert.equal(vs.state, "accepted");
  assert.equal(vs.opponent, CHALLENGER);
  assert.equal(vs.opponent_position, "No");
  assert.equal(vs.stake_amount, 5);
  assert.equal(isVSPrivate(vs), true);
  assert.equal(getVSTotalPot(vs), 8);
});

test("isVSJoinable blocks creator, existing challenger, and full pools", () => {
  const baseVS = mapClaimToVS(makeClaim());

  assert.equal(
    isVSJoinable(baseVS, CREATOR),
    false
  );
  assert.equal(
    isVSJoinable(baseVS, CHALLENGER),
    false
  );
  assert.equal(
    isVSJoinable(baseVS, OUTSIDER),
    true
  );

  const fullVS = mapClaimToVS(
    makeClaim({
      challenger_count: 3,
      max_challengers: 3,
      challenger_addresses: [
        CHALLENGER,
        OTHER_1,
        OTHER_2,
      ],
    })
  );
  assert.equal(
    isVSJoinable(fullVS, OUTSIDER),
    false
  );
});

test("mapClaimToVS preserves fixed-odds winner information", () => {
  const vs = mapClaimToVS(
    makeClaim({
      state: "resolved",
      winner_side: "challengers",
      odds_mode: "fixed",
      challenger_payout_bps: 18000,
    })
  );

  assert.equal(vs.state, "resolved");
  assert.equal(vs.winner, CHALLENGER);
  assert.equal(vs.odds_mode, "fixed");
  assert.equal(vs.challenger_payout_bps, 18000);
});

test("address comparison is exact, so a case-folded strkey is a different party", () => {
  // The EVM version of this file asserted that `getContractAddress()` trimmed a
  // stray carriage return out of a 0x address. That function is gone with
  // lib/base.ts, and env normalisation now lives in lib/stellar.ts (`cleanEnv`).
  //
  // What is worth pinning here instead is the property that replaced it: a Stellar
  // strkey is case-SENSITIVE base32, so `isSameAddress` must not fold case. If it
  // did, a lowercased creator address would pass the "are you the creator?" check
  // and a market's own creator could be admitted as its challenger.
  const vs = mapClaimToVS(makeClaim());

  assert.equal(isVSJoinable(vs, CREATOR), false, "the creator cannot join its own market");
  assert.equal(
    isVSJoinable(vs, CREATOR.toLowerCase()),
    true,
    "a lowercased strkey is a different string, and is treated as a stranger",
  );
});

// ── Challenge lock window, at the boundary second ─────────────────────────────
//
// `challenge_claim` refuses a challenge that would land inside the anti-sniping
// window (contracts-soroban/mimir-market/src/claims.rs):
//
//     now + CHALLENGE_LOCK_SECONDS > deadline  ->  Error::ChallengeWindowClosed
//
// The comparison is strict, so the last ledger second a challenge is accepted in
// is exactly `deadline - CHALLENGE_LOCK_SECONDS`. `isVSJoinable` mirrors that
// comparison for the UI, and these tests pin the mirror to the same second.
// `contracts-soroban/mimir-market/src/test_challenge_lock.rs` asserts the same
// edges on chain, against the real contract.

/**
 * Freeze the clock for the duration of `fn`. The guard reads `Date.now()`
 * itself, so a test that computed `NOW` and then let the real clock tick past
 * the boundary second could fail for a reason that has nothing to do with the
 * rule under test.
 */
function atSecond<T>(seconds: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => seconds * 1000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** Any fixed second: only differences against `deadline` matter here. */
const NOW = 1_800_000_000;

test("isVSJoinable accepts the last second of the lock window and refuses the next", () => {
  // now + lock == deadline is still accepted, exactly as on chain.
  const onBoundary = mapClaimToVS(makeClaim({ deadline: NOW + VS_CHALLENGE_LOCK_SECONDS }));
  assert.equal(atSecond(NOW, () => isVSJoinable(onBoundary, OUTSIDER)), true);

  // One second later the same market is closed to new challengers.
  assert.equal(atSecond(NOW + 1, () => isVSJoinable(onBoundary, OUTSIDER)), false);

  // And so is a market whose window closed a second earlier than that.
  const inside = mapClaimToVS(makeClaim({ deadline: NOW + VS_CHALLENGE_LOCK_SECONDS - 1 }));
  assert.equal(atSecond(NOW, () => isVSJoinable(inside, OUTSIDER)), false);
});

test("a market with exactly the lock window to live is joinable for one second", () => {
  // The tightest market a challenge can still reach: joinable in the second it
  // was created and in no other.
  const vs = mapClaimToVS(makeClaim({ deadline: NOW + VS_CHALLENGE_LOCK_SECONDS }));

  assert.equal(atSecond(NOW, () => isVSJoinable(vs, OUTSIDER)), true);
  assert.equal(atSecond(NOW + 1, () => isVSJoinable(vs, OUTSIDER)), false);
});

test("a market shorter than the lock window is never joinable", () => {
  // Born with one second of life: the window is empty for its whole life,
  // including its first second and its last.
  const vs = mapClaimToVS(makeClaim({ deadline: NOW + 1 }));

  assert.equal(atSecond(NOW, () => isVSJoinable(vs, OUTSIDER)), false);
  assert.equal(atSecond(NOW + 1, () => isVSJoinable(vs, OUTSIDER)), false);
});

test("a market with no deadline is not gated by the lock window", () => {
  // `deadline === 0` marks a market that carries no deadline at all, so there is
  // no window to close. On chain a deadline is mandatory, so this branch only
  // exists for off-chain rows.
  const vs = mapClaimToVS(makeClaim({ deadline: 0 }));

  assert.equal(atSecond(NOW, () => isVSJoinable(vs, OUTSIDER)), true);
});

test("the lock window constant is mirrored from the contract, not guessed", () => {
  // Three copies of this number exist (Rust, lib/contract.ts, scripts/lib), and
  // the off-chain copies are only correct while they equal the contract's.
  const typesRs = readFileSync(
    join(process.cwd(), "contracts-soroban", "mimir-market", "src", "types.rs"),
    "utf8",
  );
  const declared = /pub const CHALLENGE_LOCK_SECONDS: u64 = (\d+);/.exec(typesRs);
  assert.ok(declared, "types.rs must declare CHALLENGE_LOCK_SECONDS");

  assert.equal(
    Number(declared[1]),
    VS_CHALLENGE_LOCK_SECONDS,
    "lib/contract.ts::VS_CHALLENGE_LOCK_SECONDS must mirror types.rs",
  );
  assert.equal(
    Number(declared[1]),
    SCRIPT_CHALLENGE_LOCK_SECONDS,
    "scripts/lib/stellar-env.ts::CHALLENGE_LOCK_SECONDS must mirror types.rs",
  );
});
