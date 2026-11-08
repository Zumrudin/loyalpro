---
name: feature-delivery
description: Deliver a LoyalPro product feature from an approved request or specification through a narrow implementation, focused automated verification, and handoff. Use for new backend, admin UI, mobile, loyalty, reminder, integration, or AI-agent functionality that changes user-visible behavior.
---

# Feature delivery

1. Read `AGENTS.md`, then `CLAUDE.md`. Locate an applicable specification under `docs/superpowers/specs/` or plan under `docs/superpowers/plans/`; ask before resolving a material product ambiguity.
2. Identify the affected user roles, API contract, tenant boundary, external side effects, and likely regression path. State a concise implementation plan before editing.
3. Implement the smallest compatible change. Preserve existing role checks, `salon_id` isolation, service-layer integration boundaries, and `Europe/Moscow` scheduling semantics.
4. If changing schema, invoke `$db-migration`. If changing user-visible UI, invoke `$qa-e2e`. If the feature touches patient data, authentication, payments, messages, bookings, bonuses, or public webhooks, invoke `$security-privacy-review` before handoff.
5. Add or update focused tests for the changed behavior and its important failure path. Do not use real patient data or cause external effects while testing.
6. Update the relevant specification, plan, or runbook only when the implementation changes a durable behavior or operating procedure.
7. Hand off with: behavior delivered, changed files, verification performed, compatibility notes, and any follow-up risk.
