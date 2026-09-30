/**
 * The schema subset validator must be honest about what it does not check.
 *
 * These tests are mostly about failing closed: a validator that quietly ignores
 * `patternProperties` would let an example with a misspelled field pass, and the
 * published contract would then be wrong in a way no review would catch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonSchemaError,
  SUPPORTED_KEYWORDS,
  assertSupportedKeywords,
  validateAgainstSchema,
} from "../../lib/ops/json-schema-subset";

function ok(schema: Record<string, unknown>, value: unknown): void {
  const result = validateAgainstSchema(schema, value);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
}

function bad(schema: Record<string, unknown>, value: unknown, match: RegExp): void {
  const result = validateAgainstSchema(schema, value);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length > 0, true);
  assert.match(result.errors.join("; "), match);
}

test("accepts the supported keywords and rejects the rest", () => {
  // minProperties is an ordinary, perfectly reasonable keyword, and it is not
  // implemented here — so it must be refused rather than quietly ignored.
  assert.throws(() => assertSupportedKeywords({ type: "object", minProperties: 1 }), JsonSchemaError);
  assert.throws(() => assertSupportedKeywords({ patternProperties: {} }), JsonSchemaError);
  assert.throws(() => assertSupportedKeywords({ $ref: "#/x" }), JsonSchemaError);
  assert.throws(() => assertSupportedKeywords({ properties: { a: { anyOf: [{ exclusiveMinimum: 1 }] } } }), JsonSchemaError);
  assert.doesNotThrow(() => assertSupportedKeywords({
    type: "object",
    required: ["a"],
    properties: { a: { type: "string", minLength: 1 } },
    additionalProperties: false,
  }));
  assert.equal(SUPPORTED_KEYWORDS.includes("patternProperties"), false);
});

test("the keyword check names the keyword it refused", () => {
  assert.throws(
    () => assertSupportedKeywords({ properties: { a: { multipleOf: 2 } } }),
    (error: unknown) => {
      assert.ok(error instanceof JsonSchemaError);
      assert.match(error.message, /multipleOf/);
      return true;
    },
  );
});

test("a schema that is not an object is refused", () => {
  assert.throws(() => assertSupportedKeywords({ not: "a schema" }), JsonSchemaError);
  assert.throws(() => assertSupportedKeywords({ properties: { a: 1 } }), JsonSchemaError);
});

test("validates types, including a list of types", () => {
  ok({ type: "string" }, "s");
  bad({ type: "string" }, 1, /expected string/);
  ok({ type: ["string", "null"] }, null);
  bad({ type: ["string", "null"] }, 3, /expected string or null/);
  ok({ type: "integer" }, 7);
  bad({ type: "integer" }, 7.5, /expected integer/);
  ok({ type: "number" }, 7.5);
  bad({ type: "object" }, [], /expected object/);
  bad({ type: "array" }, {}, /expected array/);
});

test("validates const, enum and length", () => {
  ok({ const: "v1" }, "v1");
  bad({ const: "v1" }, "v2", /must equal "v1"/);
  ok({ enum: ["a", "b"] }, "b");
  bad({ enum: ["a", "b"] }, "c", /must be one of/);
  bad({ type: "string", minLength: 2 }, "a", /at least 2 characters/);
  bad({ type: "string", maxLength: 2 }, "abc", /at most 2 characters/);
});

test("validates a pattern", () => {
  ok({ type: "string", pattern: "^[a-z]+$" }, "abc");
  bad({ type: "string", pattern: "^[a-z]+$" }, "ABC", /must match/);
});

test("validates numeric bounds", () => {
  ok({ type: "number", minimum: 0 }, 0);
  bad({ type: "number", minimum: 1 }, 0, /must be >= 1/);
  ok({ type: "number", maximum: 2 }, 2);
  bad({ type: "number", maximum: 1 }, 2, /must be <= 1/);
});

test("an object requires its required keys and refuses unknown ones", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  ok(schema, { a: "x" });
  bad(schema, {}, /missing required property "a"/);
  bad(schema, { a: "x", b: 1 }, /unexpected property "b"/);
  // With additionalProperties left open, an extra key is allowed — that is the
  // schema's choice, not a limitation here.
  ok({ ...schema, additionalProperties: true }, { a: "x", b: 1 });
});

test("array items are validated element by element", () => {
  ok({ type: "array", items: { type: "number" } }, [1, 2]);
  bad({ type: "array", items: { type: "number" } }, [1, "2"], /\[1\]/);
  bad({ type: "array", items: { type: "number" } }, [1, 2, "3", 4], /\[2\]/);
});

test("allOf, anyOf, oneOf and not behave as written", () => {
  ok({ allOf: [{ type: "object" }, { required: ["a"] }] }, { a: 1 });
  bad({ allOf: [{ type: "object" }, { required: ["a"] }] }, { b: 1 }, /missing required property "a"/);
  ok({ anyOf: [{ type: "string" }, { type: "number" }] }, 1);
  bad({ anyOf: [{ type: "string" }, { type: "number" }] }, true, /does not match any "anyOf" subschema/);
  ok({ oneOf: [{ const: "a" }, { const: "b" }] }, "b");
  bad({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1, /matched 2 branches/);
  bad({ not: { type: "string" } }, "x", /must not match the "not" subschema/);
});

test("if/then/else applies only when the condition holds", () => {
  const schema = {
    type: "object",
    properties: { signature: { type: "string" } },
    if: { required: ["signature"] },
    then: { required: ["signature", "nonce", "signedAt", "agentId", "idempotencyKey", "version", "action"] },
  };
  // A bearer request carries no signature, so the signed-envelope branch does not apply.
  ok(schema, { version: "v1" });
  ok(schema, {
    version: "v1", action: "heartbeat", agentId: "a", idempotencyKey: "k",
    nonce: "n", signedAt: 1, signature: "sig",
  });
  bad(schema, { signature: "sig" }, /missing required property "nonce"/);
});

test("errors name the instance path, never the value", () => {
  const result = validateAgainstSchema(
    { type: "object", properties: { body: { type: "object", properties: { stakeUsdc: { type: "number" } } } } },
    { body: { stakeUsdc: "twenty" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /\$\.body\.stakeUsdc/);
  assert.equal(result.errors[0]!.includes("twenty"), false);
});

test("a key that is not an identifier is still located", () => {
  const result = validateAgainstSchema(
    { type: "object", properties: { "x-kebab": { type: "number" } }, additionalProperties: false },
    { "x-kebab": "no", other: 1 },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /\$\["x-kebab"\]/);
  assert.match(result.errors.join("; "), /unexpected property "other"/);
});

test("every failure is reported, not just the first", () => {
  const result = validateAgainstSchema(
    {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      additionalProperties: false,
    },
    { a: 1, b: 2, c: 3, d: 4 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errors.length >= 4, true);
});
