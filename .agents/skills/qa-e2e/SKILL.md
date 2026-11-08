---
name: qa-e2e
description: Verify LoyalPro changes with focused unit, API, regression, and browser end-to-end checks. Use after backend, frontend, mobile-web, webhook, scheduling, loyalty, reminder, or authentication changes, and whenever a user-visible regression must be prevented.
---

# QA and E2E verification

1. Read `AGENTS.md` and `CLAUDE.md`. Derive test cases from the changed behavior, its authorization and tenant boundaries, and the incident or specification that motivated it.
2. Start with the smallest deterministic checks: pure helpers, unit tests, then route or API tests. Reuse existing tests and test conventions instead of creating parallel harnesses.
3. For staff UI behavior, use the Playwright MCP when available. Cover the intended path, an unauthorized or invalid path where relevant, and the reported regression. Do not send messages, create bookings, or change production data during E2E tests.
4. Run `npm run lint` for a mobile change when dependencies are available. Run the relevant backend test command from `CLAUDE.md` for backend changes.
5. Test time-dependent behavior with an explicit timezone and deterministic clock where practical. Check duplicate webhook/event delivery and retry behavior for external integrations.
6. Report every executed command or browser scenario, its result, and any checks that could not run. Distinguish a test pass from a manual inspection.
