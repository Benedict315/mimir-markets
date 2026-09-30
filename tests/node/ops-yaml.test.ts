/**
 * The emitted YAML must be readable by a real YAML parser, not just by us.
 *
 * The whole point of generating the published contract is that a caller can parse
 * it. A hand-rolled emitter is therefore only finished once an independent parser
 * agrees with it — so each case here states the expected *value*, and this test
 * pins the emitter to that value rather than to its own output.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { asYamlValue, toYaml, YamlEmitError } from "../../lib/ops/yaml";

test("emits a flat mapping", () => {
  assert.equal(toYaml({ a: 1, b: "two" }), "a: 1\nb: two\n");
});

test("emits a comment header, then a blank line", () => {
  assert.equal(toYaml({ a: 1 }, { header: ["note", ""] }), "# note\n#\n\na: 1\n");
});

test("refuses a header that is not a list of lines", () => {
  // A string would be iterated character by character and produce a comment per
  // character, which is a silent corruption rather than an error.
  assert.throws(
    () => toYaml({ a: 1 }, { header: "note" as unknown as string[] }),
    YamlEmitError,
  );
});

test("refuses a non-mapping root", () => {
  // A sequence or scalar at the root would parse as a different document shape
  // than the one the schema describes, so it is an error rather than output.
  assert.throws(() => toYaml([1, 2]), YamlEmitError);
  assert.throws(() => toYaml("scalar"), YamlEmitError);
  assert.throws(() => toYaml(null), YamlEmitError);
});

test("empty collections round-trip as {}, []", () => {
  // A flow-style `{}`/`[]` is the only spelling that survives a round trip: an
  // empty key with nothing after it would parse as null.
  assert.equal(toYaml({ map: {}, list: [] }), "map: {}\nlist: []\n");
});

// ── Scalars: the cases that silently corrupt a contract ───────────────────────

test("quotes scalars a parser would resolve to a non-string", () => {
  for (const value of ["true", "false", "no", "Yes", "OFF", "null", "~", "y", "n", "on", "On"]) {
    const text = toYaml({ v: value });
    assert.equal(text, `v: ${JSON.stringify(value)}\n`, `expected ${value} to be quoted`);
  }
});

test("quotes scalars that would resolve to a number, date or sexagesimal", () => {
  // "1.0" is a float, "12:30" is sexagesimal in YAML 1.1, "2025-01-01" is a
  // timestamp, and "0x10" is an int. A version or an id must stay a string.
  for (const value of ["1.0", "1e5", "0x10", "2025-01-01", "12:30", "0755", "1_000"]) {
    assert.equal(toYaml({ v: value }), `v: ${JSON.stringify(value)}\n`, `expected ${value} to be quoted`);
  }
});

test("quotes scalars containing a colon, hash or quote", () => {
  assert.equal(toYaml({ v: "key: value" }), 'v: "key: value"\n');
  assert.equal(toYaml({ v: "trailing #" }), 'v: "trailing #"\n');
  assert.equal(toYaml({ v: 'say "hi"' }), 'v: "say \\"hi\\""\n');
  assert.equal(toYaml({ v: "- dash" }), 'v: "- dash"\n');
  assert.equal(toYaml({ v: "two\nlines" }), "v: |-\n  two\n  lines\n");
});

test("quotes a scalar with leading or trailing space", () => {
  assert.equal(toYaml({ v: " padded " }), 'v: " padded "\n');
});

test("leaves safe scalars unquoted for readability", () => {
  assert.equal(
    toYaml({ action: "createMarket", code: "invalid_request", path: "lib/agents/api.ts" }),
    "action: createMarket\ncode: invalid_request\npath: lib/agents/api.ts\n",
  );
});

test("numbers keep their JSON form", () => {
  assert.equal(toYaml({ i: 42, neg: -7, f: 1.5 }), "i: 42\nneg: -7\nf: 1.5\n");
});

test("an exponent form keeps its decimal point so it stays a number", () => {
  // String(1e21) is "1e+21", which a YAML 1.1 parser resolves to a string. The
  // emitter must not turn a number into a string by omission.
  assert.equal(toYaml({ e: 1e21 }), "e: 1.0e+21\n");
  assert.equal(toYaml({ e: 1.5e-7 }), "e: 1.5e-7\n");
});

test("null is null", () => {
  assert.equal(toYaml({ v: null }), "v: null\n");
});

test("rejects a non-finite number instead of emitting something a parser guesses at", () => {
  assert.throws(() => toYaml({ v: Number.NaN }), YamlEmitError);
  assert.throws(() => toYaml({ v: Number.POSITIVE_INFINITY }), YamlEmitError);
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test("quotes keys that are not bare identifiers", () => {
  // `x-mimir-…` is bare, but a key with a space, a colon or a leading digit is
  // not, and a bare one would break the mapping.
  assert.equal(toYaml({ "x-mimir-actions": 1 }), "x-mimir-actions: 1\n");
  assert.equal(toYaml({ "200": 1 }), '"200": 1\n');
  assert.equal(toYaml({ "a b": 1 }), '"a b": 1\n');
  assert.equal(toYaml({ "a:": 1 }), '"a:": 1\n');
});

// ── Blocks ───────────────────────────────────────────────────────────────────

test("nests maps and sequences", () => {
  assert.equal(
    toYaml({ a: { b: [{ c: 1 }, { d: 2 }] } }),
    "a:\n  b:\n    - c: 1\n    - d: 2\n",
  );
});

test("emits a multi-line string as a literal block", () => {
  const value = "line one\nline two\nline three";
  assert.equal(toYaml({ text: value }), "text: |-\n  line one\n  line two\n  line three\n");
});

test("falls back to a quoted string when a literal block would change the value", () => {
  // A trailing space, a tab or a blank line would be lost or re-interpreted in a
  // literal block, so those are quoted instead of risking a silent difference.
  for (const value of ["line one \nline two", "a\n\nb", "tab\there", "  indented\nsecond"]) {
    assert.equal(toYaml({ text: value }), `text: ${JSON.stringify(value)}\n`, `expected quoting for ${JSON.stringify(value)}`);
  }
});

test("a single-line string is never a block", () => {
  assert.equal(toYaml({ text: "one" }), "text: one\n");
});

// ── asYamlValue: refuse what cannot be represented ───────────────────────────

test("asYamlValue refuses undefined rather than dropping the key", () => {
  // JSON.stringify would delete the property and the example would lose a field
  // that the schema requires. The build must stop instead.
  assert.throws(() => asYamlValue({ a: 1, b: undefined }), (error: unknown) => {
    assert.ok(error instanceof YamlEmitError);
    assert.match(error.message, /\$\.b/);
    return true;
  });
});

test("asYamlValue refuses values that are not plain JSON", () => {
  assert.throws(() => asYamlValue(new Map()), YamlEmitError);
  assert.throws(() => asYamlValue(() => 1), YamlEmitError);
  assert.throws(() => asYamlValue(Number.NaN), YamlEmitError);
});

test("asYamlValue keeps a null-valued key, which is data and not an omission", () => {
  assert.equal(toYaml(asYamlValue({ expiresAt: null })), "expiresAt: null\n");
});

test("asYamlValue names the path of a nested problem", () => {
  assert.throws(
    () => asYamlValue({ responses: { 200: { examples: { one: { value: undefined } } } } }),
    (error: unknown) => {
      assert.ok(error instanceof YamlEmitError);
      assert.equal(error.path, "$.responses.200.examples.one.value");
      return true;
    },
  );
});

test("rendering is stable: the same value gives the same text", () => {
  const value = { a: [1, { b: "c" }], d: { e: null }, f: "multi\nline" };
  assert.equal(toYaml(value), toYaml(value));
});
