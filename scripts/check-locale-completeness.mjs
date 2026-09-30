#!/usr/bin/env node
/**
 * scripts/check-locale-completeness.mjs
 *
 * Checks every non-English locale in messages/ against the English baseline
 * and exits non-zero when any violation is found.
 *
 * Exit codes
 * ──────────
 *   0  All registered locales are complete (or there are no non-English locales).
 *   1  One or more locales have missing keys, extra keys, or funded-feature
 *      violations.
 *
 * Funded-feature violations (missing keys in dashboard, wallet, home, create,
 * vsDetail) always cause exit 1, even if the locale is still experimental.
 * They prevent silent fallback to key paths for UI strings that appear
 * immediately before a USDC commitment.
 *
 * Usage
 * ─────
 *   node scripts/check-locale-completeness.mjs          # check all locales
 *   node scripts/check-locale-completeness.mjs --strict # also fail on extra keys
 *   node scripts/check-locale-completeness.mjs --quiet  # suppress passing output
 *
 * The script reads i18n/routing.ts to discover which locales are registered,
 * so it stays in sync automatically when a locale is added.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Resolve paths ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MESSAGES_DIR = resolve(ROOT, "messages");
const ROUTING_FILE = resolve(ROOT, "i18n", "routing.ts");

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const STRICT = args.includes("--strict"); // fail on extra keys too
const QUIET = args.includes("--quiet"); // suppress passing output

// ── Inline flattenKeys and checkLocale to avoid tsx at script runtime ─────────
//
// The lib module is TypeScript; importing it directly from an .mjs script
// would require tsx.  To keep the script runnable with plain `node` (matching
// the pattern of check-forbidden-terms.mjs), we duplicate just the two small
// functions we need.

const FUNDED_NAMESPACES = new Set([
  "create",
  "dashboard",
  "home",
  "vsDetail",
  "wallet",
]);

/**
 * @param {Record<string, unknown>} obj
 * @param {string} prefix
 * @returns {string[]}
 */
function flattenKeys(obj, prefix = "") {
  /** @type {string[]} */
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(/** @type {any} */ (v), full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {unknown}
 */
function getLeaf(obj, key) {
  const parts = key.split(".");
  let cursor = obj;
  for (const p of parts) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = /** @type {any} */ (cursor)[p];
  }
  return cursor;
}

/**
 * @param {Record<string, unknown>} baseline
 * @param {string} locale
 * @param {Record<string, unknown>} messages
 */
function checkLocale(baseline, locale, messages) {
  const baseKeys = new Set(flattenKeys(baseline));
  const locKeys = new Set(flattenKeys(messages));

  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];
  /** @type {string[]} */
  const untranslated = [];

  for (const k of baseKeys) {
    if (!locKeys.has(k)) missing.push(k);
  }
  for (const k of locKeys) {
    if (!baseKeys.has(k)) extra.push(k);
  }
  if (locale !== "en") {
    for (const k of baseKeys) {
      if (!locKeys.has(k)) continue;
      const bv = getLeaf(baseline, k);
      const lv = getLeaf(messages, k);
      if (typeof bv === "string" && bv === lv) untranslated.push(k);
    }
  }

  const missingFunded = missing.filter((k) =>
    FUNDED_NAMESPACES.has(k.split(".")[0] ?? "")
  );

  return {
    locale,
    missing: missing.sort(),
    extra: extra.sort(),
    untranslated: untranslated.sort(),
    hasFundedViolation: missingFunded.length > 0,
    missingFunded: missingFunded.sort(),
  };
}

// ── Discover registered locales from routing.ts ───────────────────────────────

function discoverLocales() {
  const src = readFileSync(ROUTING_FILE, "utf8");
  // Match: locales: ["en", "es", ...]
  const match = src.match(/locales:\s*\[([^\]]+)\]/);
  if (!match) {
    console.error(
      "check-locale-completeness: could not parse locales from i18n/routing.ts"
    );
    process.exit(1);
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/["']/g, ""))
    .filter(Boolean);
}

// ── Load a JSON message file ───────────────────────────────────────────────────

function loadMessages(locale) {
  const file = resolve(MESSAGES_DIR, `${locale}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(
      `check-locale-completeness: cannot read messages/${locale}.json — ${err.message}`
    );
    process.exit(1);
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

function red(s) { return `${RED}${s}${RESET}`; }
function yellow(s) { return `${YELLOW}${s}${RESET}`; }
function green(s) { return `${GREEN}${s}${RESET}`; }
function bold(s) { return `${BOLD}${s}${RESET}`; }

// ── Main ──────────────────────────────────────────────────────────────────────

const allLocales = discoverLocales();
const nonEnglish = allLocales.filter((l) => l !== "en");

if (nonEnglish.length === 0) {
  if (!QUIET) {
    console.log(
      green("✓ check:locales — only English is registered; nothing to diff.")
    );
  }
  process.exit(0);
}

const baseline = loadMessages("en");
let exitCode = 0;

for (const locale of nonEnglish) {
  const messages = loadMessages(locale);
  const result = checkLocale(baseline, locale, messages);

  const hasProblem =
    result.missing.length > 0 ||
    (STRICT && result.extra.length > 0);

  if (!hasProblem && !QUIET) {
    // Only print the untranslated warning if there are untranslated strings.
    if (result.untranslated.length > 0) {
      console.log(
        yellow(`⚠  ${locale}: complete but ${result.untranslated.length} key(s) have English-identical values — confirm they are intentional.`)
      );
    } else {
      console.log(green(`✓  ${locale}: all ${flattenKeys(baseline).length} keys present and translated.`));
    }
    continue;
  }

  exitCode = 1;
  console.log(bold(red(`✗  ${locale}: locale check FAILED`)));

  if (result.hasFundedViolation) {
    console.log(
      red(
        `   FUNDED-FEATURE VIOLATION: ${result.missingFunded.length} missing key(s) in money-touching namespace(s).`
      )
    );
    console.log(
      red(
        `   These must be translated before this locale can be shipped or enabled.`
      )
    );
    for (const k of result.missingFunded) {
      console.log(red(`     - ${k}`));
    }
  }

  if (result.missing.length > 0) {
    const nonFunded = result.missing.filter(
      (k) => !FUNDED_NAMESPACES.has(k.split(".")[0] ?? "")
    );
    if (nonFunded.length > 0) {
      console.log(
        yellow(`   Missing (${nonFunded.length} non-funded key(s)):`)
      );
      for (const k of nonFunded.slice(0, 20)) {
        console.log(`     - ${k}`);
      }
      if (nonFunded.length > 20) {
        console.log(`     … and ${nonFunded.length - 20} more.`);
      }
    }
  }

  if (STRICT && result.extra.length > 0) {
    console.log(
      yellow(`   Extra (${result.extra.length} key(s) not in baseline — may be stale):`)
    );
    for (const k of result.extra.slice(0, 20)) {
      console.log(`     - ${k}`);
    }
    if (result.extra.length > 20) {
      console.log(`     … and ${result.extra.length - 20} more.`);
    }
  }

  if (result.untranslated.length > 0) {
    console.log(
      yellow(
        `   Untranslated (${result.untranslated.length} key(s) identical to English baseline):`
      )
    );
    for (const k of result.untranslated.slice(0, 10)) {
      console.log(`     - ${k}`);
    }
    if (result.untranslated.length > 10) {
      console.log(`     … and ${result.untranslated.length - 10} more.`);
    }
  }

  console.log();
}

if (exitCode === 0 && !QUIET) {
  console.log(
    green(
      `✓ check:locales — all ${nonEnglish.length} locale(s) are complete.`
    )
  );
}

process.exit(exitCode);
