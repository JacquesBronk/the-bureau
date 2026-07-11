# Migration Safety
> Prevent data loss, downtime, and irreversible failures during database schema changes.

## When to Use
Load this tool before writing or reviewing any database migration — schema changes, index additions, column modifications, data migrations, or destructive operations (DROP, TRUNCATE, DELETE).

## Pre-Migration Checklist

Before writing a single line of migration code:

1. **Identify the database engine.** Read project config (database.yml, .env, prisma schema, knex config, alembic.ini). Never assume PostgreSQL vs MySQL vs SQLite — syntax and locking behavior differ.
2. **Read the current schema.** Check migration history, ORM models, and raw DDL. Understand what exists before changing it.
3. **Estimate table size.** Query row counts or check documentation. Operations safe on 1K rows can lock tables for minutes on 10M rows.
4. **Check for dependent objects.** Views, triggers, stored procedures, foreign keys, and ORM mappings that reference the target table.
5. **Verify backup freshness.** For destructive operations, confirm a backup exists and is recent. If no backup strategy exists, flag this before proceeding.

## Writing Migrations

### Every Migration Has Up AND Down

Write the DOWN migration first. If you cannot write a reversible down migration, the change needs explicit approval and a documented roll-forward recovery plan.

Exceptions where down migrations are legitimately impossible:
- Dropping a column that contained irreplaceable data (the down cannot recreate the data)
- One-way data transforms (hashing, encryption)

For these cases, document why in a comment at the top of the migration file.

### Safe Operations (generally non-blocking)

- `ADD COLUMN` with a default (behavior varies by engine — PostgreSQL 11+ handles this without table rewrite; older versions may lock)
- `CREATE INDEX CONCURRENTLY` (PostgreSQL) or equivalent non-blocking index creation
- `CREATE TABLE` (new tables have no existing locks)
- Adding CHECK constraints as `NOT VALID` then validating separately

### Dangerous Operations (may lock tables or lose data)

| Operation | Risk | Mitigation |
|-----------|------|------------|
| `DROP COLUMN` / `DROP TABLE` | Data loss | Verify backup. Use expand-contract: stop writing first, deploy, then drop in a later migration |
| `ALTER COLUMN` type change | Table rewrite + lock | Create new column, backfill, swap. Or use `USING` clause if engine supports it |
| `ADD COLUMN ... NOT NULL` (no default) | Fails on existing rows | Add as nullable, backfill, then add NOT NULL constraint |
| `CREATE INDEX` (without CONCURRENTLY) | Write lock on table | Use `CONCURRENTLY` (PostgreSQL) or schedule during low-traffic window |
| `RENAME COLUMN` / `RENAME TABLE` | Breaks application code | Use expand-contract: add new, migrate code, drop old |
| Large `UPDATE` / `DELETE` | Lock escalation, transaction log bloat | Batch in chunks (1000-10000 rows per transaction) |

### Expand-Contract Pattern

For breaking changes, use the three-phase approach:

1. **Expand**: Add new column/table alongside old. Application writes to both.
2. **Migrate**: Backfill data in batches. Verify consistency.
3. **Contract**: Remove old column/table in a separate, later migration after all code references are updated.

This keeps the application compatible with both old and new schema during deployment.

## Failure Mode Handling

### Partial Migration Failure
The migration ran halfway and crashed. Some tables are altered, others are not.

**Response:**
1. Check which statements executed (migration frameworks often track this).
2. Do NOT re-run the full migration — it will fail on already-applied statements.
3. Either manually complete the remaining statements or write a fixup migration.
4. If the framework supports transactional DDL (PostgreSQL does, MySQL does not for most DDL), check if the partial work was rolled back automatically.

### Deadlock During Migration
The migration is waiting on a lock held by application queries, or vice versa.

**Response:**
1. Identify the blocking query: `pg_stat_activity` (PostgreSQL), `SHOW PROCESSLIST` (MySQL), or equivalent.
2. Determine if the blocker is a long-running transaction or a stuck connection.
3. Consider: set a `lock_timeout` on the migration session to fail fast rather than wait indefinitely.
4. Retry during lower-traffic periods if the table is heavily contended.

### ORM Model Drift
ORM models and actual database schema are out of sync — the migration applies, but the ORM generates incorrect queries.

**Response:**
1. After writing any migration, verify that ORM model definitions match the new schema.
2. Run the ORM's schema diff tool if available (e.g., `prisma db pull`, `alembic check`, `rails db:schema:dump`).
3. Update the ORM model in the same PR as the migration. Never merge a migration without the corresponding model change.

### Parallel Migration Conflicts
Two developers or agents write migrations that modify the same table simultaneously.

**Response:**
1. Check the migration directory for uncommitted or recently-merged migrations targeting the same table.
2. If conflict exists, coordinate: one migration must be applied first and the other rebased.
3. Test both orderings if the migrations are independent. If order-dependent, enforce sequence via naming or dependency declaration.

## Testing Migrations

1. **Apply up on clean database** — the migration must succeed from scratch.
2. **Apply up on seeded database** — the migration must handle existing data (non-empty tables, NULL values, constraint violations).
3. **Apply down** — verify rollback restores the previous schema.
4. **Apply up again after down** — confirm the migration is idempotent through a full cycle.
5. **Check query compatibility** — run the application's key queries against the new schema.

## Iron Law
Never run a destructive migration (DROP, TRUNCATE, DELETE) without verifying that a recent backup exists. "I'll restore from backup" is only a valid plan if the backup is confirmed to exist and is tested.

## Red Flags
- "I'll add the down migration later" — STOP. Write it now. If you can't write it, you don't fully understand the change.
- "This table is small, it won't lock" — STOP. Verify the row count. Small in dev may be large in production.
- "I'll just rename the column directly" — STOP. Use expand-contract. Direct renames break live application code.
- "The ORM will handle it" — STOP. Read the generated SQL. ORMs produce surprising DDL.
- "I'll run this migration during off-hours" — This is a mitigation, not a fix. The migration should be safe to run anytime.
- "Let me just DROP and recreate the table" — STOP. Data loss is permanent. Use ALTER or expand-contract.

## Example: Adding a Required Column

**Bad** — will fail on tables with existing rows:
```sql
ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL;
```

**Good** — safe three-step approach:
```sql
-- Migration 1: Expand
ALTER TABLE users ADD COLUMN email VARCHAR(255);

-- Migration 2: Backfill (run in batches)
UPDATE users SET email = 'unknown@placeholder.local' WHERE email IS NULL;
-- (In practice, backfill from actual data source)

-- Migration 3: Contract
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
```
