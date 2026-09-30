import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSettlementReceipt,
  settlementReceiptShowsFields,
} from "../../lib/settlementReceipt";
import type { VSData } from "../../lib/contract";
import type { VSCacheFreshness } from "../../lib/vs-freshness";
import type { ResearchCitation } from "../../lib/verdict";

const CREATOR = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const CHALLENGER = "GCHALLENGERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function makeVs(overrides: Partial<VSData> = {}): VSData {
  return {
    id: 58,
    creator: CREATOR,
    opponent: CHALLENGER,
    question: "Will BTC close above 100k?",
    creator_position: "Yes",
    opponent_position: "No",
    resolution_url: "https://example.com/price",
    stake_amount: 5,
    deadline: 1_700_000_000,
    state: "resolved",
    winner: CREATOR,
    resolution_summary: "Price closed above threshold.",
    category: "crypto",
    winner_side: "creator",
    confidence: 91,
    settlement_rule: "Close price on example.com after deadline.",
    creator_stake: 5,
    total_challenger_stake: 3,
    total_pot: 8,
    remaining_escrow: 0,
    challenger_count: 1,
    challenger_addresses: [CHALLENGER],
    ...overrides,
  };
}

function staleFreshness(): VSCacheFreshness {
  return {
    source: "index",
    status: "stale",
    lastUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    ageMs: 60_000,
    freshnessWindowMs: 1_000,
  };
}

test("positive: resolved claim builds a complete chain-backed receipt", () => {
  const view = buildSettlementReceipt({ vs: makeVs() });
  assert.equal(view.status, "ready");
  assert.equal(view.chainBacked, true);
  assert.equal(view.claimId, 58);
  assert.equal(view.outcome, "creator");
  assert.equal(view.confidence, 91);
  assert.equal(view.sourceHost, "example.com");
  assert.equal(view.deadlineUnix, 1_700_000_000);
  assert.equal(view.totalPotUsdc, 8);
  assert.equal(view.remainingEscrowUsdc, 0);
  assert.equal(view.winnerAddress, CREATOR);
  assert.equal(view.settlementRule.includes("Close price"), true);
  assert.equal(settlementReceiptShowsFields(view), true);
});

test("negative: open claim is invalid (no receipt fields)", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ state: "open", winner_side: "", winner: "" }),
  });
  assert.equal(view.status, "invalid");
  assert.equal(view.chainBacked, false);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("negative: disconnected overrides cached settled data", () => {
  const view = buildSettlementReceipt({
    vs: makeVs(),
    disconnected: true,
  });
  assert.equal(view.status, "disconnected");
  assert.equal(view.claimId, 58);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("boundary: loading with no vs yields loading status", () => {
  const view = buildSettlementReceipt({ vs: null, loading: true });
  assert.equal(view.status, "loading");
  assert.equal(view.claimId, null);
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("boundary: confidence is clamped to 0..100", () => {
  const high = buildSettlementReceipt({ vs: makeVs({ confidence: 140 }) });
  assert.equal(high.confidence, 100);
  const low = buildSettlementReceipt({ vs: makeVs({ confidence: -5 }) });
  assert.equal(low.confidence, 0);
});

test("boundary: blank winner address is omitted", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ winner: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }),
  });
  assert.equal(view.winnerAddress, null);
  assert.equal(view.status, "ready");
});

test("regression: stale freshness still shows fields with stale status", () => {
  const view = buildSettlementReceipt({
    vs: makeVs(),
    freshness: staleFreshness(),
  });
  assert.equal(view.status, "stale");
  assert.equal(view.freshnessStatus, "stale");
  assert.equal(settlementReceiptShowsFields(view), true);
  assert.equal(view.outcome, "creator");
});

test("regression: resolved without winner_side is dependency_failure", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ winner_side: "", winner: "" }),
  });
  assert.equal(view.status, "dependency_failure");
  assert.equal(settlementReceiptShowsFields(view), false);
});

test("regression: cancelled draw still produces a receipt", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({
      state: "cancelled",
      winner_side: "draw",
      winner: "",
      remaining_escrow: 2.5,
    }),
  });
  assert.equal(view.status, "ready");
  assert.equal(view.outcome, "draw");
  assert.equal(view.remainingEscrowUsdc, 2.5);
  assert.equal(view.winnerAddress, null);
});

test("regression: source without scheme is normalized", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ resolution_url: "docs.example.org/settle" }),
  });
  assert.equal(view.sourceUrl.startsWith("https://"), true);
  assert.equal(view.sourceHost, "docs.example.org");
});

test("positive: attached research citations are validated and rendered", () => {
  const citations: ResearchCitation[] = [
    {
      url: "https://api.coingecko.com/price",
      domain: "api.coingecko.com",
      contentHash: "1234567890abcdef",
      capturedAt: 1700000000000,
      title: "CoinGecko API Price Feed",
      trustTier: "primary",
    },
  ];
  const view = buildSettlementReceipt({
    vs: makeVs({ evidence_hash: "1234567890abcdef" }),
    citations,
  });
  assert.equal(view.status, "ready");
  assert.equal(view.citations.length, 1);
  assert.equal(view.citations[0].url, "https://api.coingecko.com/price");
  assert.equal(view.citations[0].domain, "api.coingecko.com");
  assert.equal(view.citations[0].contentHash, "1234567890abcdef");
  assert.equal(view.evidenceHash, "1234567890abcdef");
});

test("positive: on-chain evidence_hash derives fallback citation if citations omitted", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({
      resolution_url: "https://api.coingecko.com/coins/btc",
      evidence_hash: "abcdef0123456789abcdef0123456789",
      created_at: 1700000,
    }),
  });
  assert.equal(view.status, "ready");
  assert.equal(view.citations.length, 1);
  assert.equal(view.citations[0].url, "https://api.coingecko.com/coins/btc");
  assert.equal(view.citations[0].domain, "api.coingecko.com");
  assert.equal(view.citations[0].contentHash, "abcdef0123456789abcdef0123456789");
  assert.equal(view.citations[0].trustTier, "primary");
  assert.equal(view.evidenceHash, "abcdef0123456789abcdef0123456789");
});

test("negative: malformed or credential-leaking citations are excluded from receipt", () => {
  const malformedCitations: any[] = [
    {
      url: "https://admin:supersecret@example.com/data", // basic auth leak
      contentHash: "1234567890abcdef",
      capturedAt: 1700000000000,
    },
    {
      url: "ftp://example.com/data", // non-http/https
      contentHash: "1234567890abcdef",
      capturedAt: 1700000000000,
    },
    {
      url: "https://example.com/ok",
      contentHash: "badhash", // not valid hex >= 8
      capturedAt: 1700000000000,
    },
  ];
  const view = buildSettlementReceipt({
    vs: makeVs({ evidence_hash: undefined }),
    citations: malformedCitations,
  });
  assert.equal(view.status, "ready");
  assert.equal(view.citations.length, 0);
});

test("dependency_failure: invalid claimId produces dependency_failure", () => {
  const view = buildSettlementReceipt({
    vs: makeVs({ id: -1 }),
  });
  assert.equal(view.status, "dependency_failure");
  assert.equal(settlementReceiptShowsFields(view), false);
});
