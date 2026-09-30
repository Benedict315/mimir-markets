/**
 * A small, deterministic YAML emitter for the documents this repo publishes.
 *
 * The published contract is a `.yaml` file that reviewers read in a diff, so the
 * output has to be stable: same input, byte-identical file, no timestamps, no
 * key reordering. That is the whole reason this exists instead of a general
 * library — there is no YAML dependency in `package.json`, and adding one for a
 * single generated document is not worth the supply chain.
 *
 * Scope is deliberately the JSON data model plus block style. Anything outside it
 * THROWS rather than guessing, because a silently mis-quoted string in a wire
 * contract is worse than a failed generation:
 *
 *   - maps, sequences, strings, finite numbers, booleans, null
 *   - key order is insertion order (never sorted — the builder decides order)
 *   - strings are double-quoted via `JSON.stringify` unless they are provably
 *     safe bare scalars, and multi-line strings use a `|-` literal block
 *
 * JSON's escapes are a subset of YAML's double-quoted escapes (`\"`, `\\`, `\b`,
 * `\f`, `\n`, `\r`, `\t`, `\uXXXX`), which is why `JSON.stringify` output is valid
 * YAML. It never emits `\/`, so the one escape JSON can produce that YAML cannot
 * read does not occur.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

export class YamlEmitError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "YamlEmitError";
    this.path = path;
  }
}

/**
 * A plain data object, and nothing else.
 *
 * Deliberately stricter than "is an object": a `Map`, a `Date` or a class instance
 * has no enumerable own keys, so `Object.entries` would turn it into `{}` and the
 * field would vanish from the document instead of failing. Only a literal with
 * `Object.prototype` (or a null prototype) can be represented faithfully.
 */
function isPlainObject(value: unknown): value is { [key: string]: YamlValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Check an unknown value is representable, and return it typed.
 *
 * The point is the failure, not the cast. `JSON.stringify` drops an `undefined`
 * property and turns a `Map` into `{}`; a contract whose example silently loses a
 * field is worse than a build that stops. So anything that is not plain JSON is
 * refused, naming the path rather than the value.
 */
export function asYamlValue(value: unknown, path = "$"): YamlValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new YamlEmitError(`non-finite number cannot be represented in YAML: ${String(value)}`, path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => asYamlValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: YamlValue } = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new YamlEmitError("undefined cannot be represented in YAML; omit the key at the source", `${path}.${key}`);
      }
      out[key] = asYamlValue(item, `${path}.${key}`);
    }
    return out;
  }
  throw new YamlEmitError(
    `${typeof value} cannot be represented in YAML; only plain JSON is allowed`,
    path,
  );
}

/**
 * Words YAML would resolve to a boolean/null rather than to the string typed.
 * Case-insensitive, because YAML 1.1 resolves `Yes`/`NO`/`On`/`Off` too and a
 * document that means the string "no" must not become `false`.
 */
const RESERVED_BARE_SCALARS = new Set([
  "true", "false", "null", "yes", "no", "on", "off", "y", "n", "~",
]);

/** Safe unquoted key: no quotes, colons, or flow indicators to escape. */
function isBareKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key);
}

/**
 * Safe unquoted scalar.
 *
 * Deliberately strict: must start with a letter or underscore (so it can never be
 * read as a number, a timestamp or `null`), may not contain `:`, `#`, a quote or
 * a leading/trailing space, and may not be a reserved word. A string that fails
 * any of these is quoted, which is always correct — only readability is lost.
 */
function isBareScalar(value: string): boolean {
  if (value.length === 0 || value.length > 120) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_./ -]*$/.test(value)) return false;
  if (value !== value.trim()) return false;
  return !RESERVED_BARE_SCALARS.has(value.toLowerCase());
}

/**
 * Whether a multi-line string can be a `|-` literal block.
 *
 * Refuses anything a literal block would change meaning for: a trailing newline
 * (needs `|` and then chomping rules), an empty or space-padded line, a leading
 * space on the first line (YAML would need an explicit indentation indicator), a
 * tab, or a line that is only whitespace. Those all fall back to a quoted scalar,
 * which is always correct.
 */
export function canUseLiteralBlock(value: string): boolean {
  if (!value.includes("\n")) return false;
  if (value.includes("\t") || value !== value.trimEnd()) return false;
  return value.split("\n").every((line) => line.length > 0 && line === line.trimEnd() && !line.startsWith(" "));
}

function scalarText(value: YamlScalar, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new YamlEmitError(`non-finite number cannot be represented in YAML: ${String(value)}`, path);
    }
    // Normalise -0 so the same value always renders the same bytes.
    if (Object.is(value, -0)) return "0";
    const text = String(value);
    // YAML 1.1 only resolves an exponent form as a float when the mantissa has a
    // decimal point, so `1e+21` (which is what String() gives) would come back as
    // the *string* "1e+21". Adding the point keeps the type, in 1.1 and 1.2 alike.
    return /[eE]/.test(text) && !text.includes(".") ? `${text[0]}.0${text.slice(1)}` : text;
  }
  if (isBareScalar(value)) return value;
  return JSON.stringify(value);
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function emitMap(value: { [key: string]: YamlValue }, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const [key, item] of Object.entries(value)) {
    const path = `${pad}${key}`;
    // A quoted key is the only safe way to express these (`/api/…`, `200`,
    // `x-…`). JSON quoting is valid YAML, and `isBareKey` is what decides.
    const renderedKey = isBareKey(key) ? key : JSON.stringify(key);
    const node = renderNode(item, indent, path);
    // `inline` is `|-` for a literal block and empty for a nested collection, so
    // whichever it is gets the colon line and the other gets its own lines.
    lines.push(node.inline ? `${pad}${renderedKey}: ${node.inline}` : `${pad}${renderedKey}:`, ...node.block);
  }
}

/**
 * Render one value: either an inline scalar (or `{}` / `[]` for an empty
 * collection) or a block of lines indented under the key that owns it. Never
 * both, so a key can never end up with a value and a nested map at once.
 */
function renderNode(value: YamlValue, indent: number, path: string): { inline: string; block: string[] } {
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return { inline: "{}", block: [] };
    const block: string[] = [];
    emitMap(value, indent + 2, block);
    return { inline: "", block };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { inline: "[]", block: [] };
    const block: string[] = [];
    emitSequence(value, indent + 2, block, path);
    return { inline: "", block };
  }
  if (typeof value === "string" && canUseLiteralBlock(value)) {
    const pad = " ".repeat(indent + 2);
    return { inline: "|-", block: value.split("\n").map((line) => `${pad}${line}`) };
  }
  return { inline: scalarText(value, path), block: [] };
}

function emitSequence(value: YamlValue[], indent: number, lines: string[], path: string): void {
  const pad = " ".repeat(indent);
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (Array.isArray(item) || isPlainObject(item)) {
      const node = renderNode(item, indent, itemPath);
      if (!node.block.length) {
        lines.push(`${pad}- ${node.inline}`);
        continue;
      }
      // First entry rides on the dash line, the rest align under it.
      const [first, ...rest] = node.block;
      lines.push(`${pad}- ${first!.trimStart()}`);
      for (const line of rest) lines.push(line);
      continue;
    }
    lines.push(`${pad}- ${scalarText(item, itemPath)}`);
  }
}

export interface ToYamlOptions {
  /** Comment lines emitted above the document, each prefixed with `# `. */
  header?: readonly string[];
}

/**
 * Render a value as a YAML document.
 *
 * Throws `YamlEmitError` on a non-finite number or a non-object root: both are
 * bugs in the builder, and a generated file that quietly contains `null` where a
 * limit should be would pass a byte-comparison check while documenting nothing.
 */
export function toYaml(value: YamlValue, options: ToYamlOptions = {}): string {
  if (!isPlainObject(value)) {
    throw new YamlEmitError("a YAML document root must be a mapping", "");
  }
  const header = options.header ?? [];
  if (!Array.isArray(header) || header.some((line) => typeof line !== "string")) {
    throw new YamlEmitError("header must be an array of comment lines", "");
  }
  const lines: string[] = [];
  for (const line of header) {
    lines.push(line.length === 0 ? "#" : `# ${line}`);
  }
  if (lines.length > 0) lines.push("");
  emitMap(value, 0, lines);
  return joinLines(lines);
}
