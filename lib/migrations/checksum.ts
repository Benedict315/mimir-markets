/**
 * Checksum helpers for reversible migrations.
 *
 * The checksum is a SHA-256 over a canonical serialization of the migration
 * (id, version, up, down, irreversible flag). Rewriting SQL after a migration
 * has been applied is detected as a checksum mismatch and fails closed.
 */

import { createHash } from "node:crypto";

import type { Migration, MigrationStatement } from "./types";

function canonicalizeStatement(stmt: MigrationStatement): unknown {
  return {
    sql: stmt.sql.replace(/\s+/g, " ").trim(),
    args: stmt.args ?? [],
  };
}

/** Canonical JSON used as the checksum input. Stable across key order. */
export function canonicalizeMigration(migration: Migration): string {
  const payload = {
    id: migration.id,
    version: migration.version,
    description: migration.description,
    up: migration.up.map(canonicalizeStatement),
    down: migration.down.map(canonicalizeStatement),
    irreversible: Boolean(migration.irreversible),
    irreversibleReason: migration.irreversibleReason ?? "",
  };
  return JSON.stringify(payload);
}

export function checksumMigration(migration: Migration): string {
  return createHash("sha256")
    .update(canonicalizeMigration(migration), "utf8")
    .digest("hex");
}
