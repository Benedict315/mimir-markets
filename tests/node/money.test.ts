import assert from "node:assert/strict";
import test from "node:test";

import { formatUsdc, formatUsdcBare } from "../../lib/money";

// ── formatUsdc: non-finite and zero ──────────────────────────────────────────

test("formatUsdc returns '0 USDC' for NaN", () => {
  assert.equal(formatUsdc(NaN), "0 USDC");
});

test("formatUsdc returns '0 USDC' for Infinity", () => {
  assert.equal(formatUsdc(Infinity), "0 USDC");
});

test("formatUsdc returns '0 USDC' for -Infinity", () => {
  assert.equal(formatUsdc(-Infinity), "0 USDC");
});

test("formatUsdc returns '0 USDC' for 0", () => {
  assert.equal(formatUsdc(0), "0 USDC");
});

// ── formatUsdc: sub-micro sentinel ───────────────────────────────────────────

test("formatUsdc returns '<0.000001 USDC' for values below 0.000001", () => {
  assert.equal(formatUsdc(0.0000001), "<0.000001 USDC");
  assert.equal(formatUsdc(0.0000009), "<0.000001 USDC");
  assert.equal(formatUsdc(0.00000099999), "<0.000001 USDC");
});

test("formatUsdc returns '<0.000001 USDC' for negative values below 0.000001 in abs", () => {
  assert.equal(formatUsdc(-0.0000001), "<0.000001 USDC");
  assert.equal(formatUsdc(-0.0000009), "<0.000001 USDC");
});

// ── formatUsdc: sub-1 range (0.000001 ≤ abs < 1) ─────────────────────────────

test("formatUsdc formats values in [0.000001, 1) without trailing zeros", () => {
  const result = formatUsdc(0.5);
  assert.match(result, / USDC$/);
  assert.ok(!result.startsWith("<"), "should not use the sentinel");
  // No trailing zeros — trimFixed is applied
  assert.ok(!result.match(/\.?0+ USDC$/), "trailing zeros must be stripped");
});

test("formatUsdc handles negative sub-1 values", () => {
  const result = formatUsdc(-0.5);
  assert.match(result, / USDC$/);
  assert.ok(result.startsWith("-"), "negative sign must be preserved");
});

test("formatUsdc at exactly 0.000001 does not use the sentinel", () => {
  const result = formatUsdc(0.000001);
  assert.ok(!result.startsWith("<"), "exact boundary is not sentinel");
  assert.match(result, / USDC$/);
});

// ── formatUsdc: values ≥ 1 ────────────────────────────────────────────────────

test("formatUsdc returns locale-formatted string with 2 decimal places for values >= 1", () => {
  assert.equal(formatUsdc(1234.5), "1,234.50 USDC");
});

test("formatUsdc preserves sign for negative values >= 1 in abs", () => {
  assert.equal(formatUsdc(-1234.5), "-1,234.50 USDC");
});

test("formatUsdc at exactly 1.0 has 2 decimal places", () => {
  assert.equal(formatUsdc(1), "1.00 USDC");
});

test("formatUsdc uses comma-separated thousands", () => {
  assert.match(formatUsdc(1000000), /1,000,000/);
});

// ── formatUsdcBare ─────────────────────────────────────────────────────────────

test("formatUsdcBare returns '1,234.5' for 1234.5 with no trailing zero", () => {
  assert.equal(formatUsdcBare(1234.5), "1,234.5");
});

test("formatUsdcBare returns '1,234' for whole numbers without decimal", () => {
  assert.equal(formatUsdcBare(1234), "1,234");
});

test("formatUsdcBare returns '0' for NaN", () => {
  assert.equal(formatUsdcBare(NaN), "0");
});

test("formatUsdcBare returns '0' for Infinity", () => {
  assert.equal(formatUsdcBare(Infinity), "0");
});

test("formatUsdcBare returns '0' for values below 0.000001 (rounds to 0 by formatter)", () => {
  // Values smaller than 10^-7 have no representable USDC value; the formatter
  // has maximumFractionDigits: 2, so 0.0000001 rounds to "0".
  assert.equal(formatUsdcBare(0.0000001), "0");
});

test("formatUsdcBare rounds to 2 decimal places maximum", () => {
  // 1234.567 → "1,234.57" (2dp max)
  assert.equal(formatUsdcBare(1234.567), "1,234.57");
});
