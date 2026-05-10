---
phase: 03-fix-home-care-product-dropdown-missing-items
plan: 02
subsystem: backend/services/yclients-goods-catalog
tags: [yclients, sync, upsert, soft-delete, multi-salon, wave-2]
requires:
  - yclients_goods_catalog table (Wave 1)
  - backend/services/yclients-goods-catalog.js scaffold (Wave 1)
  - ycGet, clearTreeCache from backend/services/yclients.js
  - db helper from backend/db.js
  - createLogger from backend/logger.js
provides:
  - Fully implemented syncGoodsCatalog(salon) — bootstrap → enumerate → UPSERT → soft-delete → cache invalidate
  - Idempotent multi-salon catalog sync (returns {salonId, inserted, updated, archived, goodsSeen, categoriesSeen, errors, errorSamples, durationMs})
  - Self-guard against missing YClients creds (skipped:true, reason:'no-yclients')
  - 3-tier category_id bootstrap (/good_categories opportunistic → reuse-known → per-good fallback)
  - Hard pagination cap (MAX_PAGES_PER_CATEGORY=50) — DoS guard
  - YClients pacing (PACE_MS=200, BOOTSTRAP_PACE_MS=150)
affects:
  - backend/services/yclients-goods-catalog.js (scaffold-stub body replaced; exports unchanged)
  - yclients_goods_catalog table (writes only — schema set in Wave 1)
tech-stack:
  added: []
  patterns:
    - UPSERT with ON CONFLICT DO UPDATE … RETURNING (xmax = 0) AS is_insert (saves ~N round-trips vs pre-SELECT)
    - Per-category try/catch for partial-failure resilience
    - Soft-delete via last_seen_at < NOW() - INTERVAL '24 hours' (8 cron ticks/day buffer)
    - Set<number> for catId dedup across 3 bootstrap sources
key-files:
  created: []
  modified:
    - backend/services/yclients-goods-catalog.js
decisions:
  - D-06: Source of truth is /goods/{cid}?category_id=N&count=200&page=K paginated to empty/short page
  - D-07: /good_categories/{cid} called opportunistically — failure logged + fallback, never fatal
  - D-08: Bootstrap from goods_sale_items via per-good /goods/{cid}/{good_id} when /good_categories fails AND catalog is empty (first-ever sync only)
  - D-09: Subsequent syncs reuse known category_ids from existing yclients_goods_catalog rows
  - D-11: 200ms between paginated requests (PACE_MS), 150ms between bootstrap per-good requests (BOOTSTRAP_PACE_MS)
  - D-12: Per-category try/catch — failed category logged + skipped, others continue
  - D-13: Soft-delete via UPDATE … WHERE last_seen_at < NOW() - INTERVAL '24 hours' AND NOT is_archived RETURNING id
  - D-15: is_archived=FALSE in DO UPDATE clause — resurfaced goods automatically un-archived
  - D-18: clearTreeCache(salonId) at end of successful sync — invalidates per-salon in-memory tree cache
metrics:
  duration: "1m 53s"
  completed: 2026-05-10
  tasks: 1
  commits: 1
  files_created: 0
  files_modified: 1
  net_lines_added: 157
requirements:
  - GOAL-01
  - GOAL-03
  - GOAL-04
---

# Phase 03 Plan 02: Wave 2 — syncGoodsCatalog implementation Summary

Wave 2 fills in the body of `syncGoodsCatalog(salon)` left as a placeholder by Wave 1. The function is now fully functional: it self-guards on missing YClients creds, discovers `category_id`s through a 3-tier fallback, paginates `/goods/{cid}` per category, UPSERTs every good with one round-trip per row (using `RETURNING (xmax = 0) AS is_insert` to count inserted vs updated), soft-deletes goods unseen for 24h, and invalidates the per-salon tree cache. All Wave 1 exports (`HOME_CARE_CATEGORY_BLACKLIST`, `isBlacklisted`, `extractCategoryTitle`) are preserved verbatim.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement syncGoodsCatalog body — bootstrap + enumerate + UPSERT + soft-delete + cache invalidation | `a4a3955` | backend/services/yclients-goods-catalog.js |

## Diff Summary

`backend/services/yclients-goods-catalog.js` — scaffold-stub body (lines 70-77 in Wave 1: 8 lines including a `not-implemented` warn) replaced with full ~165-line implementation:

- **Self-guard** (lines 71-73, 6 lines) — returns `{skipped:true, reason:'no-yclients'}` if salon is null or YClients creds missing.
- **STEP A — Bootstrap** (lines 86-150, 65 lines) — 3-tier fallback:
  - A1: `/good_categories/{cid}` (best-effort, may 404 — D-07)
  - A2: Reuse `category_id`s from existing rows in `yclients_goods_catalog` (D-09)
  - A3: Bootstrap from `goods_sale_items` via per-good `/goods/{cid}/{gid}` (D-08; ~150ms between calls)
  - A4: If still no catIds, return `{skipped:true, reason:'no-categories'}` — cron retries next tick (D-19)
- **STEP B — Enumerate** (lines 152-201, 50 lines) — per `category_id`, paginated `/goods/{cid}?category_id=N&count=200&page=K` until short/empty page or `MAX_PAGES_PER_CATEGORY=50` cap; each row UPSERTed with `ON CONFLICT (salon_id, yclients_good_id) DO UPDATE … RETURNING (xmax = 0) AS is_insert`. Per-category `try/catch` so one failed category does not abort the run (D-12). 200ms `PACE_MS` between pages (D-11).
- **STEP C — Soft-delete** (lines 203-211, 9 lines) — `UPDATE … SET is_archived = TRUE WHERE salon_id = $1 AND last_seen_at < NOW() - INTERVAL '24 hours' AND NOT is_archived RETURNING id`.
- **STEP D — Cache invalidation** (line 214) — `clearTreeCache(salonId)`.
- **Return shape** (lines 223-233) — `{salonId, inserted, updated, archived, goodsSeen, categoriesSeen, errors, errorSamples, durationMs}`.

`module.exports` unchanged (4 names from Wave 1). `HOME_CARE_CATEGORY_BLACKLIST`, `isBlacklisted`, `extractCategoryTitle` left exactly as-is. Net change: 161 insertions, 4 deletions (the scaffold-stub `logger.warn(...) + return {skipped:true, reason:'not-implemented'}` block was the only deleted code).

File length now 241 lines (Wave 1 scaffold was 85 lines).

## Verification Results

### 1. Syntax / require
- `node -c backend/services/yclients-goods-catalog.js` → SYNTAX OK.
- `NODE_PATH=/root/loyalpro/backend/node_modules node -e "require('./backend/services/yclients-goods-catalog')"` → loads cleanly. (`NODE_PATH` shim required because the parallel worktree's `backend/node_modules` is sparse — same harmless quirk noted in Wave 1 SUMMARY.)

### 2. Self-guard offline (no DB / no network)
```
syncGoodsCatalog({})                                                       → {"skipped":true,"reason":"no-yclients"}
syncGoodsCatalog({id:999, yclients_company_id:0, yclients_user_token:''})  → {"skipped":true,"reason":"no-yclients"}
syncGoodsCatalog(null)                                                      → {"skipped":true,"reason":"no-yclients"}
```

### 3. Structural grep checks
| Pattern | Required | Actual | Pass |
|---------|----------|--------|------|
| `INSERT INTO yclients_goods_catalog` | 1 | 1 | ✓ |
| `ON CONFLICT (salon_id, yclients_good_id)` | 1 | 1 | ✓ |
| `RETURNING (xmax = 0)` | 1 | 1 | ✓ |
| `INTERVAL '24 hours'` | 1 | 1 | ✓ |
| `clearTreeCache(salonId)` | 1 | 1 | ✓ |
| `MAX_PAGES_PER_CATEGORY` | ≥2 | 4 (decl + while + cap-warn + comment) | ✓ |
| `PACE_MS` | ≥2 | 4 | ✓ |
| `BOOTSTRAP_PACE_MS` | ≥2 | 2 | ✓ |
| `setTimeout` | ≥2 | 2 (one in bootstrap, one in enumerate) | ✓ |
| `clearTreeCache()` (no-arg, banned by T-03-W2-02) | 0 | 0 | ✓ |

### 4. Multi-salon scoping (CLAUDE.md hard rule)
Every SQL touch of `yclients_goods_catalog` carries `salon_id = $1`:
- Line 109 (A2 SELECT): `WHERE salon_id = $1 AND category_id IS NOT NULL`
- Line 167 (UPSERT): `salon_id` is the first param of the UNIQUE conflict target
- Line 207 (soft-delete): `WHERE salon_id = $1 AND last_seen_at < NOW() - INTERVAL '24 hours'`

Bootstrap A3 SELECT also scopes via `WHERE gs.salon_id = $1` on the joined `goods_sales` table (line 127).

### 5. Token-leak guard (T-03-W2-01)
`grep -nE "logger\.(info|warn|error)\(.*\$\{salon[^.iI]" backend/services/yclients-goods-catalog.js` → 0 matches. Every logger call uses `${salonId}` (numeric only) or `${cid}` — never the `salon` object.

### 6. Wave 1 export preservation
```
Object.keys(require('./backend/services/yclients-goods-catalog')) →
  ['HOME_CARE_CATEGORY_BLACKLIST', 'extractCategoryTitle', 'isBlacklisted', 'syncGoodsCatalog']
```
Helper smoke-test:
- `HOME_CARE_CATEGORY_BLACKLIST.size === 6` ✓
- `isBlacklisted('Расходники') === true` ✓
- `isBlacklisted('Forlled') === false` ✓
- `extractCategoryTitle({category_id:5},{5:'X'}) === 'X'` ✓

### 7. Optional dry-run (deferred)
The plan offers an optional REPL dry-run against a real salon (`db.one('SELECT * FROM salons WHERE id=1')` → `syncGoodsCatalog(s)`). Skipped from this worktree because:
- This is a parallel executor — direct production DB writes are out of scope (Wave 1 also deferred live migration to next PM2 boot).
- The migration table itself only exists once `runMigrations()` runs at next server boot.
- Wave 4 (Plan 04) explicitly handles the manual production cutover.

The verifier or orchestrator can run the dry-run after Wave 4 wires the cron handler.

### 8. Idempotency
By construction, re-running on the same data yields `inserted=0, updated=goodsSeen, archived=0` — every row hits the UNIQUE conflict path, sets `last_seen_at=NOW()` and `is_archived=FALSE`, so the 24h-stale predicate selects nothing.

## Threat Model Compliance (Wave 2 scope)

| Threat ID | Mitigation in code | Status |
|-----------|--------------------|--------|
| T-03-W2-01 (token leak) | All `logger.info/warn` calls dump `${salonId}` and `${cid}` only — `errors[]` rows record `{step, catId/goodId, msg=e.message}`, never `e.stack` or `salon` | Mitigated |
| T-03-W2-02 (cross-salon cache leak) | `clearTreeCache(salonId)` (1 call); `clearTreeCache()` no-arg form: 0 occurrences | Mitigated |
| T-03-W2-03 (runaway pagination) | `MAX_PAGES_PER_CATEGORY = 50` enforced in `while (page <= MAX_PAGES_PER_CATEGORY)`; warn-log on cap hit | Mitigated |
| T-03-W2-04 (SQLi via YClients payload) | All values pass through `$1..$6` placeholders; `String(g.title \|\| '').slice(0,500)` and `g.article != null ? String(g.article).slice(0,200) : null` normalize+bound | Mitigated |
| T-03-W2-05 (YClients quota burn) | `PACE_MS=200` between pages, `BOOTSTRAP_PACE_MS=150` between per-good bootstrap calls; 2 `setTimeout` sites | Mitigated |
| T-03-W2-06 (audit) | `[GoodsCatalog]` info log on start + end with full counts | Accepted |
| T-03-W2-07 (EoP) | No new endpoints in Wave 2 | N/A |

## Deviations from Plan

None — plan executed exactly as written. The full code block specified in `<action>` was inlined verbatim.

## Outstanding for Wave 3 (Plan 03)

- Repoint `/api/home-care/products` and `/api/home-care/product-tree` to read from `yclients_goods_catalog` (filter `is_archived = FALSE` and `NOT isBlacklisted(category_title)`)
- Maintain existing JSON shape for the staff frontend (`[{cat, items: string[]}]`)
- Add unit tests for blacklist filter and tree-shape transformation

## Outstanding for Wave 4 (Plan 04)

- Wire `syncGoodsCatalog` into the existing `0 */3 * * *` cron handler in `backend/server.js` (after `syncGoodsCategories`)
- Manual production cutover: PM2 restart applies the Wave 1 migration; first cron tick populates the catalog
- Pre-flight dry-run via Node REPL on salon_id=1 (PERI CLINIC) — expected `inserted ≈ 427, categoriesSeen ≈ 26, errors === 0`

## Self-Check: PASSED

Verified before finalizing:
- `backend/services/yclients-goods-catalog.js` — FOUND (241 lines)
- Commit `a4a3955` — FOUND in `git log`
- Self-guard returns `{skipped:true, reason:'no-yclients'}` on `{}`, falsy creds, and `null`
- All Wave 1 exports preserved (4 names exact)
- All structural grep checks pass
- Multi-salon scoping verified across all 3 SQL touches of `yclients_goods_catalog`
- Token-leak guard verified (0 logger calls dumping the `salon` object)
- `clearTreeCache(salonId)` called exactly once, with the per-salon argument
