# LoyalPro: agent guidance

## Scope and source of truth

- Read `CLAUDE.md` before changing code. It contains the architecture, integration constraints, and current verification commands.
- Treat `docs/superpowers/specs/` and `docs/superpowers/plans/` as the source of truth for a feature when a relevant document exists.
- Keep changes narrow. Do not refactor unrelated code while implementing a feature or a fix.

## Required workflow

1. For a task with more than one clear change, inspect the relevant code and state a short plan before editing.
2. Implement with backward-compatible API and database behavior unless an approved specification explicitly says otherwise.
3. Run the smallest relevant automated checks. Run API/unit tests for backend behavior, `npm run lint` for mobile changes, and a browser check for a user-visible staff UI change when the required MCP is available.
4. Report changed files, checks run, and checks not run. Do not claim an unrun check passed.

## Data, security, and production safety

- This is a multi-salon system: scope every tenant-owned query and write by `salon_id`; never trust a client-supplied tenant id.
- Do not expose credentials, tokens, patient data, phone numbers, message content, or database URLs in source, logs, tests, documentation, or chat output.
- Never modify production data, send a patient message, create or move a booking, accrue or debit bonuses, delete files, or restart/deploy services without explicit user approval for that exact operation.
- Use the PostgreSQL MCP for direct database queries when available. Prefer test or staging data and read-only queries. Do not run destructive SQL as investigation.
- Preserve auth and role checks. Validate webhook signatures or shared secrets when an integration supports them, apply rate limits to public endpoints, and keep public webhook handlers fast.

## Database and integrations

- Put schema changes in `backend/migrations.js`. Prefer additive, idempotent migrations (`IF NOT EXISTS` / `DO NOTHING`); include a compatibility and rollback plan before any destructive change.
- Keep all external calls behind the existing service layer. Make retries and idempotency explicit for YClients, ChatPush, payment, and messaging effects.
- Do not invent medical facts or treatment advice. Escalate clinical questions to a person.

## Review priorities

- Check tenant isolation, authorization, duplicate side effects, time zone handling (`Europe/Moscow` where required), stale external data, and test coverage for an observed regression.
- Use repository guidance for code review; CI and linters remain the enforcement mechanism for mechanical checks.
