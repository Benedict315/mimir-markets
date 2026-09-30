/**
 * Paid council preflight for the market-creator.
 *
 * The market-creator buys short persona opinions before opening a market. This
 * turns council personas into information sellers before settlement, not only
 * jurors after the deadline.
 */

import { listCouncilPersonas } from "../council/personas";
import { fetchWithBudget, type PayingWallet } from "../../lib/x402/buyer";
import { outboundTraceHeaders } from "../../lib/ops/trace-http";
import { usdcToUnits } from "../../lib/usdc";
import { isSettlementMode, type SettlementMode } from "../../lib/market-modes";
import {
  isPreflightDimension,
  scorePreflight,
  type PreflightDimension,
  type PreflightVerdict,
} from "../../lib/market-creator/preflight-score";

export interface ClaimCandidateForPreflight {
  question: string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl: string;
  category: string;
  marketType: string;
  settlementRule: string;
  deadlineHours: number;
  qualityScore: number;
  sourceType: string;
}

export interface CouncilPreflightOpinion {
  slug: string;
  displayName: string;
  decision: "open" | "revise" | "skip";
  /** Blended score, kept for continuity with the older proposal records. */
  score: number;
  /** Named dimensions (§10.4). Any may be absent — a persona abstaining on it. */
  dimensionScores: Partial<Record<PreflightDimension, number>>;
  suggestedMode?: SettlementMode;
  confidence: number;
  reasoning: string;
  pricePaidUnits: string | null;
}

export interface CouncilPreflightResult {
  opinions: CouncilPreflightOpinion[];
  averageScore: number | null;
  openVotes: number;
  reviseVotes: number;
  skipVotes: number;
  totalPaidUnits: bigint;
  /**
   * Per-dimension verdict. This, not averageScore, is what gates an autonomous
   * publish — a blended average lets one fatal dimension hide behind three good
   * ones.
   */
  verdict: PreflightVerdict;
}

interface PreflightResponse {
  decision?: string;
  score?: number;
  confidence?: number;
  reasoning?: string;
  /** Named dimension scores, when the persona returns them. */
  dimensions?: Record<string, unknown>;
  suggestedMode?: string;
}

/**
 * Read the named dimensions out of a persona's response.
 *
 * Unknown keys are dropped and non-numeric values are skipped rather than coerced:
 * a persona that answers "high" has not scored the dimension, and turning that into
 * a 0 would veto the market on a parse failure.
 */
function parseDimensions(raw: unknown): Partial<Record<PreflightDimension, number>> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<PreflightDimension, number>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPreflightDimension(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = Math.max(0, Math.min(100, Math.round(value)));
  }
  return out;
}

function parseSuggestedMode(value: unknown): SettlementMode | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return isSettlementMode(normalized) ? normalized : undefined;
}

function selectedPersonas(raw: string | undefined) {
  const slugs = (raw ?? "optimist,pessimist,statistician,contrarian,doomer")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wanted = new Set(slugs);
  return listCouncilPersonas().filter((p) => wanted.has(p.slug));
}

function parseDecision(value: unknown): "open" | "revise" | "skip" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "open" || normalized === "revise" || normalized === "skip") {
    return normalized;
  }
  return "revise";
}

export async function gatherCouncilPreflight(args: {
  candidate: ClaimCandidateForPreflight;
  baseUrl: string;
  payer: PayingWallet;
  personaCsv?: string;
  capUsdc?: number;
  delayMs?: number;
  /** The mode the creator intends, so the panel can disagree with it explicitly. */
  requestedMode?: SettlementMode;
}): Promise<CouncilPreflightResult> {
  const capUnits = usdcToUnits(args.capUsdc ?? 0.005);
  const personas = selectedPersonas(args.personaCsv);
  const opinions: CouncilPreflightOpinion[] = [];
  let totalPaidUnits = 0n;

  for (const persona of personas) {
    const url = `${args.baseUrl.replace(/\/$/, "")}/api/council/preflight?persona=${encodeURIComponent(persona.slug)}`;
    try {
      // Trace header alongside the payment headers: a preflight panel read and the
      // creator cycle that paid for it are one trace. Inert to the x402 proof.
      const result = await fetchWithBudget(url, args.payer, capUnits, {
        method: "POST",
        headers: { "content-type": "application/json", ...outboundTraceHeaders() },
        body: JSON.stringify(args.candidate),
      });
      if (!result.response.ok) continue;
      const body = (await result.response.json()) as PreflightResponse;
      const priceUnits = result.payment?.priceUnits ?? null;
      if (priceUnits != null) totalPaidUnits += priceUnits;
      opinions.push({
        slug: persona.slug,
        displayName: persona.displayName,
        decision: parseDecision(body.decision),
        score: Math.max(0, Math.min(100, Math.round(Number(body.score ?? 50)))),
        dimensionScores: parseDimensions(body.dimensions),
        suggestedMode: parseSuggestedMode(body.suggestedMode),
        confidence: Math.max(0, Math.min(100, Math.round(Number(body.confidence ?? 50)))),
        reasoning: String(body.reasoning ?? "").slice(0, 400),
        pricePaidUnits: priceUnits != null ? priceUnits.toString() : null,
      });
    } catch {
      // Preflight is advisory. A persona that errors simply abstains.
    }

    if (args.delayMs && args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }

  const averageScore =
    opinions.length > 0
      ? opinions.reduce((sum, opinion) => sum + opinion.score, 0) / opinions.length
      : null;

  return {
    opinions,
    averageScore,
    openVotes: opinions.filter((opinion) => opinion.decision === "open").length,
    reviseVotes: opinions.filter((opinion) => opinion.decision === "revise").length,
    skipVotes: opinions.filter((opinion) => opinion.decision === "skip").length,
    totalPaidUnits,
    verdict: scorePreflight(
      opinions.map((opinion) => ({
        slug: opinion.slug,
        scores: opinion.dimensionScores,
        suggestedMode: opinion.suggestedMode,
        confidence: opinion.confidence,
      })),
      args.requestedMode,
    ),
  };
}
