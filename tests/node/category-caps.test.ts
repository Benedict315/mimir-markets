import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORY_CAPS_ENV_KEY,
  DEFAULT_CATEGORY_MAX_MARKETS,
  bumpCategoryUsage,
  checkCategoryCreatorCap,
  describeCategoryCapPolicy,
  isCategoryCapPolicyInvalid,
  normalizeCategory,
  parseCategoryCapPolicy,
  resolveCategoryCap,
  summariseCreatorCaps,
  sumCreatorOpenExposureByCategory,
  unresolvedCategoryCapPolicy,
  type CategoryCapPolicy,
  type CategoryExposureBucket,
} from "../../lib/market-creator/category-caps";
import {
  sumCreatorOpenExposure,
  type CategoryExposureClaim,
} from "../../lib/market-creator/exposure-caps";

const NOW = 1_800_000_000;
const CREATOR = "GCREATORADDRESSEXAMPLE0000000000000000000000000000000";
const OTHER = "GOTHERADDRESSEXAMPLE000000000000000000000000000000000";

function claim(overrides: Partial<CategoryExposureClaim> = {}): CategoryExposureClaim {
  return {
    id: 1,
    creator: CREATOR,
    state: "open",
    deadline: NOW + 3600,
    creatorStakeUsdc: 10,
    reservedCreatorLiabilityUsdc: 0,
    category: "crypto",
    ...overrides,
  };
}

function policy(overrides: Partial<CategoryCapPolicy> = {}): CategoryCapPolicy {
  return {
    perCategory: {},
    defaultCap: { maxMarkets: 5, maxExposureUsdc: 100 },
    ...overrides,
  };
}

// ── Config validation ─────────────────────────────────────────────────────────

test("defaults: 5 markets and 100 USDC per category", () => {
  const parsed = parseCategoryCapPolicy({});
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.policy.defaultCap.maxMarkets, DEFAULT_CATEGORY_MAX_MARKETS);
    assert.equal(parsed.policy.defaultCap.maxExposureUsdc, 100);
    assert.deepEqual(parsed.policy.perCategory, {});
  }
});

test("the default count and notional caps are configurable", () => {
  const parsed = parseCategoryCapPolicy({
    MARKET_CREATOR_MAX_PER_CATEGORY_MARKETS: "8",
    MARKET_CREATOR_MAX_PER_CATEGORY_EXPOSURE_USDC: "250",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.policy.defaultCap, { maxMarkets: 8, maxExposureUsdc: 250 });
  }
});

test("the caller may supply the global exposure ceiling as the default notional cap", () => {
  const parsed = parseCategoryCapPolicy({}, { defaultMaxExposureUsdc: 40 });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.policy.defaultCap.maxExposureUsdc, 40);
});

test("per-category overrides are parsed and normalised", () => {
  const parsed = parseCategoryCapPolicy({
    [CATEGORY_CAPS_ENV_KEY]: JSON.stringify({
      Crypto: { maxMarkets: 3, maxExposureUsdc: 40 },
      sports: { maxMarkets: 1, maxExposureUsdc: 0 },
    }),
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.policy.perCategory.crypto, { maxMarkets: 3, maxExposureUsdc: 40 });
    assert.deepEqual(parsed.policy.perCategory.sports, { maxMarkets: 1, maxExposureUsdc: 0 });
  }
});

test("an empty or blank JSON string means no overrides, not an error", () => {
  for (const raw of ["", "   "]) {
    const parsed = parseCategoryCapPolicy({ [CATEGORY_CAPS_ENV_KEY]: raw });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.policy.perCategory, {});
  }
});

test("malformed JSON is rejected", () => {
  const parsed = parseCategoryCapPolicy({ [CATEGORY_CAPS_ENV_KEY]: "{not json" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /valid JSON/);
});

test("a non-object JSON document is rejected", () => {
  for (const raw of ["[1,2]", '"crypto"', "42"]) {
    assert.equal(parseCategoryCapPolicy({ [CATEGORY_CAPS_ENV_KEY]: raw }).ok, false);
  }
  assert.equal(parseCategoryCapPolicy({ [CATEGORY_CAPS_ENV_KEY]: [] }).ok, false);
});

test("a blank category key is rejected", () => {
  const parsed = parseCategoryCapPolicy({
    [CATEGORY_CAPS_ENV_KEY]: JSON.stringify({ "   ": { maxMarkets: 1, maxExposureUsdc: 1 } }),
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /blank category key/);
});

test("negative, zero, NaN and absent values are rejected", () => {
  const cases: Array<Record<string, unknown>> = [
    { crypto: { maxMarkets: 0, maxExposureUsdc: 10 } },
    { crypto: { maxMarkets: -1, maxExposureUsdc: 10 } },
    { crypto: { maxMarkets: 1.5, maxExposureUsdc: 10 } },
    { crypto: { maxMarkets: "nope", maxExposureUsdc: 10 } },
    { crypto: { maxExposureUsdc: 10 } },
    { crypto: { maxMarkets: 1, maxExposureUsdc: -1 } },
    { crypto: { maxMarkets: 1, maxExposureUsdc: Number.NaN } },
    { crypto: { maxMarkets: 1 } },
    { crypto: "not-an-object" },
  ];
  for (const caps of cases) {
    const parsed = parseCategoryCapPolicy({ [CATEGORY_CAPS_ENV_KEY]: JSON.stringify(caps) });
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(caps)} to be rejected`);
  }
});

test("a malformed default notional cap is rejected", () => {
  assert.equal(parseCategoryCapPolicy({}, { defaultMaxExposureUsdc: Number.NaN }).ok, false);
  assert.equal(parseCategoryCapPolicy({}, { defaultMaxExposureUsdc: -1 }).ok, false);
});

test("narrow parse leaves an unresolved policy that fails closed", () => {
  const invalid = unresolvedCategoryCapPolicy("bad config");
  assert.equal(isCategoryCapPolicyInvalid(invalid), true);
  const resolution = resolveCategoryCap(invalid, "crypto");
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.equal(resolution.reason, "invalid_policy");
});

// ── Resolving the effective cap ───────────────────────────────────────────────

test("an explicit category cap wins over the default", () => {
  const caps = policy({ perCategory: { crypto: { maxMarkets: 2, maxExposureUsdc: 30 } } });
  const resolution = resolveCategoryCap(caps, "Crypto ");
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.category, "crypto");
    assert.equal(resolution.source, "configured");
    assert.deepEqual(resolution.cap, { maxMarkets: 2, maxExposureUsdc: 30 });
  }
});

test("an unlisted category falls back to the default cap", () => {
  const resolution = resolveCategoryCap(policy(), "weather");
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.source, "default");
    assert.deepEqual(resolution.cap, { maxMarkets: 5, maxExposureUsdc: 100 });
  }
});

test("a malformed category cannot resolve a cap", () => {
  for (const bad of ["", "   ", undefined, null, 42]) {
    const resolution = resolveCategoryCap(policy(), bad);
    assert.equal(resolution.ok, false, `expected ${String(bad)} to be refused`);
    if (!resolution.ok) assert.equal(resolution.reason, "invalid_category");
  }
});

test("normalizeCategory folds case and whitespace but rejects blanks", () => {
  assert.equal(normalizeCategory("  Crypto "), "crypto");
  assert.equal(normalizeCategory(""), null);
  assert.equal(normalizeCategory(undefined), null);
});

// ── Per-category accounting ───────────────────────────────────────────────────

test("live creator claims are bucketed by category", () => {
  const summary = sumCreatorOpenExposureByCategory({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 1, category: "crypto", creatorStakeUsdc: 10 }),
      claim({ id: 2, category: "Crypto", creatorStakeUsdc: 4, reservedCreatorLiabilityUsdc: 1 }),
      claim({ id: 3, category: "sports", creatorStakeUsdc: 7 }),
    ],
  });
  assert.equal(summary.byCategory.crypto.openMarkets, 2);
  assert.equal(summary.byCategory.crypto.openExposureUsdc, 15);
  assert.deepEqual(summary.byCategory.crypto.claimIds, [1, 2]);
  assert.equal(summary.byCategory.sports.openMarkets, 1);
  assert.equal(summary.byCategory.sports.openExposureUsdc, 7);
});

test("foreign, resolved, cancelled and expired claims are skipped", () => {
  const summary = sumCreatorOpenExposureByCategory({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 1, category: "crypto", creatorStakeUsdc: 10 }),
      claim({ id: 2, creator: OTHER, category: "crypto", creatorStakeUsdc: 99 }),
      claim({ id: 3, state: "resolved", category: "crypto", creatorStakeUsdc: 99 }),
      claim({ id: 4, state: "cancelled", category: "crypto", creatorStakeUsdc: 99 }),
      claim({ id: 5, deadline: NOW, category: "crypto", creatorStakeUsdc: 99 }),
    ],
  });
  assert.deepEqual(summary.byCategory.crypto.claimIds, [1]);
  assert.equal(summary.byCategory.crypto.openExposureUsdc, 10);
  assert.equal(summary.skipped.length, 4);
});

test("malformed stakes are skipped rather than inflating a bucket", () => {
  const summary = sumCreatorOpenExposureByCategory({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 1, category: "crypto", creatorStakeUsdc: 10 }),
      claim({ id: 2, category: "crypto", creatorStakeUsdc: Number.NaN }),
      claim({ id: 3, category: "crypto", creatorStakeUsdc: -5 }),
      claim({
        id: 4,
        category: "crypto",
        creatorStakeUsdc: 1,
        reservedCreatorLiabilityUsdc: Number.NaN,
      }),
    ],
  });
  assert.deepEqual(summary.byCategory.crypto.claimIds, [1]);
  assert.equal(summary.byCategory.crypto.openExposureUsdc, 10);
});

test("duplicate claim ids are counted once", () => {
  const summary = sumCreatorOpenExposureByCategory({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 7, category: "crypto", creatorStakeUsdc: 10 }),
      claim({ id: 7, category: "crypto", creatorStakeUsdc: 10 }),
    ],
  });
  assert.equal(summary.byCategory.crypto.openMarkets, 1);
  assert.equal(summary.byCategory.crypto.openExposureUsdc, 10);
  assert.equal(summary.skipped.some((s) => s.reason === "duplicate"), true);
});

test("a live claim with no usable category is reported, not silently dropped", () => {
  const summary = sumCreatorOpenExposureByCategory({
    creatorAddress: CREATOR,
    nowSeconds: NOW,
    claims: [
      claim({ id: 1, category: "crypto", creatorStakeUsdc: 10 }),
      claim({ id: 2, category: "   ", creatorStakeUsdc: 3 }),
    ],
  });
  assert.deepEqual(summary.unclassifiedClaimIds, [2]);
  assert.equal(summary.byCategory.crypto.openMarkets, 1);
});

test("regression: per-category buckets add up to the global exposure sum", () => {
  // The two modules must agree on what "open" means; if they drift, a creator
  // could satisfy one cap while breaching the other.
  const claims = [
    claim({ id: 1, category: "crypto", creatorStakeUsdc: 10 }),
    claim({ id: 2, category: "sports", creatorStakeUsdc: 4, reservedCreatorLiabilityUsdc: 1 }),
    claim({ id: 3, category: "sports", creatorStakeUsdc: 2 }),
    claim({ id: 4, state: "cancelled", category: "sports", creatorStakeUsdc: 99 }),
  ];
  const perCategory = sumCreatorOpenExposureByCategory({
    claims,
    creatorAddress: CREATOR,
    nowSeconds: NOW,
  });
  const global = sumCreatorOpenExposure({ claims, creatorAddress: CREATOR, nowSeconds: NOW });
  const bucketed = Object.values(perCategory.byCategory).reduce(
    (sum, bucket) => sum + bucket.openExposureUsdc,
    0,
  );
  assert.equal(bucketed, global.openExposureUsdc);
  assert.equal(
    Object.values(perCategory.byCategory).reduce((sum, bucket) => sum + bucket.openMarkets, 0),
    global.countedClaimIds.length,
  );
});

test("an empty snapshot has no buckets and no skips", () => {
  const summary = sumCreatorOpenExposureByCategory({
    claims: [],
    creatorAddress: CREATOR,
    nowSeconds: NOW,
  });
  assert.deepEqual(summary.byCategory, {});
  assert.deepEqual(summary.skipped, []);
});

// ── Dependency failure is fail-closed ─────────────────────────────────────────

test("an unavailable cap source is not readable as 'no open markets'", () => {
  const summary = summariseCreatorCaps({
    available: false,
    claims: [],
    creatorAddress: CREATOR,
    nowSeconds: NOW,
  });
  assert.equal(summary.publishable, false);
  assert.equal(summary.reason, "cap_source_unavailable");
  assert.deepEqual(summary.byCategory, {});
});

test("an available snapshot summarises the inventory", () => {
  const summary = summariseCreatorCaps({
    available: true,
    claims: [claim({ id: 1, category: "weather", creatorStakeUsdc: 2 })],
    creatorAddress: CREATOR,
    nowSeconds: NOW,
  });
  assert.equal(summary.publishable, true);
  assert.equal(summary.byCategory.weather.openMarkets, 1);
});

// ── Enforcement ───────────────────────────────────────────────────────────────

test("positive: a market that fits the category cap is allowed", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy(),
    openMarkets: 2,
    openExposureUsdc: 20,
    stakeUsdc: 5,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextMarkets, 3);
  assert.equal(decision.nextExposureUsdc, 25);
  assert.equal(decision.marketsRemaining, 3);
  assert.equal(decision.exposureRemainingUsdc, 80);
});

test("negative: an over-cap market count is refused", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy({ defaultCap: { maxMarkets: 3, maxExposureUsdc: 100 } }),
    openMarkets: 3,
    openExposureUsdc: 6,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cap_exceeded");
  assert.equal(decision.limitedBy, "markets");
  assert.match(decision.blockedBy ?? "", /already has 3 open markets \(cap 3\)/);
});

test("negative: an over-cap notional market is refused", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy({ defaultCap: { maxMarkets: 5, maxExposureUsdc: 10 } }),
    openMarkets: 1,
    openExposureUsdc: 9,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "cap_exceeded");
  assert.equal(decision.limitedBy, "exposure");
  assert.match(decision.blockedBy ?? "", /exposure 11 > cap 10/);
});

test("boundary: filling the category to exactly its market cap is allowed", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy({ defaultCap: { maxMarkets: 3, maxExposureUsdc: 100 } }),
    openMarkets: 2,
    openExposureUsdc: 4,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextMarkets, 3);
});

test("boundary: exposure exactly at the cap is allowed, matching the global ceiling", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy({ defaultCap: { maxMarkets: 5, maxExposureUsdc: 10 } }),
    openMarkets: 1,
    openExposureUsdc: 8,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextExposureUsdc, 10);
});

test("an explicit override is enforced for its own category only", () => {
  const caps = policy({ perCategory: { crypto: { maxMarkets: 1, maxExposureUsdc: 5 } } });
  const over = checkCategoryCreatorCap({
    category: "crypto",
    policy: caps,
    openMarkets: 1,
    openExposureUsdc: 0,
    stakeUsdc: 2,
  });
  const other = checkCategoryCreatorCap({
    category: "weather",
    policy: caps,
    openMarkets: 1,
    openExposureUsdc: 0,
    stakeUsdc: 2,
  });
  assert.equal(over.allowed, false);
  assert.equal(other.allowed, true);
});

test("failure: a malformed category is refused", () => {
  const decision = checkCategoryCreatorCap({
    category: "  ",
    policy: policy(),
    openMarkets: 0,
    openExposureUsdc: 0,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "invalid_category");
});

test("failure: an unresolved policy refuses every category", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: unresolvedCategoryCapPolicy("bad config"),
    openMarkets: 0,
    openExposureUsdc: 0,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "invalid_policy");
});

test("failure: zero / non-finite stakes and malformed inventory are refused", () => {
  const base = { category: "crypto", policy: policy(), openMarkets: 0, openExposureUsdc: 0 };
  assert.equal(checkCategoryCreatorCap({ ...base, stakeUsdc: 0 }).reason, "invalid_stake");
  assert.equal(checkCategoryCreatorCap({ ...base, stakeUsdc: Number.NaN }).reason, "invalid_stake");
  assert.equal(
    checkCategoryCreatorCap({ ...base, openMarkets: Number.NaN, stakeUsdc: 2 }).reason,
    "invalid_state",
  );
  assert.equal(
    checkCategoryCreatorCap({ ...base, openMarkets: -1, stakeUsdc: 2 }).reason,
    "invalid_state",
  );
  assert.equal(
    checkCategoryCreatorCap({ ...base, openExposureUsdc: Number.NaN, stakeUsdc: 2 }).reason,
    "invalid_state",
  );
});

test("paused/cancelled: a disabled category is refused before the cap is consulted", () => {
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: policy({ defaultCap: { maxMarkets: 0, maxExposureUsdc: 0 } }),
    openMarkets: 0,
    openExposureUsdc: 0,
    stakeUsdc: 2,
    categoryEnabled: false,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "category_disabled");
  assert.match(decision.blockedBy ?? "", /disabled by an operational switch/);
});

// ── Optimistic in-run accounting ──────────────────────────────────────────────

test("bumpCategoryUsage credits a published market to its category", () => {
  const byCategory: Record<string, CategoryExposureBucket> = {};
  assert.equal(bumpCategoryUsage(byCategory, "Crypto", 2), "crypto");
  assert.equal(byCategory.crypto.openMarkets, 1);
  assert.equal(byCategory.crypto.openExposureUsdc, 2);
  assert.equal(bumpCategoryUsage(byCategory, "crypto", 3), "crypto");
  assert.equal(byCategory.crypto.openMarkets, 2);
  assert.equal(byCategory.crypto.openExposureUsdc, 5);
});

test("bumpCategoryUsage ignores a malformed category or stake", () => {
  const byCategory: Record<string, CategoryExposureBucket> = {};
  assert.equal(bumpCategoryUsage(byCategory, "  ", 2), null);
  bumpCategoryUsage(byCategory, "crypto", Number.NaN);
  assert.equal(byCategory.crypto.openExposureUsdc, 0);
});

test("an optimistic bump can push a category over its cap on the next check", () => {
  const caps = policy({ defaultCap: { maxMarkets: 1, maxExposureUsdc: 100 } });
  const byCategory: Record<string, CategoryExposureBucket> = {};
  bumpCategoryUsage(byCategory, "crypto", 2);
  const decision = checkCategoryCreatorCap({
    category: "crypto",
    policy: caps,
    openMarkets: byCategory.crypto.openMarkets,
    openExposureUsdc: byCategory.crypto.openExposureUsdc,
    stakeUsdc: 2,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.limitedBy, "markets");
});

// ── Operator-facing description ───────────────────────────────────────────────

test("describeCategoryCapPolicy names the default and the overrides", () => {
  assert.match(describeCategoryCapPolicy(policy()), /default 5 markets \/ 100 USDC/);
  const described = describeCategoryCapPolicy(
    policy({
      perCategory: {
        sports: { maxMarkets: 2, maxExposureUsdc: 20 },
        crypto: { maxMarkets: 3, maxExposureUsdc: 40 },
      },
    }),
  );
  assert.match(described, /crypto 3 markets \/ 40 USDC; sports 2 markets \/ 20 USDC/);
});

test("describeCategoryCapPolicy surfaces an unresolved policy", () => {
  assert.match(describeCategoryCapPolicy(unresolvedCategoryCapPolicy("bad config")), /unresolved/);
});
