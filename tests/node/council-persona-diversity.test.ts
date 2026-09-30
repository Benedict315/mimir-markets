import assert from "node:assert/strict";
import test from "node:test";

import {
  COUNCIL_PERSONAS,
  configureCouncilPersonaRegistry,
  listCouncilPersonas,
  resetCouncilPersonaRegistry,
} from "../../agents/council/personas";
import type { PersonaSpec } from "../../agents/council/personas";

// ── helpers ───────────────────────────────────────────────────────────────────

function makePersona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    slug: "test-persona",
    displayName: "Test Persona",
    emoji: "🧪",
    bio: "A test persona.",
    longBio: "A longer test persona description.",
    archetype: "llm-biased",
    minConfidence: 75,
    stakeUsdc: 2,
    accent: {
      border: "border-gray-400/40",
      bg: "bg-gray-400/[0.06]",
      text: "text-gray-600",
      chip: "border-gray-400/40 bg-gray-400/[0.10] text-gray-700",
    },
    ...overrides,
  };
}

// ── positive: built-in roster passes ──────────────────────────────────────────

test("positive: built-in classic personas pass diversity validation", () => {
  assert.ok(COUNCIL_PERSONAS.length >= 6, "expect at least 6 classic personas");
  for (const p of COUNCIL_PERSONAS) {
    assert.ok(p.slug.length > 0, `slug empty for ${p.displayName}`);
    assert.ok(p.emoji.length > 0, `emoji empty for ${p.displayName}`);
    assert.ok(p.displayName.length > 0, `displayName empty for ${p.slug}`);
  }
});

// ── negative: malformed specs are rejected ────────────────────────────────────

test("negative: empty slug throws", () => {
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ slug: "" })] }),
    /invalid council persona registry slug/,
  );
});

test("negative: non-kebab-case slug throws", () => {
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ slug: "CamelCase" })] }),
    /kebab-case/,
  );
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ slug: "under_score" })] }),
    /kebab-case/,
  );
});

test("negative: invalid archetype throws", () => {
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [makePersona({ archetype: "quantum-entangled" as any })],
      }),
    /invalid archetype/,
  );
});

test("negative: duplicate slug throws", () => {
  const p = makePersona({ slug: "alpha" });
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [p, { ...p, slug: "alpha" }],
      }),
    /invalid council persona registry slug/,
  );
});

test("negative: duplicate emoji throws", () => {
  const p = makePersona({ slug: "alpha", emoji: "🌟" });
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [p, { ...p, slug: "beta", displayName: "Beta" }],
      }),
    /duplicate council persona emoji/,
  );
});

test("negative: duplicate displayName throws", () => {
  const p = makePersona({ slug: "alpha", displayName: "Same Name" });
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [p, { ...p, slug: "beta", emoji: "🌟" }],
      }),
    /duplicate council persona displayName/,
  );
});

test("negative: duplicate promptBias throws", () => {
  const bias = "I am a unique bias.";
  const p = makePersona({ slug: "alpha", archetype: "llm-biased", promptBias: bias });
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [p, { ...p, slug: "beta", displayName: "Beta", emoji: "🌟" }],
      }),
    /duplicate council persona promptBias/,
  );
});

test("negative: empty required string fields throw", () => {
  const base = makePersona();
  for (const field of ["displayName", "emoji", "bio", "longBio"] as const) {
    const bad = { ...base, slug: `bad-${field.toLowerCase()}`, [field]: "" };
    assert.throws(
      () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [bad] }),
      new RegExp(`persona field '${field}'`),
      `expected throw for empty ${field}`,
    );
  }
});

test("negative: invalid ruleEvaluator throws", () => {
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [makePersona({ archetype: "rule-based", ruleEvaluator: "telepathic" as any })],
      }),
    /invalid ruleEvaluator/,
  );
});

test("negative: invalid categoryFilter entry throws", () => {
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [makePersona({ categoryFilter: ["", "crypto"] })],
      }),
    /categoryFilter entries must be non-empty strings/,
  );
});

test("negative: empty categoryFilter array throws", () => {
  assert.throws(
    () =>
      configureCouncilPersonaRegistry({
        listClassicPersonas: () => [makePersona({ categoryFilter: [] })],
      }),
    /categoryFilter must be a non-empty array when present/,
  );
});

test("negative: minConfidence out of range throws", () => {
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ minConfidence: -1 })] }),
    /minConfidence must be 0\.\.100/,
  );
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ minConfidence: 101 })] }),
    /minConfidence must be 0\.\.100/,
  );
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ minConfidence: 75.5 })] }),
    /minConfidence must be 0\.\.100/,
  );
});

test("negative: non-positive stakeUsdc throws", () => {
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ stakeUsdc: 0 })] }),
    /stakeUsdc must be a positive number/,
  );
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [makePersona({ stakeUsdc: -1 })] }),
    /stakeUsdc must be a positive number/,
  );
});

test("negative: missing accent throws", () => {
  const bad = { ...makePersona(), accent: undefined as any };
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [bad] }),
    /accent must be an object/,
  );
});

test("negative: empty accent fields throw", () => {
  const bad = makePersona({ accent: { ...makePersona().accent, border: "" } });
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [bad] }),
    /accent\.border/,
  );
});

// ── boundary ──────────────────────────────────────────────────────────────────

test("boundary: minConfidence at extremes passes", () => {
  configureCouncilPersonaRegistry({
    listClassicPersonas: () => [
      makePersona({ slug: "lo", minConfidence: 0 }),
      makePersona({ slug: "hi", minConfidence: 100, displayName: "Hi Conf", emoji: "🔝" }),
    ],
  });
  const slugs = listCouncilPersonas().map((p) => p.slug);
  assert.ok(slugs.includes("lo"));
  assert.ok(slugs.includes("hi"));
  resetCouncilPersonaRegistry();
});

test("boundary: small and large stakeUsdc values pass", () => {
  configureCouncilPersonaRegistry({
    listClassicPersonas: () => [
      makePersona({ slug: "micro", stakeUsdc: 0.01, displayName: "Micro", emoji: "🔬" }),
      makePersona({ slug: "big", stakeUsdc: 10, displayName: "Big Stake", emoji: "💰" }),
    ],
  });
  const slugs = listCouncilPersonas().map((p) => p.slug);
  assert.ok(slugs.includes("micro"));
  assert.ok(slugs.includes("big"));
  resetCouncilPersonaRegistry();
});

// ── regression ────────────────────────────────────────────────────────────────

test("regression: existing configureCouncilPersonaRegistry slug check preserved", () => {
  const first = COUNCIL_PERSONAS[0]!;
  configureCouncilPersonaRegistry({ listClassicPersonas: () => [first] });
  assert.deepEqual(listCouncilPersonas().map((p) => p.slug), [first.slug]);
  assert.throws(
    () => configureCouncilPersonaRegistry({ listClassicPersonas: () => [first, first] }),
    /invalid council persona registry slug/,
  );
  resetCouncilPersonaRegistry();
  assert.equal(listCouncilPersonas().length, COUNCIL_PERSONAS.length);
});
