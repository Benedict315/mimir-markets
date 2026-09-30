/**
 * tests/node/oracle-unresolvable-policy.test.ts
 *
 * Coverage for lib/oracle/unresolvable-policy.ts — the explicit UNRESOLVABLE
 * (refund) policy (#99), driven by synthetic verdict fixtures
 * (tests/fixtures/oracle-verdicts/unresolvable-policy.json).
 *
 *  A. Fixture outcomes (positive, boundary)
 *  B. Invalid confidence (negative)
 *  C. Only the three named reasons produce an on-chain UNRESOLVABLE
 *  D. Log labels and receipt-UI compatibility
 *  E. Regression: identical on-chain payload to the pre-#99 oracle
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  INVALID_CONFIDENCE_TAG,
  applySettlementPolicy,
  describeDecision,
  isValidConfidence,
  type SettlementOutcome,
  type TierVerdict,
  type UnresolvableReason,
} from "../../lib/oracle/unresolvable-policy";
import { VERDICTS, type VerdictPayload } from "../../lib/verdict";

interface FixtureCase {
  name: string;
  input: VerdictPayload;
  expected: VerdictPayload & { outcome: SettlementOutcome; reason?: UnresolvableReason };
}

const FIXTURES = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "oracle-verdicts", "unresolvable-policy.json"), "utf8"),
) as { cases: FixtureCase[] };

// Verbatim copy of the oracle's tierVerdict (agents/oracle/index.ts) — the tier
// step the worker passes into applySettlementPolicy.
const oracleTierVerdict: TierVerdict = (verdict) => {
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
};

const decide = (verdict: VerdictPayload) => applySettlementPolicy(verdict, oracleTierVerdict);
const DECISIVE = ["CREATOR_WINS", "CHALLENGERS_WIN"] as const;

// ── A. Fixture outcomes ───────────────────────────────────────────────────────

test("A: fixtures cover every outcome and every refund reason", () => {
  const outcomes = new Set(FIXTURES.cases.map((c) => c.expected.outcome));
  assert.deepEqual([...outcomes].sort(), ["contested", "draw", "firm", "refund"]);
  const reasons = new Set(FIXTURES.cases.map((c) => c.expected.reason).filter(Boolean));
  assert.deepEqual([...reasons].sort(), ["invalid-confidence", "low-confidence", "model-unresolvable"]);
});

for (const fixture of FIXTURES.cases) {
  test(`A: ${fixture.name}`, () => {
    const input = structuredClone(fixture.input);
    const decision = decide(input);
    const { outcome, reason, ...verdict } = fixture.expected;

    assert.equal(decision.outcome, outcome);
    assert.equal(decision.outcome === "refund" ? decision.reason : undefined, reason);
    assert.deepEqual(decision.verdict, verdict);
    // Pure: the caller's verdict object is never mutated.
    assert.deepEqual(input, fixture.input);
  });
}

test("A: a fetcher-tagged verdict is labelled by the tier, not by string diffs", () => {
  // The old log compared against the raw verdict, so any fetcher tag read as CONTESTED.
  const firm = decide({ verdict: "CREATOR_WINS", confidence: 85, explanation: "[via-jina] Confirmed." });
  assert.equal(firm.outcome, "firm");
  const quoted = decide({ verdict: "CREATOR_WINS", confidence: 90, explanation: "[CONTESTED] was the headline." });
  assert.equal(quoted.outcome, "firm");
});

// ── B. Invalid confidence ─────────────────────────────────────────────────────

test("B: isValidConfidence accepts 0–100 inclusive and nothing else", () => {
  for (const ok of [0, 0.5, 59.99, 100]) assert.equal(isValidConfidence(ok), true, String(ok));
  for (const bad of [Number.NaN, Infinity, -Infinity, -0.01, 100.01, 150]) {
    assert.equal(isValidConfidence(bad), false, String(bad));
  }
});

test("B: NaN and infinite confidence on a decisive verdict is refunded, never paid out", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    for (const verdict of DECISIVE) {
      let tierCalled = false;
      const d = applySettlementPolicy({ verdict, confidence: bad, explanation: "Odd input." }, (v) => {
        tierCalled = true;
        return v;
      });
      assert.equal(tierCalled, false, "invalid input must not reach the tier step");
      assert.equal(d.outcome, "refund");
      assert.equal(d.outcome === "refund" && d.reason, "invalid-confidence");
      assert.deepEqual(d.verdict, {
        verdict: "UNRESOLVABLE",
        confidence: 0,
        explanation: `${INVALID_CONFIDENCE_TAG} Odd input.`,
      });
    }
  }
});

test("B: a tier step that flips the winning side is refused", () => {
  const flip: TierVerdict = (v) => ({ ...v, verdict: "CHALLENGERS_WIN" });
  assert.throws(
    () => applySettlementPolicy({ verdict: "CREATOR_WINS", confidence: 90, explanation: "e" }, flip),
    /refusing to settle/,
  );
  const toDraw: TierVerdict = (v) => ({ ...v, verdict: "DRAW" });
  assert.throws(
    () => applySettlementPolicy({ verdict: "CHALLENGERS_WIN", confidence: 90, explanation: "e" }, toDraw),
    /refusing to settle/,
  );
});

// ── C. Only named reasons refund ──────────────────────────────────────────────

test("C: only the three documented reasons produce an on-chain UNRESOLVABLE", () => {
  const seen = new Set<string>();
  for (const verdict of VERDICTS) {
    for (const confidence of [Number.NaN, -1, 0, 59, 60, 79, 80, 100, 101]) {
      const d = decide({ verdict, confidence, explanation: "e" });
      if (d.verdict.verdict === "UNRESOLVABLE") {
        assert.equal(d.outcome, "refund", `${verdict} ${confidence}`);
        if (d.outcome === "refund") seen.add(d.reason);
      } else {
        assert.notEqual(d.outcome, "refund", `${verdict} ${confidence}`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["invalid-confidence", "low-confidence", "model-unresolvable"]);
});

test("C: a decisive verdict is never flipped to the other side", () => {
  for (const verdict of DECISIVE) {
    for (let confidence = 0; confidence <= 100; confidence++) {
      const out = decide({ verdict, confidence, explanation: "e" }).verdict.verdict;
      assert.ok(out === verdict || out === "UNRESOLVABLE", `${verdict} ${confidence} → ${out}`);
    }
  }
});

// ── D. Log labels and receipt UI ──────────────────────────────────────────────

test("D: describeDecision names the outcome and refund reason for logs", () => {
  const cases: Array<[VerdictPayload, string]> = [
    [{ verdict: "CREATOR_WINS", confidence: 90, explanation: "" }, "FIRM"],
    [{ verdict: "CREATOR_WINS", confidence: 70, explanation: "" }, "CONTESTED"],
    [{ verdict: "DRAW", confidence: 70, explanation: "" }, "DRAW"],
    [{ verdict: "CREATOR_WINS", confidence: 10, explanation: "" }, "REFUND(low-confidence)"],
    [{ verdict: "UNRESOLVABLE", confidence: 90, explanation: "" }, "REFUND(model-unresolvable)"],
    [{ verdict: "CHALLENGERS_WIN", confidence: Number.NaN, explanation: "" }, "REFUND(invalid-confidence)"],
  ];
  for (const [input, label] of cases) assert.equal(describeDecision(decide(input)), label);
});

test("D: invalid-confidence receipts still render as refunded in the UI", () => {
  const ui = readFileSync(join(process.cwd(), "components", "SettlementExplanationCard.tsx"), "utf8");
  assert.ok(ui.includes('"[LOW CONFIDENCE"'), "UI no longer matches [LOW CONFIDENCE");
  assert.ok(INVALID_CONFIDENCE_TAG.startsWith("[LOW CONFIDENCE"));
});

test("D: invalid-confidence summaries stay within the 500-char cap", () => {
  const d = decide({ verdict: "CREATOR_WINS", confidence: 150, explanation: "a".repeat(600) });
  assert.equal(d.verdict.explanation.length, 500);
});

// ── E. Regression vs. the pre-#99 oracle ─────────────────────────────────────

test("E: identical on-chain payload to tierVerdict alone for every valid confidence", () => {
  for (const verdict of VERDICTS) {
    for (let confidence = 0; confidence <= 100; confidence += 0.5) {
      const input: VerdictPayload = { verdict, confidence, explanation: "Evidence summary." };
      assert.deepEqual(decide(input).verdict, oracleTierVerdict(input), `${verdict} ${confidence}`);
    }
  }
});
