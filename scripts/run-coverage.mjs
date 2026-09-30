/**
 * Coverage runner for money-moving paths.
 *
 * Wraps the full node test suite with c8 (V8 native coverage) and enforces
 * the thresholds declared in .c8rc. No production secrets are required —
 * DATABASE_URL is not needed (paid-revenue.ts falls back to in-memory) and
 * PASS_SECRET is injected here as a test value.
 *
 * Usage:
 *   npm run test:coverage
 *   PASS_SECRET=test npm run test:coverage   # equivalent; any non-empty value works
 *
 * Requires c8 in devDependencies (installed by npm ci / npm install).
 */
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "node");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("tests", "node", name));

if (files.length === 0) {
  console.error("No node tests found.");
  process.exit(1);
}

// Inject a non-empty PASS_SECRET if none is present so the paid-pass tests
// run without production credentials. Any value works; this is not a secret.
const env = { ...process.env };
if (!env.PASS_SECRET) env.PASS_SECRET = "mimir-coverage-test-secret";

// Locate the c8 binary. npm ci installs it into node_modules/.bin/c8;
// on Windows it may also be node_modules/.bin/c8.cmd.
function findC8() {
  const candidates = [
    path.join(root, "node_modules", ".bin", "c8.cmd"),
    path.join(root, "node_modules", ".bin", "c8"),
    path.join(root, "node_modules", "c8", "bin", "c8.js"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

const c8bin = findC8();
if (!c8bin) {
  console.error(
    "[test:coverage] c8 not found in node_modules. Run `npm install` first.",
  );
  process.exit(1);
}

// c8 wraps a node command: c8 [c8-opts] node [node-opts] --test <files>
const isJs = c8bin.endsWith(".js");
const result = spawnSync(
  isJs ? process.execPath : c8bin,
  [
    ...(isJs ? [c8bin] : []),
    "--config", ".c8rc",
    // The wrapped command
    process.execPath,
    "--require", "tests/node/helpers/stubs.cjs",
    "--require", "node_modules/tsx/dist/cjs/index.cjs",
    "--test",
    ...files,
  ],
  { cwd: root, env, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
