/**
 * Registered release migrations for Mimir.
 *
 * Version 1 is the ledger itself (matches `schema_migrations` in `lib/db.ts`).
 * Version 2 is the existing base-platform marker already inserted by
 * `SCHEMA_STATEMENTS` (`base-platform-schema-v2`).
 * Version 3 adds a reversible release-migration audit table so operators can
 * see which up/down ran during a release without needing production secrets
 * to rehearse locally (fixture mode uses MemoryMigrationStore).
 *
 * New release migrations MUST append here with both `up` and `down`. Do not
 * rewrite applied migrations — add a new version instead.
 */

import type { Migration } from "./types";

/**
 * Keep ids and checksums stable: changing SQL of an already-shipped version
 * breaks `migrate:verify` on every environment that applied the old checksum.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_schema_migrations_ledger",
    version: 1,
    description:
      "Create the schema_migrations ledger used by release up/down tooling",
    up: [
      {
        sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL UNIQUE,
    checksum TEXT NOT NULL UNIQUE,
    applied_at BIGINT NOT NULL
  )`,
      },
    ],
    down: [
      {
        sql: "DROP TABLE IF EXISTS schema_migrations",
      },
    ],
    irreversible: true,
    irreversibleReason:
      "Dropping the ledger removes migration history; refuse unless --force-destructive",
  },
  {
    id: "base-platform-schema-v2",
    version: 2,
    description:
      "Base platform schema marker (claims, agents, baskets, projections) — matches lib/db.ts seed",
    up: [
      {
        // Marker only: actual CREATE TABLE IF NOT EXISTS statements live in
        // lib/db.ts ensureSchema. Recording the marker keeps the reversible
        // runner aligned with the existing ledger row.
        sql: "COMMENT ON TABLE schema_migrations IS 'base-platform-schema-v2 marker'",
      },
    ],
    down: [
      {
        sql: "COMMENT ON TABLE schema_migrations IS NULL",
      },
    ],
    irreversible: true,
    irreversibleReason:
      "Reversing the base platform schema would drop funded-feature tables; refuse unless --force-destructive",
  },
  {
    id: "003_release_migration_events",
    version: 3,
    description:
      "Append-only audit log of release migration up/down events (reversible)",
    up: [
      {
        sql: `CREATE TABLE IF NOT EXISTS release_migration_events (
    event_id TEXT PRIMARY KEY,
    schema_version SMALLINT NOT NULL,
    migration_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    checksum TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    error_code TEXT,
    created_at BIGINT NOT NULL
  )`,
      },
    ],
    down: [
      {
        sql: "DROP TABLE IF EXISTS release_migration_events",
      },
    ],
  },
];

export function getMigrationByVersion(version: number): Migration | undefined {
  return MIGRATIONS.find((m) => m.version === version);
}

export function getMigrationById(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}

/** Highest registered version. */
export function latestRegisteredVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}
