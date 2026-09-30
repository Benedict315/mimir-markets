/**
 * Reversible migration runner.
 *
 * Applies or reverts registered migrations through a MigrationStore. The
 * default path is offline-safe (MemoryMigrationStore) so CI and contributors
 * can rehearse release up/down without DATABASE_URL or production secrets.
 *
 * Failure policy (fail-closed):
 * - Refuse to apply a migration whose `down` is empty unless `irreversible`.
 * - Refuse checksum mismatches on already-applied rows.
 * - Refuse out-of-order ups and downs that would leave gaps.
 * - Refuse irreversible downs unless `forceDestructive` is set.
 * - Never echo connection strings or secrets in error text.
 */

import { checksumMigration } from "./checksum";
import { MIGRATIONS, latestRegisteredVersion } from "./registry";
import type {
  AppliedMigration,
  MigratePlan,
  MigrateResult,
  MigrateStepResult,
  Migration,
  MigrationStatus,
  MigrationStore,
} from "./types";
import { appearsToContainSecret, redactErrorMessage } from "./types";

export interface RunnerOptions {
  /** Stop after the first failed step (default true). */
  failFast?: boolean;
  /** Allow down on migrations marked irreversible (default false). */
  forceDestructive?: boolean;
  /** Override clock for deterministic tests. */
  nowMs?: () => number;
  /** Override registry (tests). */
  migrations?: readonly Migration[];
}

function sortedMigrations(
  migrations: readonly Migration[],
): Migration[] {
  return [...migrations].sort((a, b) => a.version - b.version);
}

function validateRegistry(migrations: readonly Migration[]): string[] {
  const issues: string[] = [];
  const seenVersions = new Set<number>();
  const seenIds = new Set<string>();
  for (const m of sortedMigrations(migrations)) {
    if (seenVersions.has(m.version)) {
      issues.push(`duplicate schema version ${m.version}`);
    }
    seenVersions.add(m.version);
    if (seenIds.has(m.id)) {
      issues.push(`duplicate migration id ${m.id}`);
    }
    seenIds.add(m.id);
    if (m.up.length === 0) {
      issues.push(`${m.id}: up statements must not be empty`);
    }
    if (!m.irreversible && m.down.length === 0) {
      issues.push(
        `${m.id}: reversible migrations must ship a non-empty down (fail-closed)`,
      );
    }
    if (m.irreversible && !m.irreversibleReason) {
      issues.push(`${m.id}: irreversible migrations need irreversibleReason`);
    }
    if (appearsToContainSecret(JSON.stringify(m.up)) || appearsToContainSecret(JSON.stringify(m.down))) {
      issues.push(`${m.id}: migration SQL must not embed secrets`);
    }
  }
  return issues;
}

export function planMigrateUp(
  appliedVersions: readonly number[],
  options: RunnerOptions = {},
): MigratePlan {
  const migrations = sortedMigrations(options.migrations ?? MIGRATIONS);
  const applied = new Set(appliedVersions);
  const steps = migrations.filter((m) => !applied.has(m.version));
  const target =
    steps.length > 0
      ? steps[steps.length - 1]!.version
      : appliedVersions.length > 0
        ? Math.max(...appliedVersions)
        : null;
  return {
    direction: "up",
    steps,
    currentlyApplied: [...appliedVersions].sort((a, b) => a - b),
    targetVersion: target,
  };
}

export function planMigrateDown(
  appliedVersions: readonly number[],
  options: RunnerOptions & { steps?: number; toVersion?: number | null } = {},
): MigratePlan {
  const migrations = sortedMigrations(options.migrations ?? MIGRATIONS);
  const appliedSorted = [...appliedVersions].sort((a, b) => a - b);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  let remaining = appliedSorted;
  if (options.toVersion !== undefined) {
    const target = options.toVersion;
    remaining = appliedSorted.filter((v) => target === null || v > target);
  } else {
    const count = options.steps ?? 1;
    remaining = appliedSorted.slice(-count);
  }

  // Down runs highest version first.
  const steps = remaining
    .slice()
    .sort((a, b) => b - a)
    .map((v) => byVersion.get(v))
    .filter((m): m is Migration => Boolean(m));

  const after = appliedSorted.filter((v) => !remaining.includes(v));
  return {
    direction: "down",
    steps,
    currentlyApplied: appliedSorted,
    targetVersion: after.length > 0 ? Math.max(...after) : null,
  };
}

export async function getStatus(
  store: MigrationStore,
  options: RunnerOptions = {},
): Promise<MigrationStatus> {
  const migrations = sortedMigrations(options.migrations ?? MIGRATIONS);
  const registryIssues = validateRegistry(migrations);
  await store.ensureLedger();
  const applied = await store.listApplied();
  const appliedByVersion = new Map(applied.map((r) => [r.schemaVersion, r]));
  const issues = [...registryIssues];

  const registered = migrations.map((m) => {
    const row = appliedByVersion.get(m.version);
    const checksum = checksumMigration(m);
    let checksumMatches: boolean | null = null;
    if (row) {
      checksumMatches = row.checksum === checksum && row.migrationId === m.id;
      if (!checksumMatches) {
        issues.push(
          `checksum mismatch for version ${m.version} (${m.id}): ledger does not match registry — refuse to continue`,
        );
      }
    }
    return {
      id: m.id,
      version: m.version,
      description: m.description,
      checksum,
      irreversible: Boolean(m.irreversible),
      applied: Boolean(row),
      checksumMatches,
    };
  });

  // Orphan ledger rows (applied but not in registry) are fail-closed.
  for (const row of applied) {
    if (!migrations.some((m) => m.version === row.schemaVersion)) {
      issues.push(
        `orphan applied version ${row.schemaVersion} (${row.migrationId}) not in registry`,
      );
    }
  }

  const appliedVersions = applied.map((r) => r.schemaVersion);
  const pendingVersions = migrations
    .filter((m) => !appliedByVersion.has(m.version))
    .map((m) => m.version);

  return {
    registered,
    applied,
    headVersion:
      appliedVersions.length > 0 ? Math.max(...appliedVersions) : null,
    pendingVersions,
    checksumsOk: issues.every((i) => !i.includes("checksum mismatch")),
    issues,
  };
}

async function assertReadyForRun(
  store: MigrationStore,
  options: RunnerOptions,
): Promise<{ applied: AppliedMigration[]; migrations: Migration[] }> {
  const status = await getStatus(store, options);
  if (status.issues.length > 0) {
    throw new Error(status.issues.join("; "));
  }
  return {
    applied: [...status.applied],
    migrations: sortedMigrations(options.migrations ?? MIGRATIONS),
  };
}

export async function migrateUp(
  store: MigrationStore,
  options: RunnerOptions = {},
): Promise<MigrateResult> {
  const failFast = options.failFast !== false;
  const nowMs = options.nowMs ?? (() => Date.now());
  const { applied } = await assertReadyForRun(store, options);
  const plan = planMigrateUp(
    applied.map((r) => r.schemaVersion),
    options,
  );
  const stepResults: MigrateStepResult[] = [];

  for (const migration of plan.steps) {
    const checksum = checksumMigration(migration);
    const started = nowMs();
    try {
      if (!migration.irreversible && migration.down.length === 0) {
        throw new Error(
          `${migration.id}: refusing to apply reversible migration with empty down`,
        );
      }
      await store.runInTransaction(migration.up);
      const row: AppliedMigration = {
        migrationId: migration.id,
        schemaVersion: migration.version,
        checksum,
        appliedAt: nowMs(),
      };
      await store.recordApplied(row);
      stepResults.push({
        migrationId: migration.id,
        version: migration.version,
        direction: "up",
        status: "applied",
        checksum,
        durationMs: Math.max(0, nowMs() - started),
      });
    } catch (err) {
      const error = redactErrorMessage(
        err instanceof Error ? err.message : "unknown error",
      );
      stepResults.push({
        migrationId: migration.id,
        version: migration.version,
        direction: "up",
        status: "failed",
        checksum,
        durationMs: Math.max(0, nowMs() - started),
        error,
      });
      if (failFast) break;
    }
  }

  const after = await store.listApplied();
  const ok = stepResults.every((s) => s.status !== "failed");
  return {
    ok,
    direction: "up",
    steps: stepResults,
    appliedVersions: after.map((r) => r.schemaVersion),
    summary: summarize(stepResults, "up", after.map((r) => r.schemaVersion)),
  };
}

export async function migrateDown(
  store: MigrationStore,
  options: RunnerOptions & { steps?: number; toVersion?: number | null } = {},
): Promise<MigrateResult> {
  const failFast = options.failFast !== false;
  const nowMs = options.nowMs ?? (() => Date.now());
  const { applied } = await assertReadyForRun(store, options);
  const plan = planMigrateDown(
    applied.map((r) => r.schemaVersion),
    options,
  );
  const stepResults: MigrateStepResult[] = [];

  for (const migration of plan.steps) {
    const checksum = checksumMigration(migration);
    const started = nowMs();
    try {
      if (migration.irreversible && !options.forceDestructive) {
        throw new Error(
          `${migration.id}: irreversible down blocked (${migration.irreversibleReason ?? "destructive"}). Pass --force-destructive to override.`,
        );
      }
      if (!migration.irreversible && migration.down.length === 0) {
        throw new Error(
          `${migration.id}: cannot reverse — down statements are empty`,
        );
      }
      await store.runInTransaction(migration.down);
      await store.removeApplied(migration.version);
      stepResults.push({
        migrationId: migration.id,
        version: migration.version,
        direction: "down",
        status: "reverted",
        checksum,
        durationMs: Math.max(0, nowMs() - started),
      });
    } catch (err) {
      const error = redactErrorMessage(
        err instanceof Error ? err.message : "unknown error",
      );
      stepResults.push({
        migrationId: migration.id,
        version: migration.version,
        direction: "down",
        status: "failed",
        checksum,
        durationMs: Math.max(0, nowMs() - started),
        error,
      });
      if (failFast) break;
    }
  }

  const after = await store.listApplied();
  const ok = stepResults.every((s) => s.status !== "failed");
  return {
    ok,
    direction: "down",
    steps: stepResults,
    appliedVersions: after.map((r) => r.schemaVersion),
    summary: summarize(stepResults, "down", after.map((r) => r.schemaVersion)),
  };
}

function summarize(
  steps: readonly MigrateStepResult[],
  direction: "up" | "down",
  appliedVersions: readonly number[],
): string {
  const failed = steps.filter((s) => s.status === "failed").length;
  const done = steps.filter((s) => s.status === "applied" || s.status === "reverted").length;
  const head =
    appliedVersions.length > 0 ? Math.max(...appliedVersions) : "none";
  return `migrate ${direction}: ${done} ok, ${failed} failed, head=${head}, registered_latest=${latestRegisteredVersion()}`;
}
