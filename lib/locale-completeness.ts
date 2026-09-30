/**
 * Locale completeness utilities for Mimir.
 *
 * Responsibilities
 * ─────────────────
 * 1. Flatten a nested message JSON into dot-separated leaf keys.
 * 2. Diff a translation locale against the English baseline.
 * 3. Flag keys belonging to funded-feature namespaces as hard errors.
 *
 * Funded-feature namespaces
 * ─────────────────────────
 * These namespaces expose UI strings for features that move real USDC or
 * gate access to money-touching flows.  A missing key here silently falls
 * back to the key path (or throws at runtime), which means a translated user
 * could be left without the information they need before staking.  Treat
 * every missing key inside one of these namespaces as a hard error regardless
 * of whether the locale is otherwise partial or experimental.
 *
 *   dashboard   — copy-trading mirror controls, portfolio value display
 *   wallet      — USDC trust-line gate, balance display, approval flows
 *   home        — agent-wallet / x402 payment CTAs on the landing page
 *   create      — stake-input, fee disclosure, settlement-mode labels
 *   vsDetail    — payout card, fee breakdown, settlement receipt
 *
 * No network calls, no filesystem access at runtime — callers load the JSON
 * and pass it in.  This keeps the module testable without mocks.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A flat dot-separated key from a nested message object (arrays are opaque). */
export type FlatKey = string;

/** Per-locale diff result returned by {@link checkLocale}. */
export interface LocaleCheckResult {
  /** Locale identifier, e.g. "es". */
  locale: string;
  /** Keys present in the baseline but absent from this locale. */
  missing: FlatKey[];
  /** Keys present in this locale but absent from the baseline (may be stale). */
  extra: FlatKey[];
  /**
   * Keys that carry the same value as the baseline — almost certainly not
   * translated yet.  Only populated for non-English locales.
   */
  untranslated: FlatKey[];
  /**
   * Whether any missing key belongs to a funded-feature namespace.
   * `true` means the locale MUST NOT be shipped.
   */
  hasFundedViolation: boolean;
  /** Subset of `missing` that belongs to funded-feature namespaces. */
  missingFunded: FlatKey[];
}

/** Aggregate result for a full check across all registered locales. */
export interface CompletenessReport {
  baseline: string;
  results: LocaleCheckResult[];
  /** True when any locale has missing keys or funded violations. */
  hasErrors: boolean;
  /** True when any locale has funded-feature violations specifically. */
  hasFundedErrors: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Top-level namespaces whose keys are considered funded-feature critical.
 * Extend this list when a new namespace gates a money-touching flow.
 *
 * Keep sorted for readability; the set membership check is O(1) regardless.
 */
export const FUNDED_NAMESPACES: ReadonlySet<string> = new Set([
  "create",    // stake input, fee disclosure, settlement-mode labels
  "dashboard", // copy-trading controls, portfolio value
  "home",      // agent-wallet / x402 CTAs on the landing page
  "vsDetail",  // payout card, fee breakdown, settlement receipt
  "wallet",    // USDC trust-line gate, balance display
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Flatten a nested message object into a sorted array of dot-separated leaf
 * keys.  Arrays are treated as atomic leaves (their index paths are not
 * expanded) because next-intl renders array entries as a unit and we don't
 * need per-element completeness tracking.
 *
 * @example
 * flattenKeys({ a: { b: "x", c: "y" }, d: [1, 2] })
 * // → ["a.b", "a.c", "d"]
 */
export function flattenKeys(
  obj: Record<string, unknown>,
  prefix = "",
): FlatKey[] {
  const keys: FlatKey[] = [];

  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;

    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      keys.push(...flattenKeys(v as Record<string, unknown>, full));
    } else {
      keys.push(full);
    }
  }

  return keys.sort();
}

/**
 * Return the top-level namespace of a dot-separated key.
 * "dashboard.copyTrading.enable" → "dashboard"
 */
function topNamespace(key: FlatKey): string {
  return key.split(".")[0] ?? key;
}

/**
 * Retrieve the leaf value for a dot-separated key from a nested object.
 * Returns `undefined` if the path does not exist.
 */
function getLeafValue(
  obj: Record<string, unknown>,
  key: FlatKey,
): unknown {
  const parts = key.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  return cursor;
}

// ── Core diff ────────────────────────────────────────────────────────────────

/**
 * Compare a locale message file against the English baseline.
 *
 * @param baseline  - Parsed `messages/en.json` content.
 * @param locale    - Locale identifier (e.g. "es").
 * @param messages  - Parsed `messages/{locale}.json` content.
 */
export function checkLocale(
  baseline: Record<string, unknown>,
  locale: string,
  messages: Record<string, unknown>,
): LocaleCheckResult {
  const baselineKeys = new Set(flattenKeys(baseline));
  const localeKeys = new Set(flattenKeys(messages));

  const missing: FlatKey[] = [];
  const extra: FlatKey[] = [];
  const untranslated: FlatKey[] = [];

  // Keys in baseline but not in the locale.
  for (const key of baselineKeys) {
    if (!localeKeys.has(key)) {
      missing.push(key);
    }
  }

  // Keys in the locale but not in the baseline.
  for (const key of localeKeys) {
    if (!baselineKeys.has(key)) {
      extra.push(key);
    }
  }

  // For non-English locales, detect keys whose value matches the baseline
  // exactly — a strong signal that they haven't been translated yet.
  if (locale !== "en") {
    for (const key of baselineKeys) {
      if (!localeKeys.has(key)) continue; // already in missing
      const baseVal = getLeafValue(baseline, key);
      const locVal = getLeafValue(messages, key);
      // Only flag string values; numbers, booleans, and arrays are often
      // intentionally identical across locales (IDs, patterns, etc.).
      if (typeof baseVal === "string" && baseVal === locVal) {
        untranslated.push(key);
      }
    }
  }

  const missingFunded = missing.filter((k) =>
    FUNDED_NAMESPACES.has(topNamespace(k))
  );

  return {
    locale,
    missing: missing.sort(),
    extra: extra.sort(),
    untranslated: untranslated.sort(),
    hasFundedViolation: missingFunded.length > 0,
    missingFunded: missingFunded.sort(),
  };
}

/**
 * Run completeness checks for all provided locales and produce a summary
 * report.
 *
 * @param baseline      - Parsed `messages/en.json` content.
 * @param localeFiles   - Map of locale → parsed message object (excludes "en").
 */
export function checkAll(
  baseline: Record<string, unknown>,
  localeFiles: Map<string, Record<string, unknown>>,
): CompletenessReport {
  const results: LocaleCheckResult[] = [];

  for (const [locale, messages] of localeFiles) {
    results.push(checkLocale(baseline, locale, messages));
  }

  // Extra keys are warnings (stale translations), not errors — the runtime
  // silently ignores unknown keys and they do not block users from features.
  // Only missing keys block deployment.
  const hasErrors = results.some((r) => r.missing.length > 0);
  const hasFundedErrors = results.some((r) => r.hasFundedViolation);

  return {
    baseline: "en",
    results,
    hasErrors,
    hasFundedErrors,
  };
}
