/**
 * Oracle confidence tiers (#97).
 *
 * Extracted from agents/oracle/index.ts so the thresholds that decide whether a
 * verdict settles firm, settles as contested, or is refunded are pure,
 * importable, and calibrated against synthetic verdict fixtures
 * (tests/fixtures/oracle-verdicts/confidence-tiers.json). Behaviour is
 * unchanged: same thresholds, same on-chain summary tags, same fetcher cap.
 *
 *   high    confidence ≥ 80        settle as the model said
 *   medium  60 ≤ confidence < 80   settle, summary prefixed "[CONTESTED]"
 *   low     confidence < 60        rewritten to UNRESOLVABLE, so the contract
 *                                  refunds every stake
 *
 * DRAW and UNRESOLVABLE verdicts are never tiered; they pass through as-is.
 * Evidence that was not fetched through a deterministic API is first capped at
 * 75 by applyFetcherTrust, so it can never reach the high tier.
 *
 * Invalid input: a confidence that fails every threshold comparison (NaN) lands
 * in "low" and is refunded, so a malformed number can never pay out a side.
 * lib/verdict.ts already clamps LLM confidence to 0–100 before it gets here.
 *
 * Stale, duplicate, cancelled and dependency-failure conditions are stopped
 * before tiering (lib/verdict.ts guards and the oracle poll loop, which retries
 * on a later poll) and never reach this module.
 *
 * Only the verdict payload is an input: money amounts, wallet addresses,
 * prompts and analytics fields are never read or changed here.
 */

import type { VerdictPayload } from "../verdict";
import type { EvidenceFetcherKind } from "../server/evidence-fetcher";

/** Inclusive lower bounds, unchanged from the original oracle constants. */
export const CONFIDENCE_HIGH_MIN = 80; // ≥ 80  : settle as-is
export const CONFIDENCE_MED_MIN = 60;  // 60–79 : settle, marked contested
                                        // < 60  : refunded as UNRESOLVABLE

/**
 * Evidence not fetched through a deterministic API (CoinGecko) — scraped HTML,
 * even via Jina — can drift, be paginated, or be partially blocked, so it may
 * not produce a firm HIGH-tier settlement.
 */
export const MAX_CONFIDENCE_NON_API = 75;

/** The contract summary field is capped to 500 chars, as before. */
export const MAX_EXPLANATION_CHARS = 500;

// components/SettlementExplanationCard.tsx matches these substrings in the
// on-chain summary to label a receipt. Changing them breaks existing receipts.
export const CONTESTED_TAG = "[CONTESTED]";
export const LOW_CONFIDENCE_TAG = "[LOW CONFIDENCE — refunded]";

export type ConfidenceTier = "high" | "medium" | "low";

export function confidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= CONFIDENCE_HIGH_MIN) return "high";
  if (confidence >= CONFIDENCE_MED_MIN) return "medium";
  // Also catches NaN: every comparison above is false, so it is refunded.
  return "low";
}

function tagged(tag: string, explanation: string): string {
  return `${tag} ${explanation}`.slice(0, MAX_EXPLANATION_CHARS);
}

/**
 * Apply the confidence tier to a verdict. Pure: returns a new payload (or the
 * same one when nothing changes) and never mutates its input.
 */
export function tierVerdict(verdict: VerdictPayload): VerdictPayload {
  if (verdict.verdict === "UNRESOLVABLE" || verdict.verdict === "DRAW") return verdict;

  const tier = confidenceTier(verdict.confidence);
  if (tier === "high") return verdict;
  if (tier === "medium") {
    return { ...verdict, explanation: tagged(CONTESTED_TAG, verdict.explanation) };
  }

  // Low confidence: refund rather than guess.
  return {
    verdict: "UNRESOLVABLE",
    confidence: verdict.confidence,
    explanation: tagged(LOW_CONFIDENCE_TAG, verdict.explanation),
  };
}

/** Cap confidence and tag the audit trail for non-API evidence. */
export function applyFetcherTrust(
  verdict: VerdictPayload,
  fetcher: EvidenceFetcherKind | "none",
): VerdictPayload {
  if (fetcher === "coingecko-api") return verdict;
  if (verdict.verdict === "UNRESOLVABLE") return verdict;
  const cappedConfidence = Math.min(verdict.confidence, MAX_CONFIDENCE_NON_API);
  const tag = fetcher === "jina" ? "[via-jina]" : fetcher === "direct" ? "[via-scrape]" : "[no-fetch]";
  return {
    ...verdict,
    confidence: cappedConfidence,
    explanation: tagged(tag, verdict.explanation),
  };
}
