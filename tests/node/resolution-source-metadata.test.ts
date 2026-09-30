import assert from "node:assert/strict";
import test from "node:test";

import { formatSettlementRuleWithSourceMetadata } from "../../lib/resolutionSourceMetadata";

test("regression: empty source metadata preserves the settlement rule exactly", () => {
  const rule = "  Resolve against the final published result.  ";
  assert.equal(
    formatSettlementRuleWithSourceMetadata(rule, {
      sourceType: "",
      resolutionTarget: "",
    }),
    rule
  );
});

test("positive: source type and resolution target serialize into the on-chain rule", () => {
  assert.equal(
    formatSettlementRuleWithSourceMetadata("Use the final result.", {
      sourceType: "official",
      resolutionTarget: "The published final score",
    }),
    "Use the final result.\n\nResolution source metadata (creator-provided, unverified):\nSource type: official\nResolution target: The published final score"
  );
});

test("boundary: metadata can be added when no separate settlement rule is present", () => {
  assert.equal(
    formatSettlementRuleWithSourceMetadata("", {
      sourceType: "media",
      resolutionTarget: "",
    }),
    "Resolution source metadata (creator-provided, unverified):\nSource type: media"
  );
});

test("negative: whitespace-only resolution targets are omitted", () => {
  assert.equal(
    formatSettlementRuleWithSourceMetadata("Rule", {
      sourceType: "",
      resolutionTarget: " \n ",
    }),
    "Rule"
  );
});