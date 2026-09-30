/**
 * Shared helper functions for index synchronization and validation.
 *
 * This module contains common utilities used across different index files
 * to avoid code duplication and ensure consistent validation logic.
 */

import type { ClaimData } from "@/lib/contract";
import type { ClaimRow } from "@/lib/db";

// Re-export for backwards compatibility with existing tests
export { isValidStellarAddress, validateMoneyField };

// ── Chain-state reconciliation and validation ───────────────────────────────

/**
 * Compare indexed claim state with chain state to detect inconsistencies.
 *
 * This is the contract-first accounting check: if the indexed state differs
 * from chain state, the index is wrong and must be corrected. Common drift
 * sources include RPC failures during sync, manual DB edits, or stale cache
 * reads that were persisted.
 */
export interface ClaimDiscrepancy {
  claimId: number;
  field: string;
  indexed: unknown;
  chain: unknown;
  severity: "critical" | "warning";
}

export function compareClaimStates(
  indexed: ClaimRow,
  chain: ClaimData
): ClaimDiscrepancy[] {
  const discrepancies: ClaimDiscrepancy[] = [];
  
  // Critical fields that must match exactly
  if (indexed.state !== chain.state) {
    discrepancies.push({
      claimId: indexed.id,
      field: "state",
      indexed: indexed.state,
      chain: chain.state,
      severity: "critical"
    });
  }
  
  if (indexed.creator !== chain.creator) {
    discrepancies.push({
      claimId: indexed.id,
      field: "creator",
      indexed: indexed.creator,
      chain: chain.creator,
      severity: "critical"
    });
  }
  
  // Financial fields that must match exactly (accounting correctness)
  if (Math.abs(indexed.creator_stake - chain.creator_stake) > 0.001) {
    discrepancies.push({
      claimId: indexed.id,
      field: "creator_stake",
      indexed: indexed.creator_stake,
      chain: chain.creator_stake,
      severity: "critical"
    });
  }
  
  if (Math.abs(indexed.total_challenger_stake - chain.total_challenger_stake) > 0.001) {
    discrepancies.push({
      claimId: indexed.id,
      field: "total_challenger_stake",
      indexed: indexed.total_challenger_stake,
      chain: chain.total_challenger_stake,
      severity: "critical"
    });
  }
  
  if (indexed.challenger_count !== chain.challenger_count) {
    discrepancies.push({
      claimId: indexed.id,
      field: "challenger_count",
      indexed: indexed.challenger_count,
      chain: chain.challenger_count,
      severity: "critical"
    });
  }
  
  // Warning-level fields (non-critical but indicate drift)
  if (indexed.category !== chain.category) {
    discrepancies.push({
      claimId: indexed.id,
      field: "category",
      indexed: indexed.category,
      chain: chain.category,
      severity: "warning"
    });
  }
  
  if (indexed.market_type !== chain.market_type) {
    discrepancies.push({
      claimId: indexed.id,
      field: "market_type",
      indexed: indexed.market_type,
      chain: chain.market_type,
      severity: "warning"
    });
  }
  
  return discrepancies;
}

/**
 * Validate Stellar addresses for correctness.
 *
 * Case-sensitive base32 validation ensures we haven't corrupted addresses
 * through lowercase conversions or other transformations.
 */
function isValidStellarAddress(address: string): boolean {
  // Stellar addresses are either G... (account) or C... (contract)
  // They are case-sensitive base32 and should be 56 characters
  if (typeof address !== "string") return false;
  if (address.length !== 56) return false;
  if (!/^[GC]/.test(address)) return false;
  
  // Base32 character set check
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  for (const char of address) {
    if (!base32Chars.includes(char)) return false;
  }
  
  return true;
}

/**
 * Validate money fields for accounting correctness.
 *
 * Ensures stakes and payouts are non-negative finite numbers with reasonable
 * precision (6 decimal places for USDC).
 */
function validateMoneyField(value: number, fieldName: string, context: string = ""): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value)) return false;
  if (value < 0) return false;
  
  // Check for reasonable precision (USDC has 6 decimals)
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  if (Math.abs(value - rounded) > 0.000001) {
    console.warn(`[${context}] Money field ${fieldName} has excessive precision: ${value}`);
    return false;
  }
  
  return true;
}

/**
 * Comprehensive validation of a claim's state against accounting rules.
 */
export function validateClaimAccounting(claim: ClaimData, context: string = ""): string[] {
  const errors: string[] = [];
  
  // Validate addresses
  if (!isValidStellarAddress(claim.creator)) {
    errors.push(`Invalid creator address: ${claim.creator}`);
  }
  
  if (claim.challenger_addresses) {
    for (const addr of claim.challenger_addresses) {
      if (!isValidStellarAddress(addr)) {
        errors.push(`Invalid challenger address: ${addr}`);
      }
    }
  }
  
  // Validate money fields
  if (!validateMoneyField(claim.creator_stake, "creator_stake", context)) {
    errors.push(`Invalid creator_stake: ${claim.creator_stake}`);
  }
  
  if (!validateMoneyField(claim.total_challenger_stake, "total_challenger_stake", context)) {
    errors.push(`Invalid total_challenger_stake: ${claim.total_challenger_stake}`);
  }
  
  if (!validateMoneyField(claim.reserved_creator_liability, "reserved_creator_liability", context)) {
    errors.push(`Invalid reserved_creator_liability: ${claim.reserved_creator_liability}`);
  }
  
  // Validate stake consistency
  const availableLiability = Math.max(0, claim.creator_stake - claim.reserved_creator_liability);
  if (availableLiability < 0) {
    errors.push(`Negative available liability: ${availableLiability}`);
  }
  
  // Validate pot calculation
  const calculatedPot = claim.creator_stake + claim.total_challenger_stake;
  if (Math.abs(calculatedPot - claim.total_pot) > 0.001) {
    errors.push(`Pot mismatch: calculated ${calculatedPot}, stored ${claim.total_pot}`);
  }
  
  // Validate challenger consistency
  if (claim.challenger_count === 0 && claim.total_challenger_stake > 0) {
    errors.push(`Zero challenger count but positive stake: ${claim.total_challenger_stake}`);
  }
  
  if (claim.challenger_count > 0 && claim.total_challenger_stake === 0) {
    errors.push(`Positive challenger count but zero stake: ${claim.challenger_count}`);
  }
  
  return errors;
}

// ── Cursor validation and restart safety ─────────────────────────────────────

/**
 * Validate and sanitize a sync cursor value.
 *
 * Malformed, negative, or non-numeric cursor values are rejected to prevent
 * corrupted state from propagating. This is the defense against a poisoned
 * `sync_meta` row — whether from manual intervention, a failed migration, or
 * a bug in an earlier version.
 */
export function validateCursorValue(value: string | null, key: string, context: string = ""): number | null {
  if (value == null || value === "") return null;
  
  // Trim whitespace to reject "  100  " as invalid
  const trimmed = value.trim();
  if (trimmed !== value) {
    console.warn(`[${context}] Invalid cursor value for ${key}: "${value}" (contains whitespace), resetting to null`);
    return null;
  }
  
  // Reject hexadecimal strings like "0x64"
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    console.warn(`[${context}] Invalid cursor value for ${key}: "${value}" (hexadecimal format), resetting to null`);
    return null;
  }
  
  // Reject scientific notation like "1e2" or "1E2"
  if (/^[+-]?\d+e[+-]?\d+$/i.test(trimmed)) {
    console.warn(`[${context}] Invalid cursor value for ${key}: "${value}" (scientific notation), resetting to null`);
    return null;
  }
  
  const parsed = Number(trimmed);
  // Reject non-finite values, negative numbers, and NaN
  if (!Number.isFinite(parsed) || parsed < 0 || Number.isNaN(parsed)) {
    console.warn(`[${context}] Invalid cursor value for ${key}: "${value}", resetting to null`);
    return null;
  }
  
  // Reject floating point numbers - cursor positions must be integers
  if (!Number.isInteger(parsed)) {
    console.warn(`[${context}] Invalid cursor value for ${key}: "${value}" (not an integer), resetting to null`);
    return null;
  }
  
  return parsed;
}
