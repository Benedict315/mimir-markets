export const CLAIM_DRAFT_CATEGORY_IDS = [
  "sports",
  "weather",
  "crypto",
  "culture",
  "custom",
] as const;

export const CLAIM_DRAFT_MAX_CANDIDATES = 3;

export type ClaimDraftCategory = (typeof CLAIM_DRAFT_CATEGORY_IDS)[number];

export const CLAIM_DRAFT_SOURCE_TYPES = ["official", "media", "other"] as const;

export type ClaimDraftSourceType = (typeof CLAIM_DRAFT_SOURCE_TYPES)[number];

export interface SourceClaimDraftCandidate {
  category: ClaimDraftCategory;
  claimText: string;
  sideA: string;
  sideB: string;
  deadlineAt: string;
  timezone: string;
  primaryResolutionSource: string;
  settlementRule: string;
  ambiguityFlags: string[];
  confidenceScore: number;
}

export interface SourceClaimDraftResponse {
  sourceUrl: string;
  sourceType: ClaimDraftSourceType;
  sourceSummary: string;
  candidates: SourceClaimDraftCandidate[];
}

export type ChallengeOpportunityAction = "create" | "challenge";

export type ChallengeOpportunityStrengthTier = "strong" | "good" | "fair" | "weak";

export interface ChallengeOpportunity {
  id: string;
  sourceUrl: string;
  sourceType: ClaimDraftSourceType;
  sourceSummary: string;
  candidate: SourceClaimDraftCandidate;
  claimStrengthScore: number;
  claimStrengthTier: ChallengeOpportunityStrengthTier;
  action: ChallengeOpportunityAction;
  existingClaimId?: number;
}

export interface ChallengeOpportunitiesResponse {
  items: ChallengeOpportunity[];
  count: number;
  generatedAt: string;
}
