import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getSchemaStatements } from "../../lib/db";
import {
  buildSchemaSnapshot,
  canonicalSql,
  fingerprintStatements,
  formatSchemaSnapshotReport,
  loadSchemaSnapshot,
  parseSchemaSnapshot,
  verifyRepoSchemaSnapshot,
  verifySchemaSnapshot,
  type SchemaStatement,
} from "../../lib/ops/schema-snapshot";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "schema-snapshot");
const REPO_SNAPSHOT = join(process.cwd(), "schemas", "db-schema.snapshot.json");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown;
}

const MIGRATION_SQL =
  "INSERT INTO schema_migrations(migration_id, schema_version, checksum, applied_at) VALUES($1, $2, $3, $4)";

const SAMPLE_STATEMENTS: SchemaStatement[] = [
  { sql: "CREATE TABLE IF NOT EXISTS alpha (\n  id TEXT PRIMARY KEY\n)" },
  { sql: "CREATE INDEX IF NOT EXISTS idx_alpha_id ON alpha(id)" },
  { sql: "CREATE TABLE IF NOT EXISTS beta (\n  id TEXT PRIMARY KEY\n)" },
  {
    sql: MIGRATION_SQL,
    args: ["alpha-beta-v1", 1, "alpha-beta-checksum-v1", 0],
  },
];

test("positive: a snapshot built from the schema verifies against itself", () => {
  const snapshot = buildSchemaSnapshot(SAMPLE_STATEMENTS);
  const report = verifySchemaSnapshot(snapshot, snapshot);
  assert.equal(report.ok, true, formatSchemaSnapshotReport(report));
  assert.deepEqual(snapshot.tables, ["alpha", "beta"]);
  assert.deepEqual(snapshot.indexes, ["idx_alpha_id"]);
  assert.equal(snapshot.statementCount, 4);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
});

test("positive: whitespace-only edits do not change the fingerprint", () => {
  const reformatted = SAMPLE_STATEMENTS.map((statement, index) =>
    index === 0
      ? { ...statement, sql: "CREATE   TABLE IF NOT EXISTS alpha (\n\n\tid TEXT PRIMARY KEY\n)" }
      : statement,
  );
  assert.equal(canonicalSql(reformatted[0]!.sql), canonicalSql(SAMPLE_STATEMENTS[0]!.sql));
  assert.equal(fingerprintStatements(reformatted), fingerprintStatements(SAMPLE_STATEMENTS));
});

test("positive: the committed valid fixture matches the canonical builder", () => {
  const loaded = loadSchemaSnapshot(join(FIXTURE_DIR, "valid.snapshot.json"));
  const report = verifySchemaSnapshot(loaded, buildSchemaSnapshot(SAMPLE_STATEMENTS));
  assert.equal(report.ok, true, formatSchemaSnapshotReport(report));
  assert.deepEqual(loaded, buildSchemaSnapshot(SAMPLE_STATEMENTS));
});

test("negative: a stale fingerprint fails closed", () => {
  const committed = buildSchemaSnapshot(SAMPLE_STATEMENTS);
  const changed = buildSchemaSnapshot([
    ...SAMPLE_STATEMENTS,
    { sql: "CREATE TABLE IF NOT EXISTS gamma (id TEXT PRIMARY KEY)" },
  ]);
  const report = verifySchemaSnapshot(committed, changed);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "FINGERPRINT_MISMATCH"));
  assert.ok(report.findings.some((finding) => finding.code === "TABLE_DRIFT"));
});

test("negative: a removed index reports INDEX_DRIFT", () => {
  const committed = buildSchemaSnapshot(SAMPLE_STATEMENTS);
  const changed = buildSchemaSnapshot(
    SAMPLE_STATEMENTS.filter((statement) => !statement.sql.startsWith("CREATE INDEX")),
  );
  const report = verifySchemaSnapshot(committed, changed);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "INDEX_DRIFT"));
});

test("failure: an empty schema is refused", () => {
  const report = verifySchemaSnapshot(buildSchemaSnapshot(SAMPLE_STATEMENTS), buildSchemaSnapshot([]));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "EMPTY_SCHEMA"));
});

test("failure: tables without a registered migration are refused", () => {
  const statements = SAMPLE_STATEMENTS.filter((statement) => !statement.sql.includes("INSERT INTO schema_migrations"));
  const snapshot = buildSchemaSnapshot(statements);
  const report = verifySchemaSnapshot(snapshot, snapshot);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "MIGRATION_UNREGISTERED"));
});

test("failure: duplicate schema versions are refused", () => {
  const statements: SchemaStatement[] = [
    ...SAMPLE_STATEMENTS,
    { sql: MIGRATION_SQL, args: ["alpha-beta-v2", 1, "alpha-beta-checksum-v2", 0] },
  ];
  const report = verifySchemaSnapshot(buildSchemaSnapshot(statements), buildSchemaSnapshot(statements));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "MIGRATION_DUPLICATE_VERSION"));
});

test("failure: a missing committed snapshot is refused", () => {
  const report = verifySchemaSnapshot(null, buildSchemaSnapshot(SAMPLE_STATEMENTS));
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "SNAPSHOT_MISSING"));
});

test("failure: migration drift is reported when a registration is dropped", () => {
  const committed = buildSchemaSnapshot(SAMPLE_STATEMENTS);
  const statements = SAMPLE_STATEMENTS.slice(0, -1);
  const changed = buildSchemaSnapshot([
    ...statements,
    { sql: MIGRATION_SQL, args: ["alpha-beta-v3", 3, "alpha-beta-checksum-v3", 0] },
  ]);
  const report = verifySchemaSnapshot(committed, changed);
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "MIGRATION_DRIFT"));
});

test("failure: unsupported fixture schemaVersion is rejected", () => {
  assert.throws(() => parseSchemaSnapshot(fixture("unsupported.snapshot.json")), /schemaVersion must be 1/);
});

test("failure: invalid hash algorithm is rejected", () => {
  assert.throws(() => parseSchemaSnapshot(fixture("invalid-hash.snapshot.json")), /hashAlgorithm/);
});

test("failure: a malformed fixture is rejected", () => {
  assert.throws(() => parseSchemaSnapshot(fixture("malformed.snapshot.json")), /must be a JSON object/);
});

test("regression: the committed repo snapshot matches lib/db.ts", () => {
  const statements = getSchemaStatements();
  const report = verifyRepoSchemaSnapshot({ repoRoot: process.cwd(), statements });
  assert.equal(report.ok, true, formatSchemaSnapshotReport(report));

  const snapshot = loadSchemaSnapshot(REPO_SNAPSHOT);
  assert.deepEqual(snapshot, buildSchemaSnapshot(statements));
  assert.equal(snapshot.source, "lib/db.ts");
  assert.ok(snapshot.tables.includes("schema_migrations"));
  assert.ok(snapshot.tables.includes("basket_ownership_transfers"));
  assert.ok(snapshot.migrations.length >= 1);
  for (const migration of snapshot.migrations) {
    assert.match(migration.migration_id, /\S/);
    assert.ok(Number.isInteger(migration.schema_version));
  }
});
