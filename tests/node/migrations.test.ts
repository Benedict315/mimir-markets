/**
 * Reversible release migration tests.
 *
 * Coverage:
 *  - Registry: versions unique, reversible migrations have non-empty down
 *  - Checksums: stable for unchanged migrations; change when SQL changes
 *  - Plan: up applies pending only; down peels latest first
 *  - Positive: full up → reversible down → up cycle on fixture store
 *  - Negative: irreversible down blocked without --force-destructive
 *  - Failure: transaction errors do not record a partial ledger row
 *  - Regression: secrets in errors are redacted; empty-down reversible refused
 *
 * All tests are deterministic — no network, no DATABASE_URL, no secrets.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryMigrationStore,
  MIGRATIONS,
  checksumMigration,
  getStatus,
  migrateDown,
  migrateUp,
  planMigrateDown,
  planMigrateUp,
  redactErrorMessage,
  appearsToContainSecret,
  type Migration,
} from "../../lib/migrations";

const FIXED_NOW = 1_700_000_000_000;

function runnerOpts() {
  return { nowMs: () => FIXED_NOW };
}

test("registry: versions are unique and monotonic starting at 1", () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(versions[0], 1);
});

test("registry: every migration has up SQL; reversible ones have down SQL", () => {
  for (const m of MIGRATIONS) {
    assert.ok(m.up.length > 0, `${m.id} missing up`);
    if (!m.irreversible) {
      assert.ok(m.down.length > 0, `${m.id} missing down`);
    } else {
      assert.ok(m.irreversibleReason, `${m.id} missing irreversibleReason`);
    }
  }
});

test("checksum: stable for a given migration and changes when SQL changes", () => {
  const base = MIGRATIONS.find((m) => m.version === 3)!;
  const a = checksumMigration(base);
  const b = checksumMigration(base);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);

  const tweaked: Migration = {
    ...base,
    up: [...base.up, { sql: "COMMENT ON TABLE release_migration_events IS 'x'" }],
  };
  assert.notEqual(checksumMigration(tweaked), a);
});

test("plan up: pending versions only, in ascending order", () => {
  const plan = planMigrateUp([1]);
  assert.equal(plan.direction, "up");
  assert.deepEqual(
    plan.steps.map((s) => s.version),
    MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version),
  );
});

test("plan down: peels highest applied first", () => {
  const plan = planMigrateDown([1, 2, 3], { steps: 2 });
  assert.equal(plan.direction, "down");
  assert.deepEqual(
    plan.steps.map((s) => s.version),
    [3, 2],
  );
  assert.equal(plan.targetVersion, 1);
});

test("positive: fixture up applies all registered migrations", async () => {
  const store = new MemoryMigrationStore();
  const result = await migrateUp(store, runnerOpts());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.appliedVersions,
    MIGRATIONS.map((m) => m.version),
  );
  assert.ok(store.listTables().includes("release_migration_events"));
  assert.ok(store.listTables().includes("schema_migrations"));
});

test("positive: reversible head can be rolled back and re-applied", async () => {
  const store = new MemoryMigrationStore();
  await migrateUp(store, runnerOpts());
  const down = await migrateDown(store, { ...runnerOpts(), steps: 1 });
  assert.equal(down.ok, true);
  assert.deepEqual(down.appliedVersions, [1, 2]);
  assert.ok(!store.listTables().includes("release_migration_events"));

  const up = await migrateUp(store, runnerOpts());
  assert.equal(up.ok, true);
  assert.deepEqual(
    up.appliedVersions,
    MIGRATIONS.map((m) => m.version),
  );
  assert.ok(store.listTables().includes("release_migration_events"));
});

test("negative: irreversible down is blocked without forceDestructive", async () => {
  const store = new MemoryMigrationStore();
  // Apply only through v2 so the next down hits an irreversible migration.
  await migrateUp(store, runnerOpts());
  await migrateDown(store, { ...runnerOpts(), steps: 1 }); // revert v3
  const blocked = await migrateDown(store, { ...runnerOpts(), steps: 1 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.steps[0]?.status, "failed");
  assert.match(blocked.steps[0]?.error ?? "", /irreversible down blocked/);
  assert.deepEqual(blocked.appliedVersions, [1, 2]);
});

test("negative: forceDestructive allows irreversible down (explicit escape hatch)", async () => {
  const store = new MemoryMigrationStore();
  await migrateUp(store, runnerOpts());
  await migrateDown(store, { ...runnerOpts(), steps: 1 }); // v3
  const forced = await migrateDown(store, {
    ...runnerOpts(),
    steps: 1,
    forceDestructive: true,
  });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.appliedVersions, [1]);
});

test("failure: transaction error does not record the migration as applied", async () => {
  const store = new MemoryMigrationStore();
  store.setFailNextTransaction(true);
  const result = await migrateUp(store, runnerOpts());
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.status, "failed");
  assert.deepEqual(result.appliedVersions, []);
});

test("failure: checksum mismatch on applied row fails status closed", async () => {
  const v3 = MIGRATIONS.find((m) => m.version === 3)!;
  const store = new MemoryMigrationStore({
    seedApplied: [
      {
        migrationId: v3.id,
        schemaVersion: 3,
        checksum: "0".repeat(64),
        appliedAt: FIXED_NOW,
      },
    ],
  });
  const status = await getStatus(store);
  assert.equal(status.checksumsOk, false);
  assert.ok(status.issues.some((i) => i.includes("checksum mismatch")));
  await assert.rejects(() => migrateUp(store, runnerOpts()), /checksum mismatch/);
});

test("regression: redactErrorMessage strips connection strings and tokens", () => {
  const raw =
    "fail postgres://user:secret@host/db DATABASE_URL=postgres://x Bearer abc.def.ghi ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
  const cleaned = redactErrorMessage(raw);
  assert.equal(appearsToContainSecret(raw), true);
  assert.doesNotMatch(cleaned, /secret@host/);
  assert.doesNotMatch(cleaned, /ghp_ABCDEF/);
  assert.match(cleaned, /\[redacted\]/);
});

test("regression: refusing empty-down reversible migration at apply time", async () => {
  const bad: Migration = {
    id: "999_bad",
    version: 999,
    description: "bad",
    up: [{ sql: "CREATE TABLE IF NOT EXISTS bad_table (id TEXT PRIMARY KEY)" }],
    down: [],
  };
  // Bypass registry validation by calling migrateUp with only this migration
  // after seeding empty store — validateRegistry should catch it in getStatus.
  const store = new MemoryMigrationStore();
  await assert.rejects(
    () => migrateUp(store, { ...runnerOpts(), migrations: [bad] }),
    /non-empty down/,
  );
});

test("status: clean fixture reports pending then applied after up", async () => {
  const store = new MemoryMigrationStore();
  const before = await getStatus(store);
  assert.deepEqual(
    before.pendingVersions,
    MIGRATIONS.map((m) => m.version),
  );
  assert.equal(before.headVersion, null);
  await migrateUp(store, runnerOpts());
  const after = await getStatus(store);
  assert.deepEqual(after.pendingVersions, []);
  assert.equal(after.headVersion, Math.max(...MIGRATIONS.map((m) => m.version)));
  assert.equal(after.checksumsOk, true);
  assert.equal(after.issues.length, 0);
});
