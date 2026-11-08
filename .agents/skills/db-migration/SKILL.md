---
name: db-migration
description: Design and implement safe LoyalPro PostgreSQL schema or data migrations. Use whenever a task adds, changes, backfills, indexes, or removes database schema or persistent data, especially for multi-salon, bonus, booking, chat, or patient-data tables.
---

# Safe database migration

1. Read `AGENTS.md` and inspect `backend/migrations.js`, the affected queries, and all call sites before changing a schema.
2. State the data model change, affected tenants, compatibility strategy, expected lock/performance risk, verification, and rollback or recovery path.
3. Prefer additive, idempotent migrations using the repository conventions (`IF NOT EXISTS`, `DO NOTHING`). Keep application reads and writes compatible with both pre- and post-migration states during deployment.
4. Include `salon_id` in tenant-owned records, indexes, and query plans. Do not create an unscoped cross-salon access path.
5. Do not run destructive SQL, production backfills, or live schema changes without explicit approval. Use PostgreSQL MCP against test or staging data for inspection when available; never put connection secrets in code or output.
6. Add a focused migration or query regression test when feasible. For a backfill, make it idempotent, batched, observable, and safe to resume.
7. Hand off the exact migration behavior, deployment order, verification query or check, and any operation that still requires human approval.
