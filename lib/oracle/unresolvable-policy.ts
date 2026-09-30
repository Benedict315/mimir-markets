/**
 * Oracle settlement policy — the explicit UNRESOLVABLE (refund) rules (#99).
 *
 * Before this module the oracle worked out what happened to a verdict after
 * the fact, by diffing strings against the raw model output. That logged a
 * model-issued UNRESOLVABLE as "FIRM" and every fetcher-tagged verdict as
 * "CONTESTED", and a malformed confidence (e.g. 150) could still settle a
 * side. applySettlementPolicy() names every outcome instead:
 *
 *   firm       decisive verdict left unchanged by the confidence tier
 *   contested  decisive verdict the tier marked "[CONTESTED]" (still settles)
 *   draw       DRAW passes through untouched
 *   refund     on-chain UNRESOLVABLE: the contract returns every stake in full
 *              with zero fee (lib/fees.ts). Exactly three reasons exist:
 *                model-unresolvable  the model/council itself said UNRESOLVABLE
 *                low-confidence      the confidence tier refunded a weak verdict
 *                invalid-confidence  decisive verdict whose confidence is NaN,
 *                                    ±Infinity or outside 0–100
 *
 * The confidence thresholds themselves belong to the oracle's tierVerdict and
 * are passed in, so this module only owns the refund decision. Tiering must
 * never move a decisive verdict to the other side or to DRAW; if it ever did,
 * the policy throws and the oracle writes nothing (the claim is retried on the
 * next poll).
 *
 * Deliberately NOT reasons to settle UNRESOLVABLE: invalid JSON, a missing or
 * invalid verdict, stale or duplicate claims, cancelled markets, and
 * dependency failures (LLM, RPC, evidence fetch). Those are stopped before the
 * policy by lib/verdict.ts and the poll loop, which skips the claim and retries
 * later, because refunding during an outage would close a market that may
 * still be decidable.
 *
 * Only the verdict payload is an input: money amounts, wallet addresses,
 * prompts and analytics fields are never read or changed here.
 */

import type { VerdictPayload } from "../verdict";

export type UnresolvableReason = "model-unresolvable" | "low-confidence" | "invalid-confidence";

export type SettlementOutcome = "firm" | "contested" | "draw" | "refund";

export type SettlementDecision =
  | { outcome: "firm" | "contested" | "draw"; verdict: VerdictPayload }
  | {
      outcome: "refund";
      reason: UnresolvableReason;
      /** Always UNRESOLVABLE: the contract refunds every stake. */
      verdict: VerdictPayload & { verdict: "UNRESOLVABLE" };
    };

/** The oracle's confidence-tier step (agents/oracle tierVerdict). */
export type TierVerdict = (verdict: VerdictPayload) => VerdictPayload;

/**
 * Summary tag for invalid-confidence refunds. It starts with "[LOW CONFIDENCE"
 * so components/SettlementExplanationCard.tsx labels the receipt "refunded".
 */
export const INVALID_CONFIDENCE_TAG = "[LOW CONFIDENCE — refunded: invalid confidence]";

/** The contract summary field is capped to 500 chars. */
const MAX_EXPLANATION_CHARS = 500;

/** True for a finite confidence in the 0–100 range the verdict schema allows. */
export function isValidConfidence(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 100;
}

/**
 * Decide how a verdict settles. Pure: same input, same decision, and the input
 * is never mutated. For every valid confidence the returned verdict is exactly
 * what tierVerdict alone produced before #99.
 */
export function applySettlementPolicy(
  verdict: VerdictPayload,
  tierVerdict: TierVerdict,
): SettlementDecision {
  if (verdict.verdict === "UNRESOLVABLE") {
    // Passed through with no extra tag, so existing summaries keep their text.
    return { outcome: "refund", reason: "model-unresolvable", verdict: { ...verdict, verdict: "UNRESOLVABLE" } };
  }

  // DRAW never pays out one side, so it keeps its existing pass-through.
  if (verdict.verdict === "DRAW") return { outcome: "draw", verdict };

  if (!isValidConfidence(verdict.confidence)) {
    // Never settle money on a malformed number, and never write it to chain.
    return {
      outcome: "refund",
      reason: "invalid-confidence",
      verdict: {
        verdict: "UNRESOLVABLE",
        confidence: 0,
        explanation: `${INVALID_CONFIDENCE_TAG} ${verdict.explanation}`.slice(0, MAX_EXPLANATION_CHARS),
      },
    };
  }

  const tiered = tierVerdict(verdict);

  if (tiered.verdict === "UNRESOLVABLE") {
    return { outcome: "refund", reason: "low-confidence", verdict: { ...tiered, verdict: "UNRESOLVABLE" } };
  }

  if (tiered.verdict !== verdict.verdict) {
    throw new Error(
      `Confidence tiering changed a ${verdict.verdict} verdict to ${tiered.verdict}; refusing to settle.`,
    );
  }

  // The tier only rewrites the explanation when it marks a verdict contested.
  return { outcome: tiered.explanation === verdict.explanation ? "firm" : "contested", verdict: tiered };
}

/** Short label for oracle logs: FIRM / CONTESTED / DRAW / REFUND(<reason>). */
export function describeDecision(decision: SettlementDecision): string {
  return decision.outcome === "refund" ? `REFUND(${decision.reason})` : decision.outcome.toUpperCase();
}
