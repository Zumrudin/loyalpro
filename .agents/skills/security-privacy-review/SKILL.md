---
name: security-privacy-review
description: Review LoyalPro code and configuration for security, authorization, patient-data privacy, tenant isolation, secret handling, and unsafe external effects. Use before merging changes to authentication, API routes, database access, webhooks, files, AI-agent tools, messages, bookings, bonuses, or production configuration.
---

# Security and privacy review

1. Review the change and its reachable callers. Identify assets, trust boundaries, roles, tenant boundaries, user-controlled input, and external side effects.
2. Check authentication and authorization on every reachable route or tool. Verify that tenant-owned reads and writes are scoped by server-derived `salon_id` and that role checks cannot be bypassed through request fields, deep links, or alternate endpoints.
3. Check input validation, rate limiting, secrets, log redaction, uploaded files, webhook verification, dependency risk, and error responses. Do not repeat sensitive values in the review output.
4. For AI-agent changes, constrain tool arguments, require server-side authorization and deterministic guards, defend against prompt-injected instructions in untrusted content, and keep booking, message, and bonus effects behind explicit confirmation or a documented safe policy.
5. Classify findings by impact and exploitability. Provide file and line references, a concise safe remediation, and tests that would prevent recurrence.
6. Do not change production configuration or exploit a suspected weakness. Escalate immediately if a live credential or patient-data exposure is observed.
