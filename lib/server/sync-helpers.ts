/**
 * Shared helper functions for index synchronization and validation.
 *
 * This module contains common utilities used across different index files
 * to avoid code duplication and ensure consistent validation logic.
 */

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
