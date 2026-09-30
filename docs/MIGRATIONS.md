# Reversible release migrations

Make every release schema change **apply forward and roll back** with a
checksummed ledger, without requiring production secrets to rehearse.

This complements [`docs/RELEASE_READINESS.md`](./RELEASE_READINESS.md) (when
present) and the deployment rollback rehearsal: migrations cover the Postgres
projection schema; rollback rehearsal covers contract ids / feature flags.

---

## Why this exists

`lib/db.ts` still bootstraps tables with `CREATE TABLE IF NOT EXISTS` via
`ensureSchema`. That path is not reversible. Release work needs an explicit
up/down chain so operators can:

- Rehearse a migration from a clean checkout (CI / contributor laptop).
- Roll back the latest *reversible* release migration if a deploy fails.
- Detect rewritten history via checksum mismatch (fail-closed).
- Keep irreversible baselines (ledger + base platform marker) blocked unless
  an operator passes `--force-destructive`.

---

## Quick start (no secrets)

```bash
# Show registered vs applied (fixture store).
npm run migrate:status

# Apply all pending migrations in memory.
npm run migrate:up

# Revert the latest reversible migration (v3 today).
npm run migrate:down

# Full verify: registry checks + up → down(reversible) → up cycle.
npm run migrate:verify
```

All of the above default to `--fixture` (in-memory). They exit `0` on success
and `1` on checksum / step failure. Nothing reads `DATABASE_URL`.

---

## How it works

```
registry (lib/migrations/registry.ts)
    ↓
runner plan (up ascending / down descending)
    ↓
MigrationStore transaction (MemoryMigrationStore in fixture mode)
    ↓
schema_migrations ledger row written or removed
```

| Version | Id | Reversible? | Role |
| --- | --- | --- | --- |
| 1 | `001_schema_migrations_ledger` | No (destructive escape hatch) | Creates the ledger table |
| 2 | `base-platform-schema-v2` | No (destructive escape hatch) | Aligns with the existing `lib/db.ts` marker |
| 3 | `003_release_migration_events` | **Yes** | Audit table for release up/down events |

---

## Adding a release migration

1. Append a new object to `MIGRATIONS` in `lib/migrations/registry.ts`.
2. Give it the next integer `version`, a stable `id`, and a short `description`.
3. Write `up` SQL that is safe to run once (prefer `IF NOT EXISTS` / guarded DDL).
4. Write `down` SQL that undoes `up` exactly. If that is impossible without
   data loss, set `irreversible: true` and an `irreversibleReason`.
5. Never embed secrets, connection strings, or live credentials in SQL.
6. Add / extend tests in `tests/node/migrations.test.ts`.
7. Run `npm run migrate:verify` and `npm run test:smoke`.

Do **not** edit SQL for a version that may already be applied in any
environment — add a new version instead. Checksum mismatches fail closed.

---

## Failure behaviour

| Condition | Behaviour |
| --- | --- |
| Reversible migration with empty `down` | Registry / apply refused |
| Checksum mismatch vs ledger | Status + migrate refuse |
| Down on irreversible without flag | Step fails with actionable message |
| Transaction error mid-up | Ledger row not recorded; prior state kept |
| Secrets in error text | Redacted before surfacing |

---

## Relation to `lib/db.ts`

`ensureSchema` remains the bootstrapping path for application runtime. The
migration runner is the **release control plane**: it records versions, proves
reversibility for new changes, and blocks unsafe downs. Version `2` matches the
existing `base-platform-schema-v2` ledger seed so both stay aligned.

---

## Operational impact

- **Release:** run `npm run migrate:verify` in CI / pre-release; treat failures
  as a hard gate for schema-changing releases.
- **Rollback:** `npm run migrate:down` reverts the latest reversible migration
  only. Baseline versions stay blocked on purpose.
- **Secrets / env:** fixture mode never needs `DATABASE_URL`. Do not paste
  connection strings into issues, PR bodies, or migration SQL.
