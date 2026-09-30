/**
 * Schema snapshot gate — fail-closed migration drift detection.
 *
 * `lib/db.ts` applies an ordered `SCHEMA_STATEMENTS` list on every cold start.
 * A funded feature must not change that list without the change being visible in
 * review, so the exact statement set is pinned in a committed snapshot
 * (`schemas/db-schema.snapshot.json`). `npm run check:schema-snapshot` rebuilds
 * the snapshot from the live schema definition and fails when the two diverge.
 *
 * The snapshot records the schema fingerprint, every table and index it creates,
 * and every row registered in `schema_migrations`. That makes three things
 * explicit: what the schema is, which migration introduced it, and whether the
 * committed snapshot is stale.
 *
 * This module is pure — it never opens a database connection, reads an env var,
 * or touches the network, so it is reproducible from a clean checkout.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SCHEMA_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SCHEMA_SNAPSHOT_HASH_ALGORITHM = "sha256" as const;
export const DEFAULT_SCHEMA_SNAPSHOT_RELATIVE = "schemas/db-schema.snapshot.json";
export const DEFAULT_SCHEMA_SOURCE_RELATIVE = "lib/db.ts";

export interface SchemaStatement {
  sql: string;
  args?: ReadonlyArray<unknown>;
}

export interface SchemaMigrationRecord {
  migration_id: string;
  schema_version: number;
  checksum: string;
  applied_at: number;
}

export interface SchemaSnapshot {
  schemaVersion: typeof SCHEMA_SNAPSHOT_SCHEMA_VERSION;
  hashAlgorithm: typeof SCHEMA_SNAPSHOT_HASH_ALGORITHM;
  source: string;
  fingerprint: string;
  statementCount: number;
  tables: string[];
  indexes: string[];
  migrations: SchemaMigrationRecord[];
}

export type SchemaSnapshotFindingCode =
  | "SNAPSHOT_MISSING"
  | "SNAPSHOT_INVALID"
  | "EMPTY_SCHEMA"
  | "FINGERPRINT_MISMATCH"
  | "TABLE_DRIFT"
  | "INDEX_DRIFT"
  | "MIGRATION_DRIFT"
  | "MIGRATION_DUPLICATE_VERSION"
  | "MIGRATION_UNREGISTERED";

export interface SchemaSnapshotFinding {
  code: SchemaSnapshotFindingCode;
  severity: "error" | "warning";
  message: string;
}

export interface SchemaSnapshotReport {
  ok: boolean;
  /** The committed snapshot the source is checked against. */
  expected: SchemaSnapshot | null;
  /** The snapshot rebuilt from the current schema definition. */
  actual: SchemaSnapshot | null;
  findings: SchemaSnapshotFinding[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const TABLE_RE = /^CREATE TABLE IF NOT EXISTS ([A-Za-z0-9_]+)/i;
const INDEX_RE = /^CREATE INDEX IF NOT EXISTS ([A-Za-z0-9_]+)/i;
const MIGRATION_INSERT_RE = /^INSERT\s+INTO\s+schema_migrations\b/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function asNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => asNonEmptyString(entry, `${field}[${index}]`));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
}

/** Collapse insignificant whitespace so formatting alone cannot fail the gate. */
export function canonicalSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** One statement's contribution to the fingerprint: SQL plus its bound args. */
export function canonicalStatement(statement: SchemaStatement): string {
  return `${canonicalSql(statement.sql)} :: ${JSON.stringify(statement.args ?? [])}`;
}

export function fingerprintStatements(statements: ReadonlyArray<SchemaStatement>): string {
  return sha256Hex(statements.map(canonicalStatement).join("\n"));
}

export function parseMigrationArgs(args: ReadonlyArray<unknown> | undefined): SchemaMigrationRecord {
  const [migrationId, schemaVersion, checksum, appliedAt] = args ?? [];
  if (typeof migrationId !== "string" || migrationId.trim() === "") {
    throw new Error("schema_migrations insert is missing a migration_id");
  }
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`migration "${migrationId}" has an invalid schema_version`);
  }
  if (typeof checksum !== "string" || checksum.trim() === "") {
    throw new Error(`migration "${migrationId}" is missing a checksum`);
  }
  if (typeof appliedAt !== "number" || !Number.isInteger(appliedAt) || appliedAt < 0) {
    throw new Error(`migration "${migrationId}" has an invalid applied_at`);
  }
  return {
    migration_id: migrationId,
    schema_version: schemaVersion,
    checksum,
    applied_at: appliedAt,
  };
}

/**
 * Build the snapshot a deployment would produce from a statement list. The
 * fingerprint covers every statement — schema, migration registration and seed
 * inserts — so any edit must be acknowledged in the committed snapshot.
 */
export function buildSchemaSnapshot(
  statements: ReadonlyArray<SchemaStatement>,
  options: { source?: string } = {},
): SchemaSnapshot {
  const tables: string[] = [];
  const indexes: string[] = [];
  const migrations: SchemaMigrationRecord[] = [];

  for (const statement of statements) {
    const table = statement.sql.match(TABLE_RE);
    if (table) {
      tables.push(table[1]);
      continue;
    }
    const index = statement.sql.match(INDEX_RE);
    if (index) {
      indexes.push(index[1]);
      continue;
    }
    if (MIGRATION_INSERT_RE.test(statement.sql)) {
      migrations.push(parseMigrationArgs(statement.args));
    }
  }

  return {
    schemaVersion: SCHEMA_SNAPSHOT_SCHEMA_VERSION,
    hashAlgorithm: SCHEMA_SNAPSHOT_HASH_ALGORITHM,
    source: options.source ?? DEFAULT_SCHEMA_SOURCE_RELATIVE,
    fingerprint: fingerprintStatements(statements),
    statementCount: statements.length,
    tables,
    indexes,
    migrations,
  };
}

function parseMigrations(value: unknown): SchemaMigrationRecord[] {
  if (!Array.isArray(value)) throw new Error("migrations must be an array");
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`migrations[${index}] must be an object`);
    return {
      migration_id: asNonEmptyString(entry.migration_id, `migrations[${index}].migration_id`),
      schema_version: asPositiveInteger(entry.schema_version, `migrations[${index}].schema_version`),
      checksum: asNonEmptyString(entry.checksum, `migrations[${index}].checksum`),
      applied_at: asNonNegativeInteger(entry.applied_at, `migrations[${index}].applied_at`),
    };
  });
}

/** Parse and structurally validate a snapshot; throws so garbage cannot soft-pass. */
export function parseSchemaSnapshot(raw: unknown): SchemaSnapshot {
  if (!isPlainObject(raw)) throw new Error("schema snapshot must be a JSON object");
  if (raw.schemaVersion !== SCHEMA_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${SCHEMA_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (raw.hashAlgorithm !== SCHEMA_SNAPSHOT_HASH_ALGORITHM) {
    throw new Error(`hashAlgorithm must be "${SCHEMA_SNAPSHOT_HASH_ALGORITHM}"`);
  }
  const fingerprint = asNonEmptyString(raw.fingerprint, "fingerprint").toLowerCase();
  if (!HEX64.test(fingerprint)) throw new Error("fingerprint must be a sha256 hex string");
  return {
    schemaVersion: SCHEMA_SNAPSHOT_SCHEMA_VERSION,
    hashAlgorithm: SCHEMA_SNAPSHOT_HASH_ALGORITHM,
    source: asNonEmptyString(raw.source, "source"),
    fingerprint,
    statementCount: asNonNegativeInteger(raw.statementCount, "statementCount"),
    tables: parseStringArray(raw.tables, "tables"),
    indexes: parseStringArray(raw.indexes, "indexes"),
    migrations: parseMigrations(raw.migrations),
  };
}

export function loadSchemaSnapshot(filePath: string): SchemaSnapshot {
  return parseSchemaSnapshot(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

function sorted(values: ReadonlyArray<string>): string[] {
  return [...values].sort();
}

function setDrift(expected: ReadonlyArray<string>, actual: ReadonlyArray<string>): { added: string[]; removed: string[] } {
  const before = new Set(expected);
  const after = new Set(actual);
  return {
    added: sorted(actual.filter((value) => !before.has(value))),
    removed: sorted(expected.filter((value) => !after.has(value))),
  };
}

function migrationKey(migration: SchemaMigrationRecord): string {
  return `${migration.migration_id} · v${migration.schema_version} · ${migration.checksum}`;
}

/**
 * Compare the committed snapshot (`expected`) against the snapshot rebuilt from
 * the current schema definition (`actual`). Fail-closed: `ok` is true only when
 * there are zero error-severity findings.
 */
export function verifySchemaSnapshot(
  expected: SchemaSnapshot | null,
  actual: SchemaSnapshot | null,
): SchemaSnapshotReport {
  const findings: SchemaSnapshotFinding[] = [];

  if (!expected) {
    findings.push({
      code: "SNAPSHOT_MISSING",
      severity: "error",
      message:
        `no committed schema snapshot at ${DEFAULT_SCHEMA_SNAPSHOT_RELATIVE} — ` +
        "run `npm run check:schema-snapshot -- --write` and commit the result",
    });
  }

  if (!actual || actual.statementCount === 0) {
    findings.push({
      code: "EMPTY_SCHEMA",
      severity: "error",
      message: "schema definition produced no statements — refusing to verify an empty schema",
    });
    return { ok: false, expected, actual, findings };
  }

  const versions = new Map<number, string>();
  for (const migration of actual.migrations) {
    const prior = versions.get(migration.schema_version);
    if (prior !== undefined) {
      findings.push({
        code: "MIGRATION_DUPLICATE_VERSION",
        severity: "error",
        message: `schema_version ${migration.schema_version} is registered twice ("${prior}" and "${migration.migration_id}")`,
      });
    } else {
      versions.set(migration.schema_version, migration.migration_id);
    }
  }

  if (actual.migrations.length === 0) {
    findings.push({
      code: "MIGRATION_UNREGISTERED",
      severity: "error",
      message:
        "the schema creates tables but registers no row in schema_migrations — " +
        "add an `INSERT INTO schema_migrations(...)` entry with a new schema_version before shipping",
    });
  }

  if (!expected) return { ok: false, expected, actual, findings };

  if (expected.fingerprint !== actual.fingerprint) {
    findings.push({
      code: "FINGERPRINT_MISMATCH",
      severity: "error",
      message:
        `schema drift: committed ${expected.fingerprint.slice(0, 12)}… vs ` +
        `source ${actual.fingerprint.slice(0, 12)}… — ` +
        "review the change, then run `npm run check:schema-snapshot -- --write` and commit the updated snapshot",
    });
  }

  const tables = setDrift(expected.tables, actual.tables);
  if (tables.added.length > 0 || tables.removed.length > 0) {
    findings.push({
      code: "TABLE_DRIFT",
      severity: "error",
      message:
        `tables added: [${tables.added.join(", ")}]; removed: [${tables.removed.join(", ")}]`,
    });
  }

  const indexes = setDrift(expected.indexes, actual.indexes);
  if (indexes.added.length > 0 || indexes.removed.length > 0) {
    findings.push({
      code: "INDEX_DRIFT",
      severity: "error",
      message:
        `indexes added: [${indexes.added.join(", ")}]; removed: [${indexes.removed.join(", ")}]`,
    });
  }

  const migrations = setDrift(expected.migrations.map(migrationKey), actual.migrations.map(migrationKey));
  if (migrations.added.length > 0 || migrations.removed.length > 0) {
    findings.push({
      code: "MIGRATION_DRIFT",
      severity: "error",
      message:
        `migrations added: [${migrations.added.join(", ")}]; removed: [${migrations.removed.join(", ")}]`,
    });
  }

  const ok = findings.every((finding) => finding.severity !== "error");
  return { ok, expected, actual, findings };
}

/** Format a report for CLI / CI logs. No secrets are ever read or printed. */
export function formatSchemaSnapshotReport(report: SchemaSnapshotReport): string {
  const lines: string[] = [`schema snapshot gate: ${report.ok ? "OK" : "FAILED"}`];
  for (const finding of report.findings) {
    const mark = finding.severity === "error" ? "✗" : "!";
    lines.push(`  ${mark} ${finding.code}: ${finding.message}`);
  }
  if (report.actual) {
    lines.push(
      `  · ${report.actual.tables.length} table(s), ${report.actual.indexes.length} index(es), ` +
        `${report.actual.migrations.length} migration(s), fingerprint ${report.actual.fingerprint}`,
    );
  }
  return lines.join("\n");
}

export function schemaSnapshotPath(repoRoot: string, relative = DEFAULT_SCHEMA_SNAPSHOT_RELATIVE): string {
  return path.resolve(repoRoot, relative);
}

/**
 * Load the committed snapshot (if present) and verify it against the snapshot
 * built from the current schema definition.
 */
export function verifyRepoSchemaSnapshot(options: {
  repoRoot: string;
  statements: ReadonlyArray<SchemaStatement>;
  snapshotPath?: string;
}): SchemaSnapshotReport {
  const snapshotPath = schemaSnapshotPath(options.repoRoot, options.snapshotPath);
  let expected: SchemaSnapshot | null = null;
  if (existsSync(snapshotPath)) {
    try {
      expected = loadSchemaSnapshot(snapshotPath);
    } catch (error) {
      return {
        ok: false,
        expected: null,
        actual: null,
        findings: [
          {
            code: "SNAPSHOT_INVALID",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
  const actual = buildSchemaSnapshot(options.statements);
  return verifySchemaSnapshot(expected, actual);
}
