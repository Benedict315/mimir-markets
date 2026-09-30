/**
 * Contract-backed settlement receipt mapping.
 *
 * Chain data on `VSData` is the source of truth. This module turns that into a
 * stable view model for the UI — including loading / invalid / stale /
 * disconnected / dependency-failure states — without inventing payout amounts
 * or rewriting wallet addresses.
 */

import { normalizeResolutionSource } from "@/lib/constants";
import { getVSTotalPot, type VSData } from "@/lib/contract";
import type { VSCacheFreshness } from "@/lib/vs-freshness";
import {
  validateResearchCitation,
  type ResearchCitation,
} from "@/lib/verdict";

export type SettlementReceiptStatus =
  | "loading"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency_failure"
  | "ready";

export type SettlementOutcomeKey =
  | "creator"
  | "challengers"
  | "draw"
  | "unresolvable"
  | "none";

export interface SettlementReceiptInput {
  /** Settled claim snapshot from the feed / contract. Null while loading. */
  vs: VSData | null | undefined;
  /** Optional cache freshness — stale receipts still render with a warning. */
  freshness?: VSCacheFreshness | null;
  /** True while the parent page is still fetching the claim. */
  loading?: boolean;
  /**
   * Explicit wallet / RPC disconnect. When set, we do not pretend the receipt
   * is live on-chain even if a cached `vs` is present.
   */
  disconnected?: boolean;
  /** Optional research citations backing the verdict or settlement receipt. */
  citations?: ResearchCitation[];
}

export interface SettlementReceiptView {
  status: SettlementReceiptStatus;
  /** i18n key under `settlement.receiptStatus.*` */
  statusMessageKey: SettlementReceiptStatus;
  claimId: number | null;
  marketState: VSData["state"] | null;
  outcome: SettlementOutcomeKey;
  /** On-chain oracle confidence (0–100), never the off-chain claim-quality score. */
  confidence: number | null;
  sourceUrl: string;
  sourceHost: string;
  deadlineUnix: number | null;
  settlementRule: string;
  /** Display USDC from contract-derived pot helpers. */
  totalPotUsdc: number | null;
  remainingEscrowUsdc: number | null;
  /** Winner wallet when the contract recorded one; otherwise null. */
  winnerAddress: string | null;
  /** True when the view is driven by resolved/cancelled chain state. */
  chainBacked: boolean;
  freshnessStatus: VSCacheFreshness["status"] | null;
  /** Attached research citations backing this verdict and settlement receipt. */
  citations: ResearchCitation[];
  /** Authoritative on-chain evidence hash from the contract, if present. */
  evidenceHash: string | null;
  /** Authoritative on-chain context hash from the contract, if present. */
  contextHash: string | null;
}

const ZEROISH = /^(0x)?0+$/i;

function isBlankAddress(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF") return true;
  if (ZEROISH.test(trimmed)) return true;
  return false;
}

function hostFromSource(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function mapOutcome(vs: VSData): SettlementOutcomeKey {
  switch (vs.winner_side) {
    case "creator":
    case "challengers":
    case "draw":
    case "unresolvable":
      return vs.winner_side;
    default:
      return "none";
  }
}

function emptyView(
  status: SettlementReceiptStatus,
  partial: Partial<SettlementReceiptView> = {},
): SettlementReceiptView {
  return {
    status,
    statusMessageKey: status,
    claimId: null,
    marketState: null,
    outcome: "none",
    confidence: null,
    sourceUrl: "",
    sourceHost: "",
    deadlineUnix: null,
    settlementRule: "",
    totalPotUsdc: null,
    remainingEscrowUsdc: null,
    winnerAddress: null,
    chainBacked: false,
    freshnessStatus: null,
    citations: [],
    evidenceHash: null,
    contextHash: null,
    ...partial,
  };
}

/**
 * Map a claim snapshot (+ optional freshness) into a complete settlement receipt.
 * Pure: safe for node tests and SSR.
 */
export function buildSettlementReceipt(
  input: SettlementReceiptInput,
): SettlementReceiptView {
  const {
    vs,
    freshness = null,
    loading = false,
    disconnected = false,
    citations: inputCitations,
  } = input;

  if (loading && !vs) {
    return emptyView("loading", {
      freshnessStatus: freshness?.status ?? null,
    });
  }

  if (disconnected) {
    return emptyView("disconnected", {
      claimId: typeof vs?.id === "number" ? vs.id : null,
      marketState: vs?.state ?? null,
      freshnessStatus: freshness?.status ?? null,
    });
  }

  if (!vs) {
    return emptyView("invalid");
  }

  if (typeof vs.id !== "number" || !Number.isFinite(vs.id) || vs.id < 0) {
    return emptyView("dependency_failure", {
      marketState: vs.state ?? null,
      freshnessStatus: freshness?.status ?? null,
    });
  }

  const settled = vs.state === "resolved" || vs.state === "cancelled";
  if (!settled) {
    return emptyView("invalid", {
      claimId: vs.id,
      marketState: vs.state,
      freshnessStatus: freshness?.status ?? null,
      sourceUrl: normalizeResolutionSource(vs.resolution_url ?? ""),
      deadlineUnix:
        typeof vs.deadline === "number" && vs.deadline > 0 ? vs.deadline : null,
    });
  }

  const outcome = mapOutcome(vs);
  if (vs.state === "resolved" && outcome === "none") {
    // Resolved without a winner_side is a mapping / index corruption case.
    return emptyView("dependency_failure", {
      claimId: vs.id,
      marketState: vs.state,
      freshnessStatus: freshness?.status ?? null,
    });
  }

  let totalPotUsdc: number | null = null;
  try {
    const pot = getVSTotalPot(vs);
    totalPotUsdc = Number.isFinite(pot) ? pot : null;
  } catch {
    return emptyView("dependency_failure", {
      claimId: vs.id,
      marketState: vs.state,
      freshnessStatus: freshness?.status ?? null,
    });
  }

  const sourceUrl = normalizeResolutionSource(vs.resolution_url ?? "");
  const confidence =
    typeof vs.confidence === "number" && Number.isFinite(vs.confidence)
      ? Math.max(0, Math.min(100, vs.confidence))
      : null;

  const remaining =
    typeof vs.remaining_escrow === "number" && Number.isFinite(vs.remaining_escrow)
      ? vs.remaining_escrow
      : null;

  const winnerAddress = isBlankAddress(vs.winner) ? null : vs.winner.trim();

  const citations: ResearchCitation[] = [];
  if (Array.isArray(inputCitations)) {
    for (const c of inputCitations) {
      const valid = validateResearchCitation(c);
      if (valid) citations.push(valid);
    }
  }

  const evidenceHash =
    typeof vs.evidence_hash === "string" && vs.evidence_hash.trim()
      ? vs.evidence_hash.trim()
      : null;

  const contextHash =
    typeof vs.context_hash === "string" && vs.context_hash.trim()
      ? vs.context_hash.trim()
      : null;

  // Fallback: if no citations were passed explicitly, derive a canonical one
  // from authoritative on-chain fields (sourceUrl and evidence_hash / context_hash).
  if (citations.length === 0 && sourceUrl) {
    const rawHash = (evidenceHash || contextHash || "").trim().toLowerCase();
    if (rawHash && /^[0-9a-f]{8,64}$/.test(rawHash)) {
      citations.push({
        url: sourceUrl,
        domain: hostFromSource(sourceUrl),
        contentHash: rawHash,
        capturedAt:
          (typeof vs.created_at === "number" && vs.created_at > 0
            ? vs.created_at * 1000
            : 0) || Date.now(),
        trustTier: "primary",
      });
    }
  }

  const view: SettlementReceiptView = {
    status: freshness?.status === "stale" ? "stale" : "ready",
    statusMessageKey: freshness?.status === "stale" ? "stale" : "ready",
    claimId: vs.id,
    marketState: vs.state,
    outcome,
    confidence,
    sourceUrl,
    sourceHost: hostFromSource(sourceUrl),
    deadlineUnix:
      typeof vs.deadline === "number" && vs.deadline > 0 ? vs.deadline : null,
    settlementRule: (vs.settlement_rule ?? "").trim(),
    totalPotUsdc,
    remainingEscrowUsdc: remaining,
    winnerAddress,
    chainBacked: true,
    freshnessStatus: freshness?.status ?? null,
    citations,
    evidenceHash,
    contextHash,
  };

  return view;
}

/** Whether the receipt UI should render the full field grid (vs status-only). */
export function settlementReceiptShowsFields(
  view: SettlementReceiptView,
): boolean {
  return view.status === "ready" || view.status === "stale";
}
