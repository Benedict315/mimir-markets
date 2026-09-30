import { CHALLENGE_OPPORTUNITY_SOURCES } from "@/lib/challengeOpportunitySources";
import { getSeedChallengeOpportunities } from "@/lib/challengeOpportunitySeeds";
import { computeClaimQuality } from "@/lib/claimQuality";
import type {
  ChallengeOpportunitiesResponse,
  ChallengeOpportunity,
  SourceClaimDraftCandidate,
} from "@/lib/claimDrafts";
import { normalizeResolutionSource } from "@/lib/constants";
import { getActiveChallengeOpportunities, pruneExpiredChallengeOpportunities, replaceChallengeOpportunities } from "@/lib/db";
import type { VSData } from "@/lib/contract";

import { generateClaimDrafts } from "./source-claim-generator";
import { getVsFeed } from "./vs-index";

const OPPORTUNITY_TTL_MS = 24 * 60 * 60 * 1000;
const EXISTING_CLAIMS_TIMEOUT_MS = 5000;

function normalizeComparableText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getCandidateScore(candidate: SourceClaimDraftCandidate) {
  const quality = computeClaimQuality({
    question: candidate.claimText,
    creator_position: candidate.sideA,
    opponent_position: candidate.sideB,
    resolution_url: candidate.primaryResolutionSource,
    settlement_rule: candidate.settlementRule,
    category: candidate.category,
    deadline: Math.floor(Date.parse(candidate.deadlineAt) / 1000),
  });

  return {
    qualityScore: quality.score,
    qualityTier: quality.tier,
    combinedScore: quality.score + Math.round(candidate.confidenceScore / 5),
  };
}

async function getExistingClaimsSnapshot() {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<VSData[]>((resolve) => {
    timeoutId = setTimeout(() => resolve([]), EXISTING_CLAIMS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([getVsFeed(), timeoutPromise]);
  } catch {
    return [] as VSData[];
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function pickBestCandidate(candidates: SourceClaimDraftCandidate[]) {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((a, b) => {
    const aScore = getCandidateScore(a);
    const bScore = getCandidateScore(b);
    if (bScore.combinedScore !== aScore.combinedScore) {
      return bScore.combinedScore - aScore.combinedScore;
    }
    return b.confidenceScore - a.confidenceScore;
  })[0]!;
}

export function findExistingOpportunityClaim(
  candidate: SourceClaimDraftCandidate,
  claims: VSData[]
) {
  const normalizedSource = normalizeResolutionSource(candidate.primaryResolutionSource);
  const normalizedQuestion = normalizeComparableText(candidate.claimText);
  const normalizedSideA = normalizeComparableText(candidate.sideA);
  const normalizedSideB = normalizeComparableText(candidate.sideB);

  return claims
    .filter((claim) => claim.state === "open" || claim.state === "accepted")
    .find((claim) => {
      if (normalizeResolutionSource(claim.resolution_url) !== normalizedSource) {
        return false;
      }

      if (normalizeComparableText(claim.question) === normalizedQuestion) {
        return true;
      }

      return (
        normalizeComparableText(claim.creator_position) === normalizedSideA &&
        normalizeComparableText(claim.opponent_position) === normalizedSideB
      );
    });
}

function dedupeOpportunities(opportunities: ChallengeOpportunity[]) {
  const seen = new Set<string>();
  const unique: ChallengeOpportunity[] = [];

  for (const opportunity of opportunities) {
    const key = [
      normalizeResolutionSource(opportunity.sourceUrl),
      normalizeComparableText(opportunity.candidate.claimText),
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(opportunity);
  }

  return unique;
}

function getOpportunityExpiresAt(candidate: SourceClaimDraftCandidate, generatedAt: number) {
  const deadlineAt = Date.parse(candidate.deadlineAt);
  if (!Number.isFinite(deadlineAt)) {
    return generatedAt + OPPORTUNITY_TTL_MS;
  }

  return Math.min(deadlineAt, generatedAt + OPPORTUNITY_TTL_MS);
}

function buildSeedOpportunities(locale: "en" | "es", existingClaims: VSData[]) {
  return getSeedChallengeOpportunities(locale).map((seed) => {
    const quality = getCandidateScore(seed.candidate);
    const existingClaim = findExistingOpportunityClaim(seed.candidate, existingClaims);

    return {
      id: seed.id,
      sourceUrl: seed.sourceUrl,
      sourceType: seed.sourceType,
      sourceSummary: seed.sourceSummary,
      candidate: seed.candidate,
      claimStrengthScore: quality.qualityScore,
      claimStrengthTier: quality.qualityTier,
      action: existingClaim ? "challenge" : "create",
      existingClaimId: existingClaim?.id,
    } satisfies ChallengeOpportunity;
  });
}

function mapStoredRowsToResponse(rows: Awaited<ReturnType<typeof getActiveChallengeOpportunities>>) {
  const items: ChallengeOpportunity[] = rows.map((row) => ({
    id: row.id,
    sourceUrl: row.source_url,
    sourceType: row.source_type as ChallengeOpportunity["sourceType"],
    sourceSummary: row.source_summary,
    candidate: {
      category: row.category as SourceClaimDraftCandidate["category"],
      claimText: row.claim_text,
      sideA: row.side_a,
      sideB: row.side_b,
      deadlineAt: row.deadline_at,
      timezone: row.timezone,
      primaryResolutionSource: row.primary_resolution_source,
      settlementRule: row.settlement_rule,
      ambiguityFlags: JSON.parse(row.ambiguity_flags_json || "[]") as string[],
      confidenceScore: row.confidence_score,
    },
    claimStrengthScore: row.claim_strength_score,
    claimStrengthTier: row.claim_strength_tier as ChallengeOpportunity["claimStrengthTier"],
    action: row.action as ChallengeOpportunity["action"],
    existingClaimId: row.existing_claim_id ?? undefined,
  }));

  const latestGeneratedAt = rows.reduce((latest, row) => Math.max(latest, row.generated_at), 0);

  return {
    items,
    count: items.length,
    generatedAt: latestGeneratedAt > 0 ? new Date(latestGeneratedAt).toISOString() : "",
  } satisfies ChallengeOpportunitiesResponse;
}

async function buildChallengeOpportunitiesForLocale(locale: "en" | "es") {
  const [existingClaims, generatedDrafts] = await Promise.all([
    getExistingClaimsSnapshot(),
    Promise.allSettled(
      CHALLENGE_OPPORTUNITY_SOURCES.map((source) =>
        generateClaimDrafts({
          sourceUrl: source.url,
          locale,
        })
      )
    ),
  ]);

  const configurationFailure = generatedDrafts.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" &&
      /not configured/i.test(
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      )
  );

  if (configurationFailure && !generatedDrafts.some((result) => result.status === "fulfilled")) {
    console.warn("Challenge opportunities generator is quota-limited; using stored seeds.", configurationFailure.reason);
  }

  const aiOpportunities = generatedDrafts.flatMap((result, index) => {
    if (result.status !== "fulfilled") {
      return [];
    }

    const bestCandidate = pickBestCandidate(result.value.candidates);
    if (!bestCandidate) {
      return [];
    }

    const quality = getCandidateScore(bestCandidate);
    const existingClaim = findExistingOpportunityClaim(bestCandidate, existingClaims);
    const source = CHALLENGE_OPPORTUNITY_SOURCES[index];

    return [
      {
        id: `${source?.id ?? index}-${normalizeComparableText(bestCandidate.claimText).slice(0, 48)}`,
        sourceUrl: result.value.sourceUrl,
        sourceType: result.value.sourceType,
        sourceSummary: result.value.sourceSummary,
        candidate: bestCandidate,
        claimStrengthScore: quality.qualityScore,
        claimStrengthTier: quality.qualityTier,
        action: existingClaim ? "challenge" : "create",
        existingClaimId: existingClaim?.id,
      } satisfies ChallengeOpportunity,
    ];
  });

  const seedOpportunities = buildSeedOpportunities(locale, existingClaims);

  return dedupeOpportunities([...aiOpportunities, ...seedOpportunities]).sort((a, b) => {
    if (a.action !== b.action) {
      return a.action === "challenge" ? -1 : 1;
    }
    if (b.claimStrengthScore !== a.claimStrengthScore) {
      return b.claimStrengthScore - a.claimStrengthScore;
    }
    if (b.candidate.confidenceScore !== a.candidate.confidenceScore) {
      return b.candidate.confidenceScore - a.candidate.confidenceScore;
    }
    return String(b.id).localeCompare(String(a.id));
  });
}

export async function refreshChallengeOpportunitiesIndex(options?: {
  locales?: Array<"en" | "es">;
}) {
  const locales: Array<"en" | "es"> =
    options?.locales?.length ? options.locales : ["en", "es"];
  const generatedAt = Date.now();

  await pruneExpiredChallengeOpportunities(generatedAt);

  const countsByLocale: Record<string, number> = {};

  for (const locale of locales) {
    const opportunities = await buildChallengeOpportunitiesForLocale(locale);
    await replaceChallengeOpportunities({
      locale,
      generatedAt,
      opportunities: opportunities.map((opportunity) => ({
        ...opportunity,
        expiresAt: getOpportunityExpiresAt(opportunity.candidate, generatedAt),
      })),
    });
    countsByLocale[locale] = opportunities.length;
  }

  return {
    generatedAt,
    locales,
    countsByLocale,
  };
}

export async function getChallengeOpportunities(options?: {
  locale?: string;
  limit?: number;
}) {
  const locale = options?.locale === "es" ? "es" : "en";
  const limit = options?.limit;

  let rows = await getActiveChallengeOpportunities({
    locale,
    limit,
  });

  if (rows.length === 0) {
    try {
      const generatedAt = Date.now();
      const existingClaims = await getExistingClaimsSnapshot();
      const opportunities = buildSeedOpportunities(locale, existingClaims);

      await replaceChallengeOpportunities({
        locale,
        generatedAt,
        opportunities: opportunities.map((opportunity) => ({
          ...opportunity,
          expiresAt: getOpportunityExpiresAt(opportunity.candidate, generatedAt),
        })),
      });

      rows = await getActiveChallengeOpportunities({
        locale,
        limit,
      });
    } catch (error) {
      console.warn(
        `Challenge opportunities seed refresh failed for locale ${locale}; returning cached rows.`,
        error
      );
    }
  }

  return mapStoredRowsToResponse(rows);
}
