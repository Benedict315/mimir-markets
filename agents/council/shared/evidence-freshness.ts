/**
 * Source-freshness gate for council voting.
 *
 * Before a persona passes evidence to the LLM it must be fresh enough to be
 * trustworthy.  Stale evidence (e.g. a cached CoinGecko snapshot from 20 minutes
 * ago) can produce a confident but wrong verdict, which is worse than abstaining.
 *
 * ── Design decisions ─────────────────────────────────────────────────────────
 *
 * 1. **Per-category thresholds via the research-adapter manifest.**
 *    Each adapter declares `freshnessSeconds` (e.g. 300 s for market-data, 3600 s
 *    for official-web).  When the claim's category matches an adapter we use that
 *    adapter's threshold.  This lets a crypto claim tolerate only 5 minutes of
 *    age while a governance claim tolerates an hour.
 *
 * 2. **Conservative council default is shorter than the oracle's.**
 *    The oracle commits evidence at settlement time (hard cap 15 min via
 *    `lib/evidence-commitment.ts`).  The council *votes* before settlement, often
 *    minutes or hours before the deadline.  Using the same 15-min ceiling would
 *    allow a persona to vote on evidence that is ~15 min old — a meaningful window
 *    for fast-moving markets.  The council default is therefore
 *    `COUNCIL_DEFAULT_MAX_EVIDENCE_AGE_MS` (10 min), tighter than the oracle's,
 *    and overridable via `COUNCIL_MAX_EVIDENCE_AGE_MS`.
 *
 * 3. **No timestamp → pass.**
 *    Placeholder entries (fetcher === "none", fetch failed) have no `fetchedAt`.
 *    The caller already handles those via the `"no-evidence"` skip reason; we do
 *    not re-classify them here.
 *
 * 4. **Future timestamps are invalid.**
 *    A `fetchedAt` in the future (clock skew or malformed value) is treated as
 *    stale rather than silently accepted.
 *
 * ── Rollback ─────────────────────────────────────────────────────────────────
 *
 * Set `COUNCIL_MAX_EVIDENCE_AGE_MS=0` to disable the freshness gate (zero means
 * "no cap").  Set it to a large number (e.g. 86400000 for 24 h) to widen the
 * window while keeping it auditable.  Remove the `checkEvidenceFreshness` call
 * in `persona-runner.ts` to revert entirely.
 */

import { RESEARCH_ADAPTERS } from "../../../lib/research/adapters";
import type { EvidenceCacheEntry } from "./types";

/** 10 minutes — tighter than the oracle's 15-min commitment window. */
export const COUNCIL_DEFAULT_MAX_EVIDENCE_AGE_MS = 10 * 60_000;

/**
 * Resolved once at module load.  `0` means the gate is disabled (every entry
 * passes regardless of age).
 */
export const COUNCIL_MAX_EVIDENCE_AGE_MS: number = (() => {
  const raw = process.env.COUNCIL_MAX_EVIDENCE_AGE_MS;
  if (raw === undefined || raw.trim() === "") return COUNCIL_DEFAULT_MAX_EVIDENCE_AGE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : COUNCIL_DEFAULT_MAX_EVIDENCE_AGE_MS;
})();

export interface FreshnessResult {
  fresh: true;
}

export interface StalenessResult {
  fresh:      false;
  ageMs:      number;
  maxAgeMs:   number;
  reason:     string;
}

export type EvidenceFreshnessResult = FreshnessResult | StalenessResult;

/**
 * Return the tightest per-category `freshnessSeconds` from the adapter manifest
 * that covers `category`, converted to milliseconds.  Falls back to the
 * configured council ceiling when no adapter matches.
 *
 * "Tightest" means the smallest (most restrictive) value — when multiple adapters
 * cover a category (e.g. both `market-data-v1` and `official-web-v1` cover
 * "crypto") we prefer the stricter one so the council does not accidentally vote
 * on data a fast-moving adapter would already consider stale.
 */
export function maxAgeForCategory(category: string | undefined | null): number {
  if (COUNCIL_MAX_EVIDENCE_AGE_MS === 0) return 0; // gate disabled

  const cat = (category ?? "").toLowerCase().trim();
  if (cat === "") return COUNCIL_MAX_EVIDENCE_AGE_MS;

  let tightest = COUNCIL_MAX_EVIDENCE_AGE_MS;
  for (const adapter of RESEARCH_ADAPTERS) {
    const covers = adapter.categories.some(
      (c) => c.toLowerCase() === cat || cat.includes(c.toLowerCase()),
    );
    if (covers) {
      const adapterMs = adapter.freshnessSeconds * 1_000;
      if (adapterMs < tightest) {
        tightest = adapterMs;
      }
    }
  }
  return tightest;
}

/**
 * Check whether `entry` is fresh enough for a persona to vote on.
 *
 * @param entry     The cache entry returned by `getOrFetchEvidence`.
 * @param category  The claim's category string (used to select adapter threshold).
 * @param now       Epoch ms reference (defaults to `Date.now()`).  Injectable for
 *                  testing.
 *
 * Returns `{ fresh: true }` when the evidence is within the allowed window, or
 * `{ fresh: false, ageMs, maxAgeMs, reason }` when it is stale or invalid.
 *
 * No `fetchedAt` on the entry (placeholder / failed fetch) → `{ fresh: true }`:
 * the caller already handles those via `"no-evidence"`.
 */
export function checkEvidenceFreshness(
  entry: EvidenceCacheEntry,
  category: string | undefined | null,
  now: number = Date.now(),
): EvidenceFreshnessResult {
  // No timestamp present (placeholder / failed-fetch entries) — not our concern.
  if (entry.fetchedAt === undefined) return { fresh: true };

  const maxAgeMs = maxAgeForCategory(category);

  // Gate disabled.
  if (maxAgeMs === 0) return { fresh: true };

  const fetchedAt = entry.fetchedAt;

  // Malformed / future timestamp.
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > now) {
    return {
      fresh:    false,
      ageMs:    0,
      maxAgeMs,
      reason:   `invalid fetchedAt value (${fetchedAt}); treating as stale`,
    };
  }

  const ageMs = now - fetchedAt;
  if (ageMs > maxAgeMs) {
    return {
      fresh:    false,
      ageMs,
      maxAgeMs,
      reason:   `evidence is ${Math.round(ageMs / 1000)}s old; max for category "${category ?? ""}" is ${Math.round(maxAgeMs / 1000)}s`,
    };
  }

  return { fresh: true };
}
