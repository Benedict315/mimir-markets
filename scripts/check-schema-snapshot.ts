/**
 * Gate the Postgres schema against its committed snapshot.
 *
 *   npm run check:schema-snapshot            # verify (CI gate)
 *   npm run check:schema-snapshot -- --write # regenerate after a reviewed change
 *
 * No database, no network, no production secrets.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSchemaStatements } from "../lib/db";
import {
  DEFAULT_SCHEMA_SNAPSHOT_RELATIVE,
  buildSchemaSnapshot,
  formatSchemaSnapshotReport,
  schemaSnapshotPath,
  verifyRepoSchemaSnapshot,
} from "../lib/ops/schema-snapshot";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = schemaSnapshotPath(REPO_ROOT, DEFAULT_SCHEMA_SNAPSHOT_RELATIVE);

function writeSnapshot(): void {
  const snapshot = buildSchemaSnapshot(getSchemaStatements());
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`wrote schema snapshot → ${DEFAULT_SCHEMA_SNAPSHOT_RELATIVE}`);
  console.log(
    `  · ${snapshot.tables.length} table(s), ${snapshot.indexes.length} index(es), ` +
      `${snapshot.migrations.length} migration(s), fingerprint ${snapshot.fingerprint}`,
  );
}

function main(): void {
  const args = new Set(process.argv.slice(2));

  if (args.has("--write")) {
    writeSnapshot();
    const report = verifyRepoSchemaSnapshot({ repoRoot: REPO_ROOT, statements: getSchemaStatements() });
    console.log(formatSchemaSnapshotReport(report));
    if (!report.ok) process.exit(1);
    return;
  }

  const report = verifyRepoSchemaSnapshot({ repoRoot: REPO_ROOT, statements: getSchemaStatements() });
  console.log(formatSchemaSnapshotReport(report));
  if (!report.ok) process.exit(1);
}

main();
