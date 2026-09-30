/**
 * Shared types for reversible release migrations.
 *
 * Migrations are plain data: an id, a monotonic schema version, forward (`up`)
 * SQL, and reverse (`down`) SQL. Nothing here touches Postgres or the
 * filesystem — that keeps the types safe to import from tests and CI without
 * credentials.
 *
 * Design rules:
 * - Every release migration MUST ship a non-empty `down` (or declare
 *   `irreversible: true` with an explicit reason). Fail-closed: the runner
 *   refuses to apply a reversible migration that has an empty down list.
 * - Checksums cover id + version + up + down so a silently rewritten migration
 *   fails verification instead of being re-applied or skipped.
 * - Secrets never appear in migration SQL, logs, or status output.
 */

/** One parameterized SQL statement. `$1`-style placeholders match `lib/db.ts`. */
export interface MigrationStatement {
  sql: string;
  args?: ReadonlyArray<string | number | boolean | null>;
}

/**
 * A single schema change that can be applied and rolled back.
 *
 * Versions are monotonic integers. Id is a stable slug used as the primary key
 * in `schema_migrations.migration_id`.
 */
export interface Migration {
  /** Stable slug, e.g. `003_release_migration_events`. */
  id: string;
  /** Monotonic schema version recorded in `schema_migrations.schema_version`. */
  version: number;
  /** Short human description for status / docs. */
  description: string;
  /** Forward statements, applied in order inside a transaction. */
  up: readonly MigrationStatement[];
  /**
   * Reverse statements, applied in order inside a transaction.
   * Must undo `up` exactly when `irreversible` is false.
   */
  down: readonly MigrationStatement[];
  /**
   * When true, `migrate down` refuses this version unless
   * `--force-destructive` is passed. Use only for baseline / data-loss downs.
   */
  irreversible?: boolean;
  /** Required when `irreversible` is true — shown in status and error text. */
  irreversibleReason?: string;
}

/** Row shape matching the existing `schema_migrations` ledger in `lib/db.ts`. */
export interface AppliedMigration {
  migrationId: string;
  schemaVersion: number;
  checksum: string;
  appliedAt: number;
}

export type MigrateDirection = "up" | "down";

export type MigrateStepStatus = "applied" | "reverted" | "skipped" | "failed";

export interface MigrateStepResult {
  migrationId: string;
  version: number;
  direction: MigrateDirection;
  status: MigrateStepStatus;
  checksum: string;
  /** Milliseconds spent on this step (0 for skipped). */
  durationMs: number;
  error?: string;
}

export interface MigratePlan {
  direction: MigrateDirection;
  /** Migrations that will run, in execution order. */
  steps: readonly Migration[];
  /** Already-applied versions before the plan runs. */
  currentlyApplied: readonly number[];
  /** Target head version after a successful run (null = empty ledger). */
  targetVersion: number | null;
}

export interface MigrateResult {
  ok: boolean;
  direction: MigrateDirection;
  steps: readonly MigrateStepResult[];
  /** Applied versions after the run. */
  appliedVersions: readonly number[];
  /** Privacy-safe summary suitable for CI logs. */
  summary: string;
}

export interface MigrationStatus {
  registered: readonly {
    id: string;
    version: number;
    description: string;
    checksum: string;
    irreversible: boolean;
    applied: boolean;
    checksumMatches: boolean | null;
  }[];
  applied: readonly AppliedMigration[];
  headVersion: number | null;
  pendingVersions: readonly number[];
  /** True when every applied row's checksum matches the registry. */
  checksumsOk: boolean;
  /** Actionable, privacy-safe issues (no secrets, no connection strings). */
  issues: readonly string[];
}

/**
 * Persistence port for the runner. Implementations must be free of secret
 * leakage in thrown errors (redact connection strings / passwords).
 */
export interface MigrationStore {
  /** Ensure the ledger table exists (idempotent). */
  ensureLedger(): Promise<void>;
  listApplied(): Promise<AppliedMigration[]>;
  recordApplied(row: AppliedMigration): Promise<void>;
  removeApplied(schemaVersion: number): Promise<void>;
  /**
   * Run statements inside a single transaction. On failure the whole batch
   * must roll back and the promise must reject.
   */
  runInTransaction(statements: readonly MigrationStatement[]): Promise<void>;
}

/** Redact anything that looks like a secret or connection string. */
export function redactErrorMessage(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s)'"]+/gi, "postgres://[redacted]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[redacted]")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

/** True when a string looks like it might contain a secret (fail-closed logging). */
export function appearsToContainSecret(value: string): boolean {
  if (/postgres(?:ql)?:\/\//i.test(value)) return true;
  if (/DATABASE_URL=/i.test(value)) return true;
  if (/ghp_[A-Za-z0-9]{20,}/.test(value)) return true;
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\./.test(value)) return true;
  if (/password\s*=\s*\S+/i.test(value)) return true;
  return false;
}
