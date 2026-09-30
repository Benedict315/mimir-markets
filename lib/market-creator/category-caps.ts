/**
 * Per-category creator caps for the market-creator agent.
 *
 * `mode-matrix.ts` already caps a category *per run*, and `exposure-caps.ts`
 * caps a creator's open exposure across *everything*. Neither answers the
 * operational question the funded-state safety model needs: how much may one
 * creator keep open inside one category at a time? A creator with its whole
 * ceiling committed to crypto has satisfied the global cap and still has no
 * boundary stopping it from opening the same notional again in weather, while a
 * creator with one very large market in one topic has satisfied the notional cap
 * and can still flood that topic with many tiny ones.
 *
 * This module is the accounting and decision layer for that boundary. It does
 * **not** redefine what "open" means: it reuses `exposureSkipReason` and
 * `exposureUsdcForClaim` from `exposure-caps.ts`, so a cancelled, resolved,
 * expired, foreign or malformed claim is skipped by exactly the same rule as the
 * global ceiling. Soroban remains authoritative; nothing here invents balances.
 *
 * Two rules shape every decision below:
 *
 *  - **Fail closed.** A cap that cannot be resolved — malformed config, a
 *    malformed category, a claim snapshot that could not be read — refuses the
 *    publish. It never degrades to "unlimited".
 *  - **Equality is allowed.** A market may be created while a category sits at
 *    its ceiling, matching `checkCreatorExposureCap` and `decideMode`.
 */

import {
  exposureSkipReason,
  exposureUsdcForClaim,
  isFiniteNonNegative,
  type CategoryExposureClaim,
  type ExposureSkipReason,
} from "./exposure-caps";

/** Cap on one creator's simultaneously-open markets inside one category. */
export interface CategoryCap {
  /** Bounded market count. Positive integer; the count cap cannot be disabled. */
  maxMarkets: number;
  /** Bounded open creator exposure, display USDC. `0` allows no notional. */
  maxExposureUsdc: number;
}

/**
 * A resolved per-category cap policy.
 *
 * `defaultCap` applies to any category without an explicit entry, so a new
 * category ships with a boundary instead of none. `invalid` is set when the
 * configuration could not be parsed; every category then resolves to a refusal,
 * which is the fail-closed direction.
 */
export interface CategoryCapPolicy {
  perCategory: Record<string, CategoryCap>;
  defaultCap: CategoryCap;
  /** Set when env configuration was malformed; present means "refuse all". */
  invalid?: string;
}

/** Default open-market count per category when none is configured. */
export const DEFAULT_CATEGORY_MAX_MARKETS = 5;
/** Default notional ceiling per category when none is configured, display USDC. */
export const DEFAULT_CATEGORY_MAX_EXPOSURE_USDC = 100;

export const CATEGORY_CAPS_ENV_KEY = "MARKET_CREATOR_CATEGORY_CAPS";
export const CATEGORY_MAX_MARKETS_ENV_KEY = "MARKET_CREATOR_MAX_PER_CATEGORY_MARKETS";
export const CATEGORY_MAX_EXPOSURE_ENV_KEY = "MARKET_CREATOR_MAX_PER_CATEGORY_EXPOSURE_USDC";

/**
 * Normalise a category id for comparison.
 *
 * Returns null for anything that is not a non-empty string after trimming, so a
 * missing or malformed category is distinguishable from a real one.
 */
export function normalizeCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return id.length === 0 ? null : id;
}

function readNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return raw.trim() === "" ? fallback : Number(raw);
  return Number.NaN;
}

function parseCap(
  category: string,
  value: unknown,
): { ok: true; cap: CategoryCap } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: `cap for "${category}" must be an object { maxMarkets, maxExposureUsdc }`,
    };
  }
  const raw = value as Record<string, unknown>;
  const maxMarkets = readNumber(raw.maxMarkets, Number.NaN);
  const maxExposureUsdc = readNumber(raw.maxExposureUsdc, Number.NaN);

  if (!Number.isInteger(maxMarkets) || maxMarkets < 1) {
    return {
      ok: false,
      error: `cap for "${category}": maxMarkets must be a positive integer (got ${String(raw.maxMarkets)})`,
    };
  }
  if (!isFiniteNonNegative(maxExposureUsdc)) {
    return {
      ok: false,
      error: `cap for "${category}": maxExposureUsdc must be a finite number ≥ 0 (got ${String(raw.maxExposureUsdc)})`,
    };
  }
  return { ok: true, cap: { maxMarkets, maxExposureUsdc } };
}

/**
 * Validate the per-category cap configuration.
 *
 * Rejects negative, zero, NaN and absent values where the schema requires them —
 * a silent fallback to "no cap" is the exact failure this policy exists to
 * prevent. `maxMarkets` must be a positive integer (zero would be a disable,
 * which is the kill switch's job); `maxExposureUsdc` must be finite and ≥ 0,
 * matching `parseExposureCapPolicy`.
 */
export function parseCategoryCapPolicy(
  input: Record<string, unknown>,
  opts: { defaultMaxExposureUsdc?: number } = {},
): { ok: true; policy: CategoryCapPolicy } | { ok: false; error: string } {
  const rawDefaultMarkets = input[CATEGORY_MAX_MARKETS_ENV_KEY];
  const defaultMaxMarkets = readNumber(rawDefaultMarkets, DEFAULT_CATEGORY_MAX_MARKETS);
  if (!Number.isInteger(defaultMaxMarkets) || defaultMaxMarkets < 1) {
    return {
      ok: false,
      error: `${CATEGORY_MAX_MARKETS_ENV_KEY} must be a positive integer (got ${String(rawDefaultMarkets)})`,
    };
  }

  const rawDefaultExposure =
    opts.defaultMaxExposureUsdc !== undefined
      ? opts.defaultMaxExposureUsdc
      : readNumber(input[CATEGORY_MAX_EXPOSURE_ENV_KEY], DEFAULT_CATEGORY_MAX_EXPOSURE_USDC);
  if (!isFiniteNonNegative(rawDefaultExposure)) {
    return {
      ok: false,
      error: `${CATEGORY_MAX_EXPOSURE_ENV_KEY} must be a finite number ≥ 0 (got ${String(rawDefaultExposure)})`,
    };
  }

  const perCategory: Record<string, CategoryCap> = {};
  const rawCaps = input[CATEGORY_CAPS_ENV_KEY];
  const hasCaps =
    rawCaps !== undefined &&
    rawCaps !== null &&
    !(typeof rawCaps === "string" && rawCaps.trim() === "");

  if (hasCaps) {
    let parsed: unknown = rawCaps;
    if (typeof rawCaps === "string") {
      try {
        parsed = JSON.parse(rawCaps);
      } catch {
        return { ok: false, error: `${CATEGORY_CAPS_ENV_KEY} must be valid JSON` };
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `${CATEGORY_CAPS_ENV_KEY} must be a JSON object of { category: { maxMarkets, maxExposureUsdc } }`,
      };
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const category = normalizeCategory(key);
      if (!category) {
        return { ok: false, error: `${CATEGORY_CAPS_ENV_KEY} has a blank category key` };
      }
      const cap = parseCap(category, value);
      if (!cap.ok) return { ok: false, error: cap.error };
      perCategory[category] = cap.cap;
    }
  }

  return {
    ok: true,
    policy: {
      perCategory,
      defaultCap: { maxMarkets: defaultMaxMarkets, maxExposureUsdc: rawDefaultExposure },
    },
  };
}

/**
 * A policy that refuses every category.
 *
 * Used when configuration could not be parsed: the safe response to "the caps
 * are unusable" is to publish nothing, not to publish unbounded.
 */
export function unresolvedCategoryCapPolicy(error: string): CategoryCapPolicy {
  return {
    perCategory: {},
    defaultCap: { maxMarkets: 0, maxExposureUsdc: 0 },
    invalid: error,
  };
}

/** True when the policy could not be parsed and therefore refuses every category. */
export function isCategoryCapPolicyInvalid(policy: CategoryCapPolicy): boolean {
  return policy.invalid !== undefined;
}

/** One compact line describing the policy, for worker startup logs. */
export function describeCategoryCapPolicy(policy: CategoryCapPolicy): string {
  if (policy.invalid !== undefined) return `unresolved (${policy.invalid})`;
  const base = `default ${policy.defaultCap.maxMarkets} markets / ${policy.defaultCap.maxExposureUsdc} USDC`;
  const overrides = Object.entries(policy.perCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, cap]) => `${id} ${cap.maxMarkets} markets / ${cap.maxExposureUsdc} USDC`);
  return overrides.length === 0 ? base : `${base}; ${overrides.join("; ")}`;
}

// ── Resolving the effective cap ───────────────────────────────────────────────

export type CategoryCapResolution =
  | {
      ok: true;
      category: string;
      cap: CategoryCap;
      /** Whether the cap came from config or the default. */
      source: "configured" | "default";
    }
  | { ok: false; reason: "invalid_category" | "invalid_policy"; detail: string };

/** The cap that actually applies to a category, or why none can be resolved. */
export function resolveCategoryCap(
  policy: CategoryCapPolicy,
  category: unknown,
): CategoryCapResolution {
  if (policy.invalid !== undefined) {
    return { ok: false, reason: "invalid_policy", detail: policy.invalid };
  }
  const id = normalizeCategory(category);
  if (!id) {
    return {
      ok: false,
      reason: "invalid_category",
      detail: "category must be a non-empty string",
    };
  }
  const configured = policy.perCategory[id];
  if (configured) return { ok: true, category: id, cap: configured, source: "configured" };
  return { ok: true, category: id, cap: policy.defaultCap, source: "default" };
}

// ── Per-category accounting (reuses the exposure definition) ──────────────────

export interface CategoryExposureBucket {
  openMarkets: number;
  openExposureUsdc: number;
  claimIds: number[];
}

export interface CategoryExposureSummary {
  /** Normalised category → open inventory for one creator. */
  byCategory: Record<string, CategoryExposureBucket>;
  /**
   * Live creator claims whose category could not be resolved. They still count
   * toward the global exposure ceiling; they just cannot be attributed to a
   * per-category bucket, so a caller that sees them should say so.
   */
  unclassifiedClaimIds: number[];
  skipped: Array<{ id: number; reason: ExposureSkipReason }>;
}

/**
 * Sum one creator's live inventory per category.
 *
 * Uses the exact skip rules from `exposure-caps.ts`: cancelled / resolved /
 * expired / other-creator / malformed-stake rows are skipped, and duplicate ids
 * (retried reads) are counted once.
 */
export function sumCreatorOpenExposureByCategory(args: {
  claims: readonly CategoryExposureClaim[];
  creatorAddress: string;
  nowSeconds: number;
}): CategoryExposureSummary {
  const seen = new Set<number>();
  const byCategory: Record<string, CategoryExposureBucket> = {};
  const unclassifiedClaimIds: number[] = [];
  const skipped: Array<{ id: number; reason: ExposureSkipReason }> = [];

  for (const claim of args.claims) {
    const reason = exposureSkipReason(claim, args.creatorAddress, args.nowSeconds, seen);
    if (reason) {
      skipped.push({ id: claim.id, reason });
      continue;
    }
    seen.add(claim.id);

    const category = normalizeCategory(claim.category);
    if (!category) {
      unclassifiedClaimIds.push(claim.id);
      continue;
    }

    const bucket =
      byCategory[category] ?? { openMarkets: 0, openExposureUsdc: 0, claimIds: [] };
    bucket.openMarkets += 1;
    bucket.openExposureUsdc += exposureUsdcForClaim(claim);
    bucket.claimIds.push(claim.id);
    byCategory[category] = bucket;
  }

  return { byCategory, unclassifiedClaimIds, skipped };
}

/**
 * Credit one published market to a category bucket.
 *
 * Called optimistically inside a run so the next candidate in the same category
 * sees the market the previous iteration just opened, without another full claim
 * walk. A malformed category changes nothing and returns null.
 */
export function bumpCategoryUsage(
  byCategory: Record<string, CategoryExposureBucket>,
  category: unknown,
  stakeUsdc: number,
): string | null {
  const id = normalizeCategory(category);
  if (!id) return null;
  const bucket = byCategory[id] ?? { openMarkets: 0, openExposureUsdc: 0, claimIds: [] };
  bucket.openMarkets += 1;
  bucket.openExposureUsdc += isFiniteNonNegative(stakeUsdc) ? stakeUsdc : 0;
  byCategory[id] = bucket;
  return id;
}

// ── Dependency-failure gate ───────────────────────────────────────────────────

export type CapSourceUnavailableReason = "cap_source_unavailable";

export interface CreatorCapSnapshot {
  /** False when the Soroban claim walk failed; no cap can be resolved from it. */
  available: boolean;
  claims: readonly CategoryExposureClaim[];
  creatorAddress: string;
  nowSeconds: number;
}

export interface CreatorCapSummary extends CategoryExposureSummary {
  /** False when the run must not publish because the snapshot is unusable. */
  publishable: boolean;
  reason?: CapSourceUnavailableReason;
}

/**
 * Turn a claim snapshot into the per-category inventory a run needs, or refuse.
 *
 * A failed claim read must never be read as "no open markets": that silently
 * disables every cap the worker enforces. The dependency failing is a reason to
 * skip the run, not a reason to publish without a check.
 */
export function summariseCreatorCaps(snapshot: CreatorCapSnapshot): CreatorCapSummary {
  if (!snapshot.available) {
    return {
      publishable: false,
      reason: "cap_source_unavailable",
      byCategory: {},
      unclassifiedClaimIds: [],
      skipped: [],
    };
  }
  return { publishable: true, ...sumCreatorOpenExposureByCategory(snapshot) };
}

// ── Enforcement ───────────────────────────────────────────────────────────────

export type CategoryCapBlockReason =
  | "cap_exceeded"
  | "category_disabled"
  | "invalid_category"
  | "invalid_policy"
  | "invalid_state"
  | "invalid_stake";

export interface CategoryCapDecision {
  allowed: boolean;
  category?: string;
  reason?: CategoryCapBlockReason;
  /** Which half of the cap refused, when a cap is what refused it. */
  limitedBy?: "markets" | "exposure";
  /** The effective cap that applied. */
  cap?: CategoryCap;
  openMarkets: number;
  openExposureUsdc: number;
  nextMarkets: number;
  nextExposureUsdc: number;
  marketsRemaining: number;
  exposureRemainingUsdc: number;
  /** One line for logs / proposal records. */
  blockedBy?: string;
}

/**
 * Would publishing one more market stay inside the category's cap?
 *
 * Refuses on any unresolved input (fail closed) rather than assuming a zero
 * baseline. `categoryEnabled` lets an operational kill switch
 * (`lib/ops/flags.ts`) refuse the category without pretending a cap was hit;
 * it defaults to enabled so older callers keep their behaviour.
 */
export function checkCategoryCreatorCap(args: {
  category: unknown;
  policy: CategoryCapPolicy;
  openMarkets: number;
  openExposureUsdc: number;
  stakeUsdc: number;
  categoryEnabled?: boolean;
}): CategoryCapDecision {
  const unresolved: Omit<CategoryCapDecision, "allowed" | "reason" | "blockedBy"> = {
    openMarkets: Number.NaN,
    openExposureUsdc: Number.NaN,
    nextMarkets: Number.NaN,
    nextExposureUsdc: Number.NaN,
    marketsRemaining: 0,
    exposureRemainingUsdc: 0,
  };

  const resolution = resolveCategoryCap(args.policy, args.category);
  if (!resolution.ok) {
    return {
      ...unresolved,
      allowed: false,
      reason: resolution.reason,
      blockedBy: resolution.detail,
    };
  }
  const { category, cap } = resolution;

  if (!Number.isInteger(args.openMarkets) || args.openMarkets < 0) {
    return {
      ...unresolved,
      category,
      cap,
      allowed: false,
      reason: "invalid_state",
      blockedBy: `invalid openMarkets ${String(args.openMarkets)}`,
    };
  }
  if (!isFiniteNonNegative(args.openExposureUsdc)) {
    return {
      ...unresolved,
      category,
      cap,
      allowed: false,
      reason: "invalid_state",
      blockedBy: `invalid openExposureUsdc ${String(args.openExposureUsdc)}`,
    };
  }
  if (!isFiniteNonNegative(args.stakeUsdc) || args.stakeUsdc === 0) {
    return {
      ...unresolved,
      category,
      cap,
      allowed: false,
      reason: "invalid_stake",
      blockedBy: `stakeUsdc must be a positive finite number (got ${String(args.stakeUsdc)})`,
    };
  }

  const nextMarkets = args.openMarkets + 1;
  const nextExposureUsdc = args.openExposureUsdc + args.stakeUsdc;
  const decision: CategoryCapDecision = {
    category,
    cap,
    allowed: true,
    openMarkets: args.openMarkets,
    openExposureUsdc: args.openExposureUsdc,
    nextMarkets,
    nextExposureUsdc,
    marketsRemaining: Math.max(0, cap.maxMarkets - args.openMarkets),
    exposureRemainingUsdc: Math.max(0, cap.maxExposureUsdc - args.openExposureUsdc),
  };

  if (args.categoryEnabled === false) {
    return {
      ...decision,
      allowed: false,
      reason: "category_disabled",
      blockedBy: `category ${category} is disabled by an operational switch`,
    };
  }
  if (nextMarkets > cap.maxMarkets) {
    return {
      ...decision,
      allowed: false,
      reason: "cap_exceeded",
      limitedBy: "markets",
      blockedBy: `category ${category} already has ${args.openMarkets} open markets (cap ${cap.maxMarkets})`,
    };
  }
  if (nextExposureUsdc > cap.maxExposureUsdc) {
    return {
      ...decision,
      allowed: false,
      reason: "cap_exceeded",
      limitedBy: "exposure",
      blockedBy: `category ${category} exposure ${nextExposureUsdc} > cap ${cap.maxExposureUsdc}`,
    };
  }
  return decision;
}
