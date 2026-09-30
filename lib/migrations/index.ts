/**
 * Reversible release migrations — public API.
 *
 * Offline-safe by default via MemoryMigrationStore. Use the CLI
 * (`npm run migrate:status` / `migrate:up` / `migrate:down`) for release
 * rehearsals without production secrets.
 */

export { checksumMigration, canonicalizeMigration } from "./checksum";
export { MemoryMigrationStore } from "./memory-store";
export {
  MIGRATIONS,
  getMigrationById,
  getMigrationByVersion,
  latestRegisteredVersion,
} from "./registry";
export {
  getStatus,
  migrateDown,
  migrateUp,
  planMigrateDown,
  planMigrateUp,
} from "./runner";
export type { RunnerOptions } from "./runner";
export type {
  AppliedMigration,
  MigrateDirection,
  MigratePlan,
  MigrateResult,
  MigrateStepResult,
  Migration,
  MigrationStatement,
  MigrationStatus,
  MigrationStore,
} from "./types";
export { appearsToContainSecret, redactErrorMessage } from "./types";
