import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLAIM_DRAFT_CATEGORY_IDS,
  CLAIM_DRAFT_MAX_CANDIDATES,
} from "../../lib/claimDrafts";
import {
  getGeminiDraftSchema,
  sanitizeGeneratedDrafts,
} from "../../lib/server/source-claim-generator";

const fixtureCases = JSON.parse(
  readFileSync(new URL("../fixtures/claim-draft-schema-cases.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const schema = JSON.parse(
  readFileSync(new URL("../../schemas/claim-draft-v1.schema.json", import.meta.url), "utf8"),
) as Record<string, any>;
const referenceTime = Date.parse("2040-01-01T00:00:00.000Z");
const sourceUrl = "https://example.com/newsroom";

function sanitize(caseName: string) {
  return sanitizeGeneratedDrafts({
    sourceUrl,
    sourceType: "official",
    now: referenceTime,
    payload: fixtureCases[caseName] as Parameters<typeof sanitizeGeneratedDrafts>[0]["payload"],
  });
}

function matchesClosedObjectSchema(node: Record<string, any>, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const properties = node.properties as Record<string, unknown>;
  if (node.additionalProperties === false && Object.keys(record).some((key) => !(key in properties))) {
    return false;
  }
  return (node.required as string[]).every((key) => key in record);
}

test("claim-draft model receives the checked-in strict schema", () => {
  assert.deepEqual(getGeminiDraftSchema(), schema);
  assert.deepEqual(schema.properties.candidates.items.properties.category.enum, CLAIM_DRAFT_CATEGORY_IDS);
  assert.equal(schema.properties.candidates.maxItems, CLAIM_DRAFT_MAX_CANDIDATES);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);
});

test("strict schema fixtures reject sensitive, unknown fields", () => {
  const sensitiveExtras = fixtureCases.sensitiveExtras as Record<string, unknown>;
  const candidateSchema = schema.properties.candidates.items;

  assert.equal(matchesClosedObjectSchema(schema, fixtureCases.valid), true);
  assert.equal(matchesClosedObjectSchema(schema, sensitiveExtras), false);
  assert.equal(
    matchesClosedObjectSchema(candidateSchema, (sensitiveExtras.candidates as unknown[])[0]),
    false,
  );
  for (const field of ["prompt", "analytics", "walletAddress", "stakeUsdc", "permissions"]) {
    assert.equal(field in schema.properties, false, `${field} must not enter the model contract`);
    assert.equal(field in candidateSchema.properties, false, `${field} must not enter a candidate`);
  }
});

test("accepts a valid deterministic claim-draft fixture", () => {
  const result = sanitize("valid");

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.deadlineAt, "2040-02-01T00:00:00.000Z");
  assert.equal(result.candidates[0]?.confidenceScore, 100);
});

test("drops malformed candidates without leaking model fields", () => {
  assert.deepEqual(sanitize("invalid").candidates, []);

  const result = sanitize("sensitiveExtras");
  assert.deepEqual(Object.keys(result).sort(), [
    "candidates",
    "rejectionReason",
    "sourceSummary",
    "sourceType",
    "sourceUrl",
  ]);
  assert.deepEqual(Object.keys(result.candidates[0] ?? {}).sort(), [
    "ambiguityFlags",
    "category",
    "claimText",
    "confidenceScore",
    "deadlineAt",
    "primaryResolutionSource",
    "settlementRule",
    "sideA",
    "sideB",
    "timezone",
  ]);
});

test("rejects a deadline equal to the reference time as stale", () => {
  assert.deepEqual(sanitize("stale").candidates, []);
});

test("keeps only the first case-insensitive claim and caps output to the contract limit", () => {
  const duplicateResult = sanitize("duplicates");
  assert.equal(duplicateResult.candidates.length, 1);
  assert.equal(duplicateResult.candidates[0]?.confidenceScore, 80);

  const overLimitResult = sanitize("overLimit");
  assert.equal(overLimitResult.candidates.length, CLAIM_DRAFT_MAX_CANDIDATES);
  assert.match(overLimitResult.candidates.at(-1)?.claimText ?? "", /update three/);
});