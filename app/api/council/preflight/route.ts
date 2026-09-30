/**
 * Council preflight, pay-per-read.
 *
 * POST /api/council/preflight?persona=optimist   ($0.001 USDC / read)
 *
 * The market-creator buys persona opinions before opening a market. This is
 * different from /api/council/vote: preflight judges whether a candidate is
 * worth creating, while vote judges an already-created claim at settlement.
 */

import { NextResponse, type NextRequest } from "next/server";
import { paidRoute, queryParam } from "@/lib/x402/server";
import { tracedRoute } from "@/lib/ops/trace-http";
import type { HTTPRequestContext } from "@x402/core/http";
import { PRICES } from "@/lib/x402/config";
import { getPersonaBySlug } from "@/agents/council/personas";
import { isSettlementMode, type SettlementMode } from "@/lib/market-modes";
import { isPreflightDimension, type PreflightDimension } from "@/lib/market-creator/preflight-score";
import { getCouncilAddress } from "@/lib/agent-wallets";
import { callLLM } from "@/lib/llm";

interface CandidatePayload {
  question?: string;
  creatorPosition?: string;
  counterPosition?: string;
  resolutionUrl?: string;
  category?: string;
  settlementRule?: string;
  deadlineHours?: number;
  qualityScore?: number;
}

/** Recipient of this opinion's fee — the persona itself, not the platform. */
function personaAddress(ctx: HTTPRequestContext): string {
  const slug = queryParam(ctx, "persona").toLowerCase().trim();
  const payTo = getCouncilAddress(slug);
  if (!payTo) throw new Error(`persona '${slug}' has no wallet configured`);
  return payTo;
}

function cleanCandidate(value: unknown): CandidatePayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const question = String(raw.question ?? "").trim();
  const creatorPosition = String(raw.creatorPosition ?? "").trim();
  const counterPosition = String(raw.counterPosition ?? "").trim();
  const resolutionUrl = String(raw.resolutionUrl ?? "").trim();
  const category = String(raw.category ?? "").trim();
  const settlementRule = String(raw.settlementRule ?? "").trim();
  const deadlineHours = Number(raw.deadlineHours ?? 0);
  const qualityScore = Number(raw.qualityScore ?? 0);

  if (!question || !creatorPosition || !counterPosition || !resolutionUrl) {
    return null;
  }

  return {
    question: question.slice(0, 500),
    creatorPosition: creatorPosition.slice(0, 300),
    counterPosition: counterPosition.slice(0, 300),
    resolutionUrl: resolutionUrl.slice(0, 600),
    category: category.slice(0, 80),
    settlementRule: settlementRule.slice(0, 700),
    deadlineHours: Number.isFinite(deadlineHours) ? deadlineHours : 0,
    qualityScore: Number.isFinite(qualityScore) ? qualityScore : 0,
  };
}

/**
 * Named dimension scores out of the model's JSON.
 *
 * A key the model invented is dropped and a non-numeric value is skipped rather
 * than coerced: "high" is not a score, and turning it into 0 would veto a market
 * on a parse failure. A skipped dimension reads as an abstention, which the
 * aggregator already treats as "unknown", not "fine".
 */
function parseModelDimensions(raw: unknown): Partial<Record<PreflightDimension, number>> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<PreflightDimension, number>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPreflightDimension(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = Math.max(0, Math.min(100, Math.round(value)));
  }
  return out;
}

function parseModelMode(value: unknown): SettlementMode | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  // squad_pool is refused here even though it is a valid mode name: the escrow for
  // it is not deployed, so a persona suggesting it would propose an unopenable
  // market.
  if (normalized === "squad_pool") return undefined;
  return isSettlementMode(normalized) ? normalized : undefined;
}

function parseModelJson(text: string): {
  decision: "open" | "revise" | "skip";
  score: number;
  confidence: number;
  reasoning: string;
  dimensions: Partial<Record<PreflightDimension, number>>;
  suggestedMode?: SettlementMode;
} {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Record<string, unknown>;
    const rawDecision = String(parsed.decision ?? "").toLowerCase();
    const decision =
      rawDecision === "open" || rawDecision === "revise" || rawDecision === "skip"
        ? rawDecision
        : "revise";
    return {
      decision,
      score: Math.max(0, Math.min(100, Math.round(Number(parsed.score ?? 50)))),
      confidence: Math.max(0, Math.min(100, Math.round(Number(parsed.confidence ?? 50)))),
      reasoning: String(parsed.reasoning ?? "").slice(0, 400),
      dimensions: parseModelDimensions(parsed.dimensions),
      suggestedMode: parseModelMode(parsed.suggestedMode),
    };
  } catch {
    return {
      decision: "revise",
      score: 50,
      confidence: 30,
      reasoning: "(persona response could not be parsed)",
      // No dimensions: an unparseable response has not scored anything, and the
      // aggregator refuses an autonomous publish on unknown dimensions.
      dimensions: {},
    };
  }
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const slug = (req.nextUrl.searchParams.get("persona") ?? "").toLowerCase().trim();

  const persona = getPersonaBySlug(slug);
  if (!persona) return NextResponse.json({ error: `unknown persona '${slug}'` }, { status: 400 });

  const payTo = getCouncilAddress(slug);
  if (!payTo) {
    return NextResponse.json({ error: `persona '${slug}' has no wallet configured` }, { status: 503 });
  }

  let candidate: CandidatePayload | null = null;
  try {
    candidate = cleanCandidate(await req.json());
  } catch {
    candidate = null;
  }
  if (!candidate) {
    return NextResponse.json({ error: "candidate payload is required" }, { status: 400 });
  }

  const category = candidate.category?.toLowerCase() ?? "";
  if (
    persona.categoryFilter &&
    !persona.categoryFilter.some((c) => c.toLowerCase() === category)
  ) {
    return NextResponse.json({
      persona: { slug, name: persona.displayName, emoji: persona.emoji },
      decision: "skip",
      score: 30,
      confidence: 80,
      reasoning: `${persona.displayName} skips ${category || "uncategorized"} markets outside its domain.`,
      paidTo: payTo,
      price: PRICES.councilPreflight,
    });
  }

  const personaFrame =
    persona.promptBias ??
    `You are ${persona.displayName} on the Mimir Council. ${persona.longBio}`;
  const prompt = `${personaFrame}

You are being paid for a pre-market opinion before Mimir opens this candidate.

Candidate:
- Question: ${candidate.question}
- Creator side: ${candidate.creatorPosition}
- Challenger side: ${candidate.counterPosition}
- Category: ${candidate.category || "custom"}
- Resolution URL: ${candidate.resolutionUrl}
- Settlement rule: ${candidate.settlementRule || "(none)"}
- Deadline hours from now: ${candidate.deadlineHours}
- Draft quality score: ${candidate.qualityScore}

Return JSON only:
{
  "decision": "open" | "revise" | "skip",
  "score": 0-100,
  "confidence": 0-100,
  "dimensions": {
    "resolutionClarity": 0-100,
    "sourceIndependence": 0-100,
    "liquidityFit": 0-100,
    "bestMode": 0-100
  },
  "suggestedMode": "pool" | "duel" | "fixed_odds",
  "reasoning": "one tight sentence, max 45 words"
}

Score the candidate as a market to create, not as a final outcome. Each dimension is judged on its own:
- resolutionClarity: could an oracle settle this rule after the deadline without guessing? Threshold, units, timezone, tie-break and void conditions all stated?
- sourceIndependence: would the sources independently confirm the outcome, or do they republish one another?
- liquidityFit: is this stake and deadline sensible for how much interest this topic will attract?
- bestMode: is the proposed settlement mode right for this claim?

Omit a dimension rather than guessing at it. Favor clear, verifiable, balanced markets. Penalize vague rules, weak sources, stale outcomes, or one-sided framing. Stay in character.`;

  let result: ReturnType<typeof parseModelJson>;
  try {
    result = parseModelJson(await callLLM(prompt, { maxTokens: 260, jsonOnly: true }));
  } catch {
    result = {
      decision: "revise",
      score: 50,
      confidence: 20,
      reasoning: "(reasoning unavailable right now)",
      dimensions: {},
    };
  }

  return NextResponse.json({
    persona: { slug, name: persona.displayName, emoji: persona.emoji },
    ...result,
    paidTo: payTo,
    price: PRICES.councilPreflight,
  });
}

// Dynamic payTo: each persona is paid into its own wallet. Traced so the
// market-creator's preflight cycle and the read it made share one id.
export const POST = tracedRoute("api.council.preflight", paidRoute("councilPreflight", handler, { payTo: personaAddress }));
