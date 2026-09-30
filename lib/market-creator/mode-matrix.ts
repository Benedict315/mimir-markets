/**
 * Which settlement mode the market-creator may propose, and when.
 *
 * The agent produces candidates from research; this module decides what shape
 * each candidate is allowed to take. Kept separate from the agent so the rules
 * are testable without an LLM in the loop, and so a rule change is a diff in one
 * file rather than a prompt edit.
 *
 * The governing idea: **an autonomous agent may only propose a mode whose
 * obligations it can actually meet.** Fixed odds obliges the creator's own wallet
 * to cover challenger profit, so an agent must not open one it cannot back. A duel
 * needs a specific opponent, so without one it is an invitation, not a market.
 */

import {
  SETTLEMENT_MODE_POLICY,
  type ProductModifier,
  type SettlementMode,
  type SubjectType,
} from "../market-modes";
import {
  checkCategoryCreatorCap,
  parseCategoryCapPolicy,
  unresolvedCategoryCapPolicy,
  type CategoryCapPolicy,
} from "./category-caps";

export type ProposalDisposition =
  /** Create it now. */
  | "create"
  /** Publish as an open invitation instead of a funded market. */
  | "open_duel_invite"
  /** Hold for human review. */
  | "review"
  /** Do not propose. */
  | "skip";

export interface CandidateInput {
  subjectType: SubjectType;
  category: string;
  /** A named counterparty, when the research found one. */
  targetAgentId?: string;
  /** Settled parent, when this is a rematch candidate. */
  parentClaimId?: number;
  parentIsSettled?: boolean;
  /** Creator wallet's unreserved USDC, display units. */
  availableLiquidityUsdc: number;
  /** Stake the agent intends to post, display USDC. */
  stakeUsdc: number;
  /** Total-return bps, for a fixed-odds proposal. */
  challengerPayoutBps?: number;
  /** Total USDC this agent already has committed to open markets. */
  openExposureUsdc: number;
  /** Markets this agent already has open. */
  activeMarkets: number;
  /**
   * Per-category open inventory for this creator, when the caller has it.
   *
   * Optional so a caller that predates per-category caps keeps its behaviour.
   * When present it is a hard block alongside the global exposure ceiling, and a
   * category it cannot resolve refuses the candidate rather than assuming zero.
   */
  categoryOpen?: { markets: number; exposureUsdc: number };
  /** Quality score from preflight, 0..100. */
  qualityScore: number;
}

export interface CreatorPolicy {
  maxActiveMarkets: number;
  maxOpenExposureUsdc: number;
  /** Below this preflight score, nothing is created autonomously. */
  minQualityScore: number;
  /** Proposal-only: nothing is published without human review. */
  shadowMode: boolean;
  /** Markets per category per run, so one topic cannot flood the feed. */
  maxPerCategoryPerRun: number;
  /**
   * Markets per settlement mode per run.
   *
   * Separate from the category cap because the failure is different: five
   * fixed-odds markets in one run is five bets against the creator's own wallet
   * regardless of how many topics they span.
   */
  maxPerModePerRun: number;
  /**
   * Markets per creator address per run.
   *
   * One agent should not be able to fill a run on its own even when its topics and
   * modes are varied — otherwise the whole feed is one wallet's opinion.
   */
  maxPerCreatorPerRun: number;
  /**
   * Per-category creator caps: open markets and notional exposure inside each
   * category, each with a configurable default.
   *
   * Distinct from `maxPerCategoryPerRun`, which is a per-run diversity quota.
   * This bounds the creator's *standing inventory* in a category, reusing the
   * same definition of "open" as `maxOpenExposureUsdc`. See `category-caps.ts`.
   */
  categoryCaps: CategoryCapPolicy;
}

export function defaultCreatorPolicy(
  env: Record<string, string | undefined> = process.env,
): CreatorPolicy {
  const maxOpenExposureUsdc = Number(env.MARKET_CREATOR_MAX_EXPOSURE_USDC ?? 100);
  // A malformed per-category cap must not silently become "unlimited". It
  // resolves to a policy that refuses every category; the worker validates the
  // same value at boot and fails fast with the parse error.
  const categoryCaps = parseCategoryCapPolicy(env, { defaultMaxExposureUsdc: maxOpenExposureUsdc });
  return {
    maxActiveMarkets: Number(env.MARKET_CREATOR_MAX_ACTIVE ?? 30),
    maxOpenExposureUsdc,
    minQualityScore: Number(env.MARKET_CREATOR_PREFLIGHT_MIN_SCORE ?? 60),
    // Default ON: autonomous publishing is opt-in, per the roadmap's gate that
    // shadow precision must be measured before it is enabled.
    shadowMode: env.MARKET_CREATOR_AUTONOMOUS !== "1",
    maxPerCategoryPerRun: Number(env.MARKET_CREATOR_MAX_PER_CATEGORY ?? 2),
    maxPerModePerRun: Number(env.MARKET_CREATOR_MAX_PER_MODE ?? 3),
    maxPerCreatorPerRun: Number(env.MARKET_CREATOR_MAX_PER_CREATOR ?? 3),
    categoryCaps: categoryCaps.ok
      ? categoryCaps.policy
      : unresolvedCategoryCapPolicy(categoryCaps.error),
  };
}

export interface ModeDecision {
  settlementMode: SettlementMode;
  modifiers: ProductModifier[];
  disposition: ProposalDisposition;
  /** Why this mode, in one line, stored with the proposal for review. */
  rationale: string;
  /** Reason a proposal was downgraded or skipped. */
  blockedBy?: string;
}

/**
 * Decide the mode for one candidate.
 *
 * Order is deliberate: hard blocks first (quality, exposure, slots, per-category
 * caps), then the mode's own obligations. A candidate refused for quality must not
 * also be told its liquidity is short — the first reason is the actionable one.
 */
export function decideMode(
  candidate: CandidateInput,
  requested: SettlementMode,
  policy: CreatorPolicy = defaultCreatorPolicy(),
): ModeDecision {
  const base = { settlementMode: requested, modifiers: [] as ProductModifier[] };

  if (candidate.qualityScore < policy.minQualityScore) {
    return {
      ...base,
      disposition: "skip",
      rationale: "below the preflight quality bar",
      blockedBy: `quality ${candidate.qualityScore} < ${policy.minQualityScore}`,
    };
  }
  if (candidate.activeMarkets >= policy.maxActiveMarkets) {
    return {
      ...base,
      disposition: "skip",
      rationale: "active market cap reached",
      blockedBy: `${candidate.activeMarkets}/${policy.maxActiveMarkets} active`,
    };
  }
  if (candidate.openExposureUsdc + candidate.stakeUsdc > policy.maxOpenExposureUsdc) {
    return {
      ...base,
      disposition: "skip",
      rationale: "would exceed the agent's open exposure cap",
      blockedBy: `${candidate.openExposureUsdc + candidate.stakeUsdc} > ${policy.maxOpenExposureUsdc}`,
    };
  }

  // Standing inventory inside the candidate's own category, when the caller has
  // it. Checked after the global ceiling so the money reason comes first.
  if (candidate.categoryOpen) {
    const categoryGate = checkCategoryCreatorCap({
      category: candidate.category,
      policy: policy.categoryCaps,
      openMarkets: candidate.categoryOpen.markets,
      openExposureUsdc: candidate.categoryOpen.exposureUsdc,
      stakeUsdc: candidate.stakeUsdc,
    });
    if (!categoryGate.allowed) {
      return {
        ...base,
        disposition: "skip",
        rationale: "would exceed the creator's per-category cap",
        blockedBy: categoryGate.blockedBy,
      };
    }
  }

  const settled = (() => {
    switch (requested) {
      case "duel":
        // A duel without a named opponent is an invitation, not a market: nobody
        // is obliged to take the other side.
        return candidate.targetAgentId
          ? {
              ...base,
              disposition: "create" as ProposalDisposition,
              rationale: `private duel against ${candidate.targetAgentId}`,
            }
          : {
              ...base,
              disposition: "open_duel_invite" as ProposalDisposition,
              rationale: "no named opponent — published as an open duel invitation",
            };

      case "fixed_odds": {
        const bps = candidate.challengerPayoutBps ?? 0;
        if (bps <= 10_000) {
          return {
            ...base,
            disposition: "skip" as ProposalDisposition,
            rationale: "fixed odds needs a total return above 1x",
            blockedBy: `challengerPayoutBps ${bps}`,
          };
        }
        // The creator's own wallet must cover challenger PROFIT, so the agent
        // may not open a market it cannot back.
        const profitPerFullStake = (candidate.stakeUsdc * (bps - 10_000)) / 10_000;
        if (profitPerFullStake > candidate.availableLiquidityUsdc) {
          return {
            ...base,
            disposition: "skip" as ProposalDisposition,
            rationale: "insufficient liquidity to back the posted odds",
            blockedBy: `needs ${profitPerFullStake}, has ${candidate.availableLiquidityUsdc}`,
          };
        }
        return {
          ...base,
          disposition: "create" as ProposalDisposition,
          rationale: `creator-backed ${(bps / 10_000).toFixed(2)}x total return`,
        };
      }

      case "squad_pool":
        return {
          ...base,
          disposition: "skip" as ProposalDisposition,
          rationale: "squad markets need the v2 escrow",
          blockedBy: `needs contract v${SETTLEMENT_MODE_POLICY.squad_pool.requiresContractVersion}`,
        };

      case "pool":
      default:
        return {
          ...base,
          settlementMode: "pool" as SettlementMode,
          disposition: "create" as ProposalDisposition,
          rationale: "public multi-participant topic",
        };
    }
  })();

  // A rematch is a modifier on top of a mode, and only exists with a settled
  // parent — an unsettled one has no result to run back from.
  const modifiers: ProductModifier[] = [];
  if (candidate.parentClaimId && candidate.parentIsSettled) modifiers.push("rematch_ladder");

  const withModifiers = { ...settled, modifiers };

  // Shadow mode downgrades a create to review; it never upgrades anything.
  if (policy.shadowMode && withModifiers.disposition === "create") {
    return {
      ...withModifiers,
      disposition: "review",
      rationale: `${withModifiers.rationale} (shadow mode: held for review)`,
    };
  }
  return withModifiers;
}

/**
 * Underdog, streak and conviction are NOT creation-time modes.
 *
 * Underdog is a property of a pool that has formed; streak and conviction are
 * projections over resolved claims. An agent that "created an underdog market"
 * would be asserting a pool shape that does not exist yet.
 */
export const CREATE_TIME_MODIFIERS: ProductModifier[] = ["rematch_ladder"];

export function isCreateTimeModifier(modifier: ProductModifier): boolean {
  return CREATE_TIME_MODIFIERS.includes(modifier);
}

// ── Duplicate detection ───────────────────────────────────────────────────────

export interface DuplicateSignature {
  entities: string[];
  /** The event or metric being asked about. */
  event: string;
  threshold?: number;
  units?: string;
  /** Deadline bucketed to the day, so "same day" counts as the same market. */
  deadlineDay: string;
}

/**
 * Signature for duplicate detection.
 *
 * Comparing question STRINGS is useless: an LLM rewords the same market endlessly
 * ("Will BTC top 100k?" vs "Is Bitcoin going above $100,000?"). Comparing the
 * entities, the event, the threshold and the deadline day catches those, and does
 * not collide two genuinely different thresholds on the same entity.
 */
export function duplicateSignature(input: {
  entities: string[];
  event: string;
  threshold?: number;
  units?: string;
  /** Unix seconds. */
  deadline: number;
}): DuplicateSignature {
  return {
    entities: [...new Set(input.entities.map((e) => e.trim().toLowerCase()).filter(Boolean))].sort(),
    event: input.event.trim().toLowerCase().replace(/\s+/g, " "),
    threshold: input.threshold,
    units: input.units?.trim().toLowerCase(),
    deadlineDay: new Date(input.deadline * 1000).toISOString().slice(0, 10),
  };
}

export function signatureKey(signature: DuplicateSignature): string {
  return [
    signature.entities.join("+"),
    signature.event,
    signature.threshold === undefined ? "" : String(signature.threshold),
    signature.units ?? "",
    signature.deadlineDay,
  ].join("|");
}

export function isDuplicate(
  candidate: DuplicateSignature,
  existing: DuplicateSignature[],
): boolean {
  const key = signatureKey(candidate);
  return existing.some((other) => signatureKey(other) === key);
}

// ── Per-run diversity ─────────────────────────────────────────────────────────

export interface RunSlot {
  category: string;
  signature: DuplicateSignature;
  /** Settlement mode this slot would open in. */
  mode?: SettlementMode;
  /** Address that would create it. */
  creator?: string;
}

export interface AdmissionResult {
  admitted: boolean;
  reason?: "duplicate" | "category_quota" | "mode_quota" | "creator_quota" | "run_quota";
}

/**
 * Admit a candidate into this run.
 *
 * Quotas exist so one hot topic cannot flood the feed. They are NOT a mandate to
 * manufacture variety: a run that only finds two good markets should publish two,
 * not pad to a quota with weak ones — which is why this only ever refuses.
 */
export function admitToRun(
  candidate: RunSlot,
  accepted: RunSlot[],
  policy: CreatorPolicy = defaultCreatorPolicy(),
  maxPerRun = 5,
): AdmissionResult {
  if (isDuplicate(candidate.signature, accepted.map((slot) => slot.signature))) {
    return { admitted: false, reason: "duplicate" };
  }
  if (accepted.length >= maxPerRun) return { admitted: false, reason: "run_quota" };
  const inCategory = accepted.filter((slot) => slot.category === candidate.category).length;
  if (inCategory >= policy.maxPerCategoryPerRun) {
    return { admitted: false, reason: "category_quota" };
  }
  // Mode and creator caps only apply when the slot declares them: an older caller
  // that supplies neither keeps its previous behaviour rather than being refused
  // by a field it does not know about.
  if (candidate.mode) {
    const inMode = accepted.filter((slot) => slot.mode === candidate.mode).length;
    if (inMode >= policy.maxPerModePerRun) return { admitted: false, reason: "mode_quota" };
  }
  if (candidate.creator) {
    const key = candidate.creator.toLowerCase();
    const byCreator = accepted.filter((slot) => slot.creator?.toLowerCase() === key).length;
    if (byCreator >= policy.maxPerCreatorPerRun) {
      return { admitted: false, reason: "creator_quota" };
    }
  }
  return { admitted: true };
}
