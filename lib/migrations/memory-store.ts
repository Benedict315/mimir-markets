/**
 * In-memory migration store for CI, unit tests, and `npm run migrate:* --fixture`.
 *
 * No network, no filesystem, no secrets. Statements are recorded so tests can
 * assert exact up/down SQL, and a minimal SQL simulator handles the ledger
 * plus CREATE/DROP TABLE for the release-migration example.
 */

import type {
  AppliedMigration,
  MigrationStatement,
  MigrationStore,
} from "./types";
import { redactErrorMessage } from "./types";

export interface MemoryStoreOptions {
  /** Seed the ledger with already-applied rows (simulates a deployed env). */
  seedApplied?: readonly AppliedMigration[];
  /**
   * When true, `runInTransaction` throws after recording statements — used to
   * prove the runner surfaces failures without applying a partial ledger write.
   */
  failNextTransaction?: boolean;
}

export class MemoryMigrationStore implements MigrationStore {
  private readonly applied = new Map<number, AppliedMigration>();
  private readonly tables = new Set<string>();
  /** Append-only log of every statement that entered a transaction. */
  readonly executed: MigrationStatement[] = [];
  private failNextTransaction: boolean;

  constructor(options: MemoryStoreOptions = {}) {
    this.failNextTransaction = Boolean(options.failNextTransaction);
    for (const row of options.seedApplied ?? []) {
      this.applied.set(row.schemaVersion, { ...row });
    }
    // Ledger table is always present once ensureLedger runs; seed for realism
    // when tests skip ensureLedger.
    this.tables.add("schema_migrations");
  }

  /** Test helper: force the next transaction to fail. */
  setFailNextTransaction(value: boolean): void {
    this.failNextTransaction = value;
  }

  /** Test helper: which tables currently exist. */
  listTables(): string[] {
    return [...this.tables].sort();
  }

  async ensureLedger(): Promise<void> {
    this.tables.add("schema_migrations");
  }

  async listApplied(): Promise<AppliedMigration[]> {
    return [...this.applied.values()].sort(
      (a, b) => a.schemaVersion - b.schemaVersion,
    );
  }

  async recordApplied(row: AppliedMigration): Promise<void> {
    this.applied.set(row.schemaVersion, { ...row });
  }

  async removeApplied(schemaVersion: number): Promise<void> {
    this.applied.delete(schemaVersion);
  }

  async runInTransaction(
    statements: readonly MigrationStatement[],
  ): Promise<void> {
    // Copy-on-write so a failure leaves prior state intact.
    const tablesSnapshot = new Set(this.tables);
    const executedSnapshotLength = this.executed.length;

    try {
      if (this.failNextTransaction) {
        this.failNextTransaction = false;
        throw new Error("simulated transaction failure");
      }
      for (const stmt of statements) {
        this.applyStatement(stmt);
        this.executed.push({
          sql: stmt.sql,
          args: stmt.args ? [...stmt.args] : undefined,
        });
      }
    } catch (err) {
      this.tables.clear();
      for (const t of tablesSnapshot) this.tables.add(t);
      this.executed.length = executedSnapshotLength;
      const message =
        err instanceof Error ? err.message : "unknown transaction error";
      throw new Error(redactErrorMessage(message));
    }
  }

  private applyStatement(stmt: MigrationStatement): void {
    const sql = stmt.sql.replace(/\s+/g, " ").trim();
    const create = /^CREATE TABLE IF NOT EXISTS ([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(
      sql,
    );
    if (create) {
      this.tables.add(create[1]!);
      return;
    }
    const drop = /^DROP TABLE IF EXISTS ([a-zA-Z_][a-zA-Z0-9_]*)/i.exec(sql);
    if (drop) {
      this.tables.delete(drop[1]!);
      return;
    }
    // Ledger INSERT/DELETE and other DML are no-ops for the table set; the
    // runner records applied rows via recordApplied/removeApplied.
    if (
      /^INSERT INTO schema_migrations/i.test(sql) ||
      /^DELETE FROM schema_migrations/i.test(sql) ||
      /^ALTER TABLE /i.test(sql) ||
      /^UPDATE /i.test(sql) ||
      /^COMMENT ON /i.test(sql)
    ) {
      return;
    }
    // Unknown SQL is accepted but recorded — keeps the store useful as a
    // statement recorder for migrations that only touch the ledger conceptually.
  }
}
