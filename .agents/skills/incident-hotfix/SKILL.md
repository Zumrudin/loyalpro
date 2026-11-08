---
name: incident-hotfix
description: Investigate and safely fix a LoyalPro production incident or urgent regression with minimal blast radius, evidence-based diagnosis, targeted tests, and an operational handoff. Use for broken workflows, incorrect bonuses, booking or message defects, failed syncs, outages, data inconsistencies, or security incidents.
---

# Incident hotfix

1. Capture the observed symptom, scope, time window, tenant impact, and safe reproduction. Read `AGENTS.md`, `CLAUDE.md`, logs, and relevant recent changes before proposing a cause.
2. Protect people and data first. Do not send messages, alter bookings, manipulate bonuses, restart services, or edit production data without explicit approval. Keep webhook handlers responsive and avoid actions that amplify retries.
3. Form and test the smallest evidence-based hypothesis. Prefer read-only inspection and deterministic local or staging reproduction over speculative production changes.
4. Implement the smallest safe fix. Preserve API compatibility, role checks, `salon_id` scope, idempotency, and existing recovery behavior.
5. Add a regression test that fails before the fix and passes after it. Invoke `$security-privacy-review` if the incident touches patient data, authorization, secrets, webhooks, or agent tools.
6. Hand off the root cause, affected scope, fix, verification, rollback path, and any needed follow-up monitoring or data-repair plan. Separate facts from hypotheses.
