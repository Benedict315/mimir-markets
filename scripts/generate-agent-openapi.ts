/**
 * Generate (or verify) the published agent API contract.
 *
 *   npm run check:openapi            # verify: fails if the committed artifacts drift
 *   npm run check:openapi -- --write # regenerate the committed artifacts
 *
 * No network, no RPC, no production secrets: every fact in the output comes from
 * the same modules the route serves, and the examples use synthetic addresses
 * derived here rather than anything from a database or a chain.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkAgentApiArtifacts,
  formatArtifactReport,
  renderArtifacts,
} from "../lib/ops/agent-api-openapi";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readCommitted(relativePath: string): string | undefined {
  const absolute = path.join(REPO_ROOT, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

function main(): void {
  const write = process.argv.slice(2).includes("--write");

  if (!write) {
    const check = checkAgentApiArtifacts(readCommitted);
    console.log(formatArtifactReport(check));
    if (!check.audit.ok) {
      console.error("\nThe published contract does not match the live agent API. Nothing was written.");
      process.exit(1);
    }
    return;
  }

  const rendered = renderArtifacts();
  for (const artifact of rendered) {
    const absolute = path.join(REPO_ROOT, artifact.relativePath);
    const committed = readCommitted(artifact.relativePath);
    if (committed === artifact.contents) {
      console.log(`  = ${artifact.relativePath} (unchanged)`);
      continue;
    }
    writeFileSync(absolute, artifact.contents, "utf8");
    console.log(`  ${committed === undefined ? "+" : "~"} ${artifact.relativePath}`);
  }

  // Re-check from disk: the file we just wrote is what the next build will read.
  const check = checkAgentApiArtifacts(readCommitted);
  console.log(formatArtifactReport(check));
  if (!check.audit.ok) {
    console.error("\nWrote the artifacts, but they do not pass the audit. Do not commit them.");
    process.exit(1);
  }
}

main();
