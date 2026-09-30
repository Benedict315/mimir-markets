import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidStellarAddress,
  validateMoneyField,
  validateClaimAccounting,
  compareClaimStates,
  validateCursorValue,
  type ClaimDiscrepancy
} from "../../lib/server/sync-helpers";
import type { ClaimData } from "../../lib/contract";
import type { ClaimRow } from "../../lib/db";

// Helper to generate valid 56-character Stellar addresses
function generateValidAddress(prefix: "G" | "C"): string {
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = prefix;
  for (let i = 0; i < 55; i++) {
    result += base32Chars[Math.floor(Math.random() * base32Chars.length)];
  }
  return result;
}

// ── Stellar address validation tests ─────────────────────────────────────

test("isValidStellarAddress validates address format", () => {
  // Valid 56-character addresses starting with G or C
  const validG = generateValidAddress("G");
  const validC = generateValidAddress("C");
  assert.equal(isValidStellarAddress(validG), true);
  assert.equal(isValidStellarAddress(validC), true);
  
  // Invalid formats
  assert.equal(isValidStellarAddress("INVALID"), false); // Too short
  assert.equal(isValidStellarAddress("G" + "A".repeat(56)), false); // Too long
  assert.equal(isValidStellarAddress("A" + "A".repeat(55)), false); // Wrong prefix
  assert.equal(isValidStellarAddress(validG.toLowerCase()), false); // Lowercase
  assert.equal(isValidStellarAddress(null as any), false); // Non-string
});

// ── Money field validation tests ─────────────────────────────────────────

test("validateMoneyField validates money values", () => {
  // Valid values
  assert.equal(validateMoneyField(0, "test"), true);
  assert.equal(validateMoneyField(100, "test"), true);
  assert.equal(validateMoneyField(100.5, "test"), true);
  assert.equal(validateMoneyField(0.000001, "test"), true); // USDC has 6 decimals
  
  // Invalid values
  assert.equal(validateMoneyField(-1, "test"), false); // Negative
  assert.equal(validateMoneyField(NaN, "test"), false); // NaN
  assert.equal(validateMoneyField(Infinity, "test"), false); // Infinity
  assert.equal(validateMoneyField("100" as any, "test"), false); // Non-number
});

// ── Claim accounting validation tests ─────────────────────────────────────

test("validateClaimAccounting validates claim accounting", () => {
  // Create a minimal valid claim for testing
  const validClaim: ClaimData = {
    id: 1,
    creator: generateValidAddress("G"),
    question: "Test",
    creator_position: "Yes",
    counter_position: "No",
    resolution_url: "",
    resolution_summary: "",
    creator_stake: 100,
    total_challenger_stake: 50,
    reserved_creator_liability: 0,
    available_creator_liability: 100,
    deadline: Date.now() / 1000 + 86400,
    state: "open",
    winner_side: "",
    confidence: 50,
    category: "custom",
    parent_id: 0,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 1500,
    handicap_line: "",
    settlement_rule: "",
    max_challengers: 10,
    visibility: "public",
    is_private: false,
    challenger_count: 1,
    challengers: [],
    first_challenger: "",
    challenger_addresses: [generateValidAddress("G")],
    total_pot: 150,
    resolve_attempts: 0,
    creator_requested_resolve: false,
    challenger_requested_resolve: false,
  };
  
  const errors = validateClaimAccounting(validClaim);
  assert.deepEqual(errors, []);
  
  // Test invalid stake
  const invalidStake = { ...validClaim, creator_stake: -100, available_creator_liability: -100 };
  const stakeErrors = validateClaimAccounting(invalidStake);
  assert.ok(stakeErrors.length > 0);
  assert.ok(stakeErrors.some(e => e.includes("Invalid creator_stake")));
  
  // Test pot mismatch
  const invalidPot = { ...validClaim, total_pot: 999 };
  const potErrors = validateClaimAccounting(invalidPot);
  assert.ok(potErrors.length > 0);
  assert.ok(potErrors.some(e => e.includes("Pot mismatch")));
});

// ── Claim state comparison tests ─────────────────────────────────────────

test("compareClaimStates compares indexed and chain states", () => {
  const validAddr = generateValidAddress("G");
  const indexed: ClaimRow = {
    id: 1,
    creator: validAddr,
    question: "Test",
    creator_position: "Yes",
    counter_position: "No",
    resolution_url: "",
    resolution_summary: "",
    creator_stake: 100,
    total_challenger_stake: 50,
    reserved_creator_liability: 0,
    deadline: Date.now() / 1000 + 86400,
    state: "open",
    winner_side: "",
    confidence: 50,
    category: "custom",
    parent_id: 0,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 1500,
    handicap_line: "",
    settlement_rule: "",
    max_challengers: 10,
    visibility: "public",
    challenger_count: 1,
    total_pot: 150,
    first_challenger: validAddr,
    first_indexed_at: Date.now(),
    updated_at: Date.now(),
    is_final: 0,
  };
  
  const chain: ClaimData = {
    id: 1,
    creator: validAddr,
    question: "Test",
    creator_position: "Yes",
    counter_position: "No",
    resolution_url: "",
    resolution_summary: "",
    creator_stake: 100,
    total_challenger_stake: 50,
    reserved_creator_liability: 0,
    available_creator_liability: 100,
    deadline: Date.now() / 1000 + 86400,
    state: "open",
    winner_side: "",
    confidence: 50,
    category: "custom",
    parent_id: 0,
    market_type: "binary",
    odds_mode: "pool",
    challenger_payout_bps: 1500,
    handicap_line: "",
    settlement_rule: "",
    max_challengers: 10,
    visibility: "public",
    is_private: false,
    challenger_count: 1,
    challengers: [],
    first_challenger: validAddr,
    challenger_addresses: [validAddr],
    total_pot: 150,
    resolve_attempts: 0,
    creator_requested_resolve: false,
    challenger_requested_resolve: false,
  };
  
  // No discrepancies for identical states
  const noDiscrepancies = compareClaimStates(indexed, chain);
  assert.deepEqual(noDiscrepancies, []);
  
  // State discrepancy
  const chainDifferentState = { ...chain, state: "active" as ClaimData["state"] };
  const stateDiscrepancies = compareClaimStates(indexed, chainDifferentState);
  assert.equal(stateDiscrepancies.length, 1);
  assert.equal(stateDiscrepancies[0].field, "state");
  assert.equal(stateDiscrepancies[0].severity, "critical");
  
  // Stake discrepancy
  const chainDifferentStake = { ...chain, creator_stake: 150, total_pot: 200, available_creator_liability: 150 };
  const stakeDiscrepancies = compareClaimStates(indexed, chainDifferentStake);
  assert.ok(stakeDiscrepancies.length >= 1);
  assert.ok(stakeDiscrepancies.some(d => d.field === "creator_stake" && d.severity === "critical"));
  
  // Warning-level discrepancy
  const chainDifferentCategory = { ...chain, category: "sports" };
  const warningDiscrepancies = compareClaimStates(indexed, chainDifferentCategory);
  assert.equal(warningDiscrepancies.length, 1);
  assert.equal(warningDiscrepancies[0].field, "category");
  assert.equal(warningDiscrepancies[0].severity, "warning");
});

// ── Cursor validation tests ────────────────────────────────────────────────

test("validateCursorValue validates cursor values", () => {
  // Valid values
  assert.equal(validateCursorValue("100", "test", "test-context"), 100);
  assert.equal(validateCursorValue("0", "test", "test-context"), 0);
  assert.equal(validateCursorValue(null, "test", "test-context"), null);
  assert.equal(validateCursorValue("", "test", "test-context"), null);
  
  // Invalid values
  assert.equal(validateCursorValue("-1", "test", "test-context"), null); // Negative
  assert.equal(validateCursorValue("1.5", "test", "test-context"), null); // Not integer
  assert.equal(validateCursorValue("0x64", "test", "test-context"), null); // Hexadecimal
  assert.equal(validateCursorValue("1e2", "test", "test-context"), null); // Scientific notation
  assert.equal(validateCursorValue("  100  ", "test", "test-context"), null); // Whitespace
  assert.equal(validateCursorValue("abc", "test", "test-context"), null); // Non-numeric
  assert.equal(validateCursorValue("NaN", "test", "test-context"), null); // NaN
  assert.equal(validateCursorValue("Infinity", "test", "test-context"), null); // Infinity
});
