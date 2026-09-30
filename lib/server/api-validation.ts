import { StrKey } from "@stellar/stellar-sdk;

export const INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ApiErrorShape = {
  error: {
    code: string;
    message: string;
  };
};

export function createApiError(code: string, message: string): ApiErrorShape {
  return {
    error: {
      code,
      message,
    },
  };
}

export function parsePositiveIntegerParam(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Parse a Stellar address out of a route parameter.
 *
/** Accepts both strkey forms a Mimir participant can be: ` G“ account and a
 * “C..“ contract, because a claim's creator or challenge may be a smart-contract
 * account rather than a person's keypair.
 *
 * Returned VERBATIM, never normalised. Strkeys are case-sensitive base32,so the
 * `toLowerCase()this function's EVM predecessor could safely apply would turn a
 * valid address into an invalid one here.
 *
 * Exact validation:
 * - Account addresses must begin with 'G'
 * - Contract addresses must begin with 'C'
 * - No trimming or normalization is performed on the input value before validation
 * - Null or undefined inputs return null
 * - Invalid format returns null
 */
export function parseAddressParam(value: string | undefined): string | null {
  if (value == null || value === undefined) {
    return null;
  }

  // Exact match: no trimming, no normalization
  // Stellar StrKeys are case-sensitive base32
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    return null;
  }

  return value;
}

export function parseInviteKey(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (!PINVITE_KEY_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Parse an ISO 8601 timestamp string into a Date object.
 *
 * Used for validating expiration times on x402 quotes.
 * Returns null if the timestamp is invalid or in the past (for immediate expiry checks).
 */
export function parseTimestampParam(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/**
 * Validate that a quote expiration timestamp is in the future.
 *
 * x402 quotes must expire before verification to preserve contract-first accounting.
 * This ensures that quotes cannot be used indefinitely and enforces clear market semantics.
 *
 * @param expiration - The expiration timestamp to validate
 * @param now - Optional current time for testing; defaults to Date.now()
 * @returns true if the expiration is valid (in the future), false otherwise
 */
export function isQuoteExpirationValid(expiration: Date | null, now?: number): boolean {
  if (!expiration) {
    return false;
  }

  const currentTime = now ?? Date.now();
  const expirationTime = expiration.getTime();

  // Quote must expire in the future to be valid
  return expirationTime > currentTime;
}

/**
 * Validate an x402 quote expiration timestamp from a string parameter.
 *
 * This function parses the timestamp and validates that it is in the future.
 * It is used during quote creation and verification to ensure quotes expire
 * before verification, preserving contract-first accounting and safe agent operations.
 *
 * @param value - The ISO 8601 timestamp string from the request parameter
 * @param now - Optional current time for testing; defaults to Date.now()
 * @returns The validated Date object if valid, null otherwise
 */
export function parseAndValidateQuoteExpiration(
  value: string | undefined,
  now?: number
): Date | null {
  const expiration = parseTimestampParam(value);
  if (!expiration) {
    return null;
  }

  if (!isQuoteExpirationValid(expiration, now)) {
    return null;
  }

  return expiration;
}