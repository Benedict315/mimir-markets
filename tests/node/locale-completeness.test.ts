/**
 * tests/node/locale-completeness.test.ts
 *
 * Deterministic test suite for the locale completeness library.
 *
 * Fixture files are loaded from tests/fixtures/locales/ and never require
 * production secrets or a network connection.  This file is picked up
 * automatically by scripts/run-node-tests.mjs (scans tests/node/*.test.ts).
 *
 * Coverage
 * ────────
 * Positive  — complete translation, extra keys only, English self-check.
 * Negative  — missing non-funded keys, missing funded keys.
 * Funded    — hard violation flag, correct namespace list.
 * Untranslated — strings identical to the English baseline.
 * Aggregate — checkAll helper, report flags, multi-locale map.
 * Regression — flattenKeys handles arrays, deeply-nested objects, empty obj.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  FUNDED_NAMESPACES,
  checkAll,
  checkLocale,
  flattenKeys,
} from "../../lib/locale-completeness";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const FIXTURES = join(process.cwd(), "tests", "fixtures", "locales");

function load(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), "utf8")
  ) as Record<string, unknown>;
}

const baseline = load("en");
const complete = load("complete");
const missingKeys = load("missing-keys");
const extraKeys = load("extra-keys");
const missingFunded = load("missing-funded");
const untranslated = load("untranslated");

// ── flattenKeys ───────────────────────────────────────────────────────────────

test("flattenKeys — produces sorted dot-separated leaf paths", () => {
  const obj = { b: { y: 1, x: 2 }, a: { z: "v" } };
  assert.deepEqual(flattenKeys(obj), ["a.z", "b.x", "b.y"]);
});

test("flattenKeys — treats arrays as atomic leaves (no index expansion)", () => {
  const obj = { items: [1, 2, 3], other: "x" };
  const keys = flattenKeys(obj);
  assert.ok(keys.includes("items"), "array key should be present");
  assert.ok(!keys.includes("items.0"), "array indices should not be expanded");
  assert.equal(keys.length, 2);
});

test("flattenKeys — handles deeply nested objects", () => {
  const obj = { a: { b: { c: { d: "leaf" } } } };
  assert.deepEqual(flattenKeys(obj), ["a.b.c.d"]);
});

test("flattenKeys — returns empty array for empty object", () => {
  assert.deepEqual(flattenKeys({}), []);
});

test("flattenKeys — null values are treated as leaves", () => {
  const obj = { x: null, y: "str" };
  const keys = flattenKeys(obj as Record<string, unknown>);
  assert.deepEqual(keys, ["x", "y"]);
});

// ── FUNDED_NAMESPACES ─────────────────────────────────────────────────────────

test("FUNDED_NAMESPACES includes all money-touching namespaces", () => {
  // These namespaces surface strings immediately before or during USDC flows.
  // Missing any of them is a hard deployment blocker.
  for (const ns of ["create", "dashboard", "home", "vsDetail", "wallet"]) {
    assert.ok(
      FUNDED_NAMESPACES.has(ns),
      `FUNDED_NAMESPACES must include "${ns}"`
    );
  }
});

test("FUNDED_NAMESPACES does not include purely informational namespaces", () => {
  for (const ns of ["metadata", "footer", "categories", "badges", "stamp"]) {
    assert.ok(
      !FUNDED_NAMESPACES.has(ns),
      `FUNDED_NAMESPACES should not include "${ns}"`
    );
  }
});

// ── checkLocale — positive cases ──────────────────────────────────────────────

test("complete translation: no missing, no extra, no funded violation", () => {
  const result = checkLocale(baseline, "es", complete);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.equal(result.hasFundedViolation, false);
  assert.deepEqual(result.missingFunded, []);
  assert.equal(result.locale, "es");
});

test("complete translation: no untranslated strings", () => {
  const result = checkLocale(baseline, "es", complete);
  assert.deepEqual(result.untranslated, []);
});

test("English self-check: produces no missing or extra (baseline vs baseline)", () => {
  // Running en against en should be clean — also validates no untranslated
  // detection fires for the baseline locale itself.
  const result = checkLocale(baseline, "en", baseline);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.deepEqual(result.untranslated, [], "en self-check must not flag untranslated");
});

// ── checkLocale — extra keys ──────────────────────────────────────────────────

test("extra keys: detected and reported, not treated as a funded violation", () => {
  const result = checkLocale(baseline, "es", extraKeys);
  assert.ok(result.extra.length > 0, "extra keys should be detected");
  assert.ok(
    result.extra.includes("common.obsoleteKey"),
    "specific obsolete key should appear in extra"
  );
  // Extra keys are not funded violations — the translation covers all baseline keys.
  assert.equal(result.hasFundedViolation, false);
  assert.deepEqual(result.missing, []);
});

test("extra keys: hasFundedViolation is false when only extra keys present", () => {
  const result = checkLocale(baseline, "es", extraKeys);
  assert.equal(result.hasFundedViolation, false);
  assert.deepEqual(result.missingFunded, []);
});

// ── checkLocale — missing non-funded keys ─────────────────────────────────────

test("missing non-funded keys: reported in missing array", () => {
  const result = checkLocale(baseline, "es", missingKeys);
  // missingKeys fixture drops common.connect and common.loading (non-funded namespace)
  assert.ok(result.missing.length > 0, "missing keys should be detected");
  assert.ok(
    result.missing.includes("common.loading"),
    "common.loading should be reported missing"
  );
});

test("missing non-funded keys: hasFundedViolation is false when only common keys missing", () => {
  // The missingKeys fixture only drops common.connect and common.loading —
  // neither is in a funded namespace.
  const result = checkLocale(baseline, "es", missingKeys);
  assert.equal(result.hasFundedViolation, false);
  assert.deepEqual(result.missingFunded, []);
});

// ── checkLocale — funded violations ───────────────────────────────────────────

test("missing funded key: hasFundedViolation is true", () => {
  const result = checkLocale(baseline, "es", missingFunded);
  assert.equal(result.hasFundedViolation, true);
});

test("missing funded key: reported in both missing and missingFunded", () => {
  const result = checkLocale(baseline, "es", missingFunded);
  // missingFunded fixture drops dashboard.copyEnable
  assert.ok(
    result.missingFunded.includes("dashboard.copyEnable"),
    "dashboard.copyEnable must appear in missingFunded"
  );
  assert.ok(
    result.missing.includes("dashboard.copyEnable"),
    "dashboard.copyEnable must also appear in missing"
  );
});

test("missingFunded is a strict subset of missing", () => {
  const result = checkLocale(baseline, "es", missingFunded);
  for (const k of result.missingFunded) {
    assert.ok(
      result.missing.includes(k),
      `missingFunded key "${k}" must also appear in missing`
    );
  }
});

test("funded violation: all missingFunded keys belong to FUNDED_NAMESPACES", () => {
  const result = checkLocale(baseline, "es", missingFunded);
  for (const k of result.missingFunded) {
    const ns = k.split(".")[0] ?? "";
    assert.ok(
      FUNDED_NAMESPACES.has(ns),
      `"${k}" is in missingFunded but namespace "${ns}" is not FUNDED`
    );
  }
});

// ── checkLocale — untranslated detection ──────────────────────────────────────

test("untranslated: strings identical to English baseline are flagged", () => {
  // untranslated fixture keeps common.loading and home.tagline in English
  const result = checkLocale(baseline, "es", untranslated);
  assert.ok(result.untranslated.length > 0, "untranslated keys should be detected");
  assert.ok(
    result.untranslated.includes("common.loading"),
    "common.loading (identical to English) should be flagged"
  );
});

test("untranslated: genuinely translated strings are not flagged", () => {
  const result = checkLocale(baseline, "es", untranslated);
  // common.back is translated to "Atrás" — must not appear
  assert.ok(
    !result.untranslated.includes("common.back"),
    "translated key 'common.back' must not appear in untranslated"
  );
});

test("untranslated: hasFundedViolation remains false when all funded keys present but some untranslated", () => {
  // untranslated fixture has all funded keys present, just some values identical to English
  const result = checkLocale(baseline, "es", untranslated);
  assert.equal(result.missing.length, 0);
  assert.equal(result.hasFundedViolation, false);
});

test("untranslated detection is skipped for the English baseline locale", () => {
  const result = checkLocale(baseline, "en", baseline);
  assert.deepEqual(result.untranslated, []);
});

// ── checkAll — aggregate report ───────────────────────────────────────────────

test("checkAll: empty locale map produces clean report", () => {
  const report = checkAll(baseline, new Map());
  assert.deepEqual(report.results, []);
  assert.equal(report.hasErrors, false);
  assert.equal(report.hasFundedErrors, false);
  assert.equal(report.baseline, "en");
});

test("checkAll: complete locale produces hasErrors=false", () => {
  const report = checkAll(baseline, new Map([["es", complete]]));
  assert.equal(report.hasErrors, false);
  assert.equal(report.hasFundedErrors, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.locale, "es");
});

test("checkAll: missing non-funded keys produce hasErrors=true, hasFundedErrors=false", () => {
  const report = checkAll(baseline, new Map([["es", missingKeys]]));
  assert.equal(report.hasErrors, true);
  assert.equal(report.hasFundedErrors, false);
});

test("checkAll: funded violation produces both hasErrors=true and hasFundedErrors=true", () => {
  const report = checkAll(baseline, new Map([["es", missingFunded]]));
  assert.equal(report.hasErrors, true);
  assert.equal(report.hasFundedErrors, true);
});

test("checkAll: multiple locales — clean and broken — sets flags correctly", () => {
  const report = checkAll(
    baseline,
    new Map<string, Record<string, unknown>>([
      ["es", complete],        // clean
      ["fr", missingFunded],   // funded violation
    ])
  );
  assert.equal(report.results.length, 2);
  assert.equal(report.hasErrors, true);
  assert.equal(report.hasFundedErrors, true);

  const esResult = report.results.find((r) => r.locale === "es");
  assert.ok(esResult);
  assert.equal(esResult.hasFundedViolation, false);
  assert.deepEqual(esResult.missing, []);

  const frResult = report.results.find((r) => r.locale === "fr");
  assert.ok(frResult);
  assert.equal(frResult.hasFundedViolation, true);
});

test("checkAll: extra-only locale does not set hasErrors (extra keys are not errors by default)", () => {
  // Extra keys are warnings, not errors — they don't block shipment.
  const report = checkAll(baseline, new Map([["es", extraKeys]]));
  assert.equal(report.hasErrors, false);
  assert.equal(report.hasFundedErrors, false);
});

// ── Regression: real en.json structure ───────────────────────────────────────

// Load the real production messages file once for regression tests.
const REAL_EN = JSON.parse(
  readFileSync(join(process.cwd(), "messages", "en.json"), "utf8")
) as Record<string, unknown>;

test("regression: real messages/en.json is parseable and has expected namespaces", () => {
  // Funded namespaces must all be present in the real message file.
  for (const ns of FUNDED_NAMESPACES) {
    assert.ok(
      ns in REAL_EN,
      `real messages/en.json is missing funded namespace "${ns}"`
    );
  }

  // Baseline key count sanity check — detect accidental truncation.
  const keys = flattenKeys(REAL_EN);
  assert.ok(
    keys.length > 100,
    `messages/en.json has suspiciously few keys (${keys.length})`
  );
});

test("regression: flattenKeys on real en.json produces no duplicate keys", () => {
  const keys = flattenKeys(REAL_EN);
  const unique = new Set(keys);
  assert.equal(
    keys.length,
    unique.size,
    "flattenKeys produced duplicate keys on real en.json"
  );
});
