/**
 * A deliberately small JSON Schema validator.
 *
 * It exists so the published agent API examples can be checked against the
 * published schema by the same command that publishes them. That check is only
 * worth anything if it fails when it does not understand something, so this is
 * the opposite of a general implementation:
 *
 *   - `assertSupportedKeywords` walks the schema and THROWS on any keyword not in
 *     {@link SUPPORTED_KEYWORDS}. A schema that grows a `patternProperties` or a
 *     `$ref` must fail the check loudly rather than be validated against half its
 *     rules and pass.
 *   - Validation returns every failure with a path, so the finding is actionable
 *     ("examples.signedHeartbeat.body.stakeUsdc: expected number") without ever
 *     echoing a credential-shaped value.
 *
 * Supported: type, enum, const, required, properties, additionalProperties,
 * items, pattern, minLength, maxLength, minimum, maximum, oneOf, anyOf, allOf,
 * not, and if/then/else. That is enough for the envelope schema this repo
 * publishes, and nothing more.
 */

export const SUPPORTED_KEYWORDS: readonly string[] = [
  "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated",
  "type", "enum", "const", "required", "properties", "additionalProperties", "items",
  "pattern", "minLength", "maxLength", "minimum", "maximum",
  "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
];

const SUPPORTED = new Set(SUPPORTED_KEYWORDS);
const APPLICATOR_KEYWORDS = new Set(["oneOf", "anyOf", "allOf", "not", "if", "then", "else"]);

export class JsonSchemaError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "JsonSchemaError";
    this.path = path;
  }
}

export interface SchemaValidationResult {
  ok: boolean;
  /** One entry per failure, each naming the instance path and the rule. */
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Fail closed on anything this validator would not enforce.
 *
 * Called before validating, never during: a schema keyword that is silently
 * ignored turns "the examples match the schema" into a claim nothing backs.
 */
export function assertSupportedKeywords(schema: unknown, path = "$schema"): void {
  if (!isPlainObject(schema)) throw new JsonSchemaError("schema must be an object", path);
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED.has(key)) {
      throw new JsonSchemaError(`unsupported schema keyword "${key}"`, path);
    }
    if (key === "properties") {
      if (!isPlainObject(value)) throw new JsonSchemaError("properties must be an object", path);
      for (const [name, sub] of Object.entries(value)) {
        assertSupportedKeywords(sub, `${path}.properties.${name}`);
      }
      continue;
    }
    if (key === "additionalProperties" && isPlainObject(value)) {
      assertSupportedKeywords(value, `${path}.additionalProperties`);
      continue;
    }
    if (["items", "not", "if", "then", "else"].includes(key)) {
      assertSupportedKeywords(value, `${path}.${key}`);
      continue;
    }
    if (APPLICATOR_KEYWORDS.has(key)) {
      if (!Array.isArray(value)) throw new JsonSchemaError(`${key} must be an array of schemas`, path);
      value.forEach((sub, index) => assertSupportedKeywords(sub, `${path}.${key}[${index}]`));
    }
  }
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

/** Deep structural equality over the JSON data model. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => key in b && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Validate one value against one subschema, collecting every failure. */
function validate(schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
    if (!expected.some((candidate) => typeMatches(candidate, value))) {
      errors.push(`${path}: expected ${expected.join(" or ")}`);
      return;
    }
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    errors.push(`${path}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (typeof value === "string") validateString(schema, value, path, errors);
  if (typeof value === "number") validateNumber(schema, value, path, errors);
  if (isPlainObject(value)) validateObject(schema, value, path, errors);
  if (Array.isArray(value)) {
    const itemSchemas = Array.isArray(schema.items) ? (schema.items as unknown[]) : [schema.items];
    value.forEach((item, index) => {
      for (const itemSchema of itemSchemas) {
        if (itemSchema === undefined) continue;
        validate(itemSchema as Record<string, unknown>, item, `${path}[${index}]`, errors);
      }
    });
  }
  validateApplicators(schema, value, path, errors);
}

function validateString(
  schema: Record<string, unknown>, value: string, path: string, errors: string[],
): void {
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: must match ${schema.pattern}`);
  }
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path}: must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path}: must be at most ${schema.maxLength} characters`);
  }
}

function validateNumber(
  schema: Record<string, unknown>, value: number, path: string, errors: string[],
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path}: must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path}: must be <= ${schema.maximum}`);
  }
}

function validateObject(
  schema: Record<string, unknown>, value: Record<string, unknown>, path: string, errors: string[],
): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required.map(String) : []) {
    if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (isPlainObject(properties[key])) {
      validate(properties[key] as Record<string, unknown>, item, childPath(path, key), errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(`${path}: unexpected property "${key}"`);
    } else if (isPlainObject(schema.additionalProperties)) {
      validate(schema.additionalProperties as Record<string, unknown>, item, childPath(path, key), errors);
    }
  }
}

function validateApplicators(
  schema: Record<string, unknown>, value: unknown, path: string, errors: string[],
): void {
  for (const sub of (schema.allOf as unknown[]) ?? []) {
    validate(sub as Record<string, unknown>, value, path, errors);
  }
  if (isPlainObject(schema.not)) {
    if (errorsOf(schema.not as Record<string, unknown>, value, path).length === 0) {
      errors.push(`${path}: must not match the "not" subschema`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as unknown[]).map((sub) => errorsOf(sub as Record<string, unknown>, value, path));
    const matched = passing.filter((sub) => sub.length === 0).length;
    if (matched !== 1) {
      // The branches' own reasons, so the finding says WHY rather than "oneOf
      // failed" — that is the difference between a fixable report and a shrug.
      const detail = matched === 0
        ? (passing[0] ?? ["no branch matched"]).slice(0, 3)
        : [`matched ${matched} branches, expected exactly 1`];
      errors.push(`${path}: ${detail.join("; ")}`);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const anyPassing = (schema.anyOf as unknown[]).some(
      (sub) => errorsOf(sub as Record<string, unknown>, value, path).length === 0,
    );
    if (!anyPassing) errors.push(`${path}: does not match any "anyOf" subschema`);
  }
  if (isPlainObject(schema.if)) {
    const conditionHolds = errorsOf(schema.if as Record<string, unknown>, value, path).length === 0;
    const branch = conditionHolds ? schema.then : schema.else;
    if (isPlainObject(branch)) validate(branch as Record<string, unknown>, value, path, errors);
  }
}

function errorsOf(
  schema: Record<string, unknown>, value: unknown, path: string,
): string[] {
  const errors: string[] = [];
  validate(schema, value, path, errors);
  return errors;
}

/**
 * Validate an instance against a schema subset.
 *
 * The schema is checked for supported keywords first, so a schema this validator
 * cannot fully enforce throws instead of reporting a pass it did not earn.
 */
export function validateAgainstSchema(schema: unknown, value: unknown, path = "$"): SchemaValidationResult {
  assertSupportedKeywords(schema);
  const errors = errorsOf(schema as Record<string, unknown>, value, path);
  return { ok: errors.length === 0, errors };
}
