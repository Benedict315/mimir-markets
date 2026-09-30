/**
 * tests/node/oracle-confidence-tiers.test.ts
 *
 * Calibrates lib/oracle/confidence-tiers.ts against synthetic verdict fixtures
 * (tests/fixtures/oracle-verdicts/confidence-tiers.json) — #97.
 *
 *  A. Fixture calibration (applyFetcherTrust → tierVerdict)
 *  B. Tier boundaries
 *  C. Negative: malformed confidence never pays out a side
 *  D. On-chain summary tags stay compatible with the receipt UI
 *  E. Regression: identical to the original oracle helpers
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MED_MIN,
  CONTESTED_TAG,
  LOW_CONFIDENCE_TAG,
  MAX_CONFIDENCE_NON_API,
  MAX_EXPLANATION_CHARS,
  applyFetcherTrust,
  confidenceTier,
  tierVerdict,
  type ConfidenceTier,
} from "../../lib/oracle/confidence-tiers";
import { VERDICTS, type VerdictPayload } from "../../lib/verdict";
import type { EvidenceFetcherKind } from "../../lib/server/evidence-fetcher";

type Fetcher = EvidenceFetcherKind | "none";

interface FixtureCase {
  name: string;
  fetcher: Fetcher;
  input: VerdictPayload;
  expected: VerdictPayload & { tier: ConfidenceTier };
}

const FIXTURES = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "oracle-verdicts", "confidence-tiers.json"), "utf8"),
) as { cases: FixtureCase[] };

const FETCHERS: Fetcher[] = ["coingecko-api", "jina", "direct", "bot-paid", "none"];
const DECISIVE = ["CREATOR_WINS", "CHALLENGERS_WIN"] as const;

// ── A. Fixture calibration ────────────────────────────────────────────────────

test("A: fixtures cover every tier, every verdict and every fetcher", () => {
  const tiers = new Set(FIXTURES.cases.map((c) => c.expected.tier));
  assert.deepEqual([...tiers].sort(), ["high", "low", "medium"]);
  const verdicts = new Set(FIXTURES.cases.map((c) => c.expected.verdict));
  assert.deepEqual([...verdicts].sort(), [...VERDICTS].sort());
  const fetchers = new Set(FIXTURES.cases.map((c) => c.fetcher));
  assert.deepEqual([...fetchers].sort(), [...FETCHERS].sort());
});

for (const fixture of FIXTURES.cases) {
  test(`A: ${fixture.name}`, () => {
    const input = structuredClone(fixture.input);
    const trusted = applyFetcherTrust(input, fixture.fetcher);
    const { tier, ...expected } = fixture.expected;

    assert.equal(confidenceTier(trusted.confidence), tier);
    assert.deepEqual(tierVerdict(trusted), expected);
    // Pure: the caller's verdict object is never mutated.
    assert.deepEqual(input, fixture.input);
  });
}

test("A: non-API evidence can never settle in the high tier", () => {
  for (const fetcher of FETCHERS.filter((f) => f !== "coingecko-api")) {
    for (let confidence = 0; confidence <= 100; confidence++) {
      for (const verdict of DECISIVE) {
        const trusted = applyFetcherTrust({ verdict, confidence, explanation: "x" }, fetcher);
        assert.ok(trusted.confidence <= MAX_CONFIDENCE_NON_API, `${fetcher} ${confidence}`);
        assert.notEqual(confidenceTier(trusted.confidence), "high", `${fetcher} ${confidence}`);
        const settled = tierVerdict(trusted);
        assert.ok(
          settled.verdict === "UNRESOLVABLE" || settled.explanation.startsWith(CONTESTED_TAG),
          `${fetcher} ${verdict} ${confidence} settled firm`,
        );
      }
    }
  }
});

// ── B. Tier boundaries ────────────────────────────────────────────────────────

test("B: thresholds are the documented 80 / 60 and the fetcher cap is 75", () => {
  assert.equal(CONFIDENCE_HIGH_MIN, 80);
  assert.equal(CONFIDENCE_MED_MIN, 60);
  assert.equal(MAX_CONFIDENCE_NON_API, 75);
});

test("B: confidenceTier boundaries are inclusive at the lower bound", () => {
  const table: Array<[number, ConfidenceTier]> = [
    [100, "high"], [80, "high"], [79.99, "medium"], [79, "medium"],
    [60, "medium"], [59.99, "low"], [59, "low"], [0, "low"],
  ];
  for (const [confidence, tier] of table) {
    assert.equal(confidenceTier(confidence), tier, `confidence ${confidence}`);
  }
});

test("B: a decisive verdict is never flipped to the other side", () => {
  for (const verdict of DECISIVE) {
    for (let confidence = 0; confidence <= 100; confidence++) {
      const out = tierVerdict({ verdict, confidence, explanation: "e" }).verdict;
      assert.ok(out === verdict || out === "UNRESOLVABLE", `${verdict} ${confidence} → ${out}`);
    }
  }
});

test("B: DRAW and UNRESOLVABLE are never tiered", () => {
  for (const verdict of ["DRAW", "UNRESOLVABLE"] as const) {
    for (const confidence of [0, 59, 60, 79, 80, 100]) {
      const input: VerdictPayload = { verdict, confidence, explanation: "e" };
      assert.equal(tierVerdict(input), input);
    }
  }
});

// ── C. Negative: malformed confidence ─────────────────────────────────────────

test("C: NaN or negative confidence on a decisive verdict is refunded, never paid out", () => {
  for (const bad of [Number.NaN, -1, -50]) {
    for (const verdict of DECISIVE) {
      assert.equal(confidenceTier(bad), "low", String(bad));
      const out = tierVerdict({ verdict, confidence: bad, explanation: "Odd input." });
      assert.equal(out.verdict, "UNRESOLVABLE", `${verdict} ${bad}`);
      assert.equal(out.explanation, `${LOW_CONFIDENCE_TAG} Odd input.`);
    }
  }
});

test("C: the fetcher cap never raises confidence", () => {
  for (const confidence of [0, 10, 75, 76, 100]) {
    const trusted = applyFetcherTrust({ verdict: "CREATOR_WINS", confidence, explanation: "e" }, "jina");
    assert.equal(trusted.confidence, Math.min(confidence, MAX_CONFIDENCE_NON_API));
  }
});

// ── D. Summary tags vs. the receipt UI ────────────────────────────────────────

test("D: tags still match the substrings SettlementExplanationCard looks for", () => {
  const ui = readFileSync(join(process.cwd(), "components", "SettlementExplanationCard.tsx"), "utf8");
  assert.ok(ui.includes('"[CONTESTED]"'), "UI no longer matches [CONTESTED]");
  assert.ok(ui.includes('"[LOW CONFIDENCE"'), "UI no longer matches [LOW CONFIDENCE");
  assert.equal(CONTESTED_TAG, "[CONTESTED]");
  assert.ok(LOW_CONFIDENCE_TAG.startsWith("[LOW CONFIDENCE"));
});

test("D: tagged explanations stay within the 500-char summary cap", () => {
  const long = "a".repeat(600);
  for (const confidence of [70, 10]) {
    const out = tierVerdict({ verdict: "CREATOR_WINS", confidence, explanation: long });
    assert.equal(out.explanation.length, MAX_EXPLANATION_CHARS);
  }
  const trusted = applyFetcherTrust({ verdict: "CREATOR_WINS", confidence: 90, explanation: long }, "jina");
  assert.equal(trusted.explanation.length, MAX_EXPLANATION_CHARS);
});

// ── E. Regression vs. the original oracle implementation ─────────────────────

// Verbatim copies of the helpers as they lived in agents/oracle/index.ts before
// #97, kept here only to prove the extraction changed nothing.
function legacyTierVerdict(verdict: VerdictPayload): VerdictPayload {
  if (verdict.verdict === "UNRESOLVABLE" || verdict.verdict === "DRAW") return verdict;
  if (verdict.confidence >= 80) return verdict;
  if (verdict.confidence >= 60) {
    return { ...verdict, explanation: `[CONTESTED] ${verdict.explanation}`.slice(0, 500) };
  }
  return {
    verdict: "UNRESOLVABLE",
    confidence: verdict.confidence,
    explanation: `[LOW CONFIDENCE — refunded] ${verdict.explanation}`.slice(0, 500),
  };
}

function legacyApplyFetcherTrust(verdict: VerdictPayload, fetcher: Fetcher): VerdictPayload {
  if (fetcher === "coingecko-api") return verdict;
  if (verdict.verdict === "UNRESOLVABLE") return verdict;
  const cappedConfidence = Math.min(verdict.confidence, 75);
  const tag = fetcher === "jina" ? "[via-jina]" : fetcher === "direct" ? "[via-scrape]" : "[no-fetch]";
  return { ...verdict, confidence: cappedConfidence, explanation: `${tag} ${verdict.explanation}`.slice(0, 500) };
}

test("E: identical on-chain payload to the legacy helpers for every input", () => {
  const confidences = [Number.NaN, -1, 59.5, 79.5, 101];
  for (let c = 0; c <= 100; c++) confidences.push(c);

  for (const fetcher of FETCHERS) {
    for (const verdict of VERDICTS) {
      for (const confidence of confidences) {
        const input: VerdictPayload = { verdict, confidence, explanation: "Evidence summary." };
        const label = `${fetcher} ${verdict} ${confidence}`;
        assert.deepEqual(applyFetcherTrust(input, fetcher), legacyApplyFetcherTrust(input, fetcher), label);
        assert.deepEqual(
          tierVerdict(applyFetcherTrust(input, fetcher)),
          legacyTierVerdict(legacyApplyFetcherTrust(input, fetcher)),
          label,
        );
      }
    }
  }
});
