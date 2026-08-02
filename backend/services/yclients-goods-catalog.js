// ============================================================
// YClients Goods Catalog Sync (Phase 03)
// Persistent mirror of YClients goods catalog per-salon.
// Source of truth for /api/home-care/products and /product-tree
// dropdowns. Replaces sales-history-derived dropdown.
// ============================================================
const { db } = require('../db');
const { ycGet, clearTreeCache } = require('./yclients');
const { createLogger } = require('../logger');
const logger = createLogger('GoodsCatalog');

// ── Blacklist of YClients category titles hidden from home-care dropdown ──
// (D-03 from CONTEXT.md — phase 03)
// Comparison is case-insensitive on lower(trim(title)) (D-04).
// To change the list, edit this array — it's a single source of truth.
const HOME_CARE_CATEGORY_BLACKLIST = new Set([
  'расходники',
  'канцелярия',
  'препараты',
  'аптека',
  'сертификаты сеть peri clinic',
  'абонементы сеть peri clinic',
]);

/**
 * Returns true if a category title belongs to the blacklist.
 * Empty/null titles return false ("Без категории" passes through and may
 * be filtered upstream if needed).
 * @param {string|null|undefined} categoryTitle
 * @returns {boolean}
 */
function isBlacklisted(categoryTitle) {
  if (!categoryTitle || typeof categoryTitle !== 'string') return false;
  return HOME_CARE_CATEGORY_BLACKLIST.has(categoryTitle.trim().toLowerCase());
}

// ── Rate-limit detection (incident 2026-08-02) ───────────────────────────────
// YClients signals «Превышен лимит запросов» in two shapes, and NEITHER carries
// an axios `response` by the time it reaches us:
//   • ycError() (services/yclients.js) rebuilds a plain Error and puts the HTTP
//     code on `err.status`;
//   • a 200 response with `success:false` throws a bare Error carrying only the
//     meta message (services/yclients.js:59) — no status at all.
// The retry guard below originally tested `e.response?.status === 429`, so it
// never fired: prod lost 7–10 categories to undetected rate limits on every cron
// run, and Step C then archived their goods 24h later.
const RATE_LIMIT_RE = /превышен лимит запросов|rate limit|too many requests/i;

/**
 * True when an error means "YClients throttled us" and a retry may succeed.
 * @param {any} e
 * @returns {boolean}
 */
function isRateLimitError(e) {
  if (!e) return false;
  const status = e.status != null ? e.status : (e.response && e.response.status);
  if (status === 429) return true;
  return RATE_LIMIT_RE.test(String(e.message || ''));
}

/**
 * Normalize YClients per-good response into a category title string.
 * YClients returns category in 3 shapes: object {id, title}, string, or
 * null with category_id populated separately. Mirrors the 3-branch
 * pattern in services/home-care.js:27-29.
 * @param {object} g          - YClients good payload
 * @param {Record<number,string>} catMap - cat_id → cat_title fallback map
 * @returns {string|null}
 */
function extractCategoryTitle(g, catMap) {
  if (g && g.category && typeof g.category === 'object' && g.category.title) {
    return g.category.title;
  }
  if (g && typeof g.category === 'string') return g.category;
  if (g && g.category_id != null && catMap && catMap[g.category_id]) {
    return catMap[g.category_id];
  }
  return null;
}

/**
 * Sync the full YClients goods catalog for a salon into yclients_goods_catalog.
 * Wave 2 (Plan 02) implements the body: bootstrap → enumerate per category →
 * UPSERT → soft-delete tail → clearTreeCache.
 *
 * @param {object} salon - salons row (must have id, yclients_company_id, yclients_user_token)
 * @returns {Promise<{
 *   skipped?: boolean, reason?: string,
 *   salonId?: number, inserted?: number, updated?: number, archived?: number,
 *   goodsSeen?: number, categoriesSeen?: number, errors?: number, durationMs?: number
 * }>}
 */
async function syncGoodsCatalog(salon) {
  // Self-guard (D-context Pitfall 5, matches services/home-care.js:9 pattern)
  if (!salon || !salon.yclients_company_id || !salon.yclients_user_token) {
    return { skipped: true, reason: 'no-yclients' };
  }
  const cid = salon.yclients_company_id;
  const salonId = salon.id;
  const startedAt = Date.now();
  const errors = [];
  // YClients quirk: /goods/{cid} silently downgrades count to a ~25-item default
  // page when count exceeds ~100. Stay at 100 (the largest value the API honors)
  // so each page is full and pagination terminates on a genuinely empty page.
  const PAGE_SIZE = 100;
  const MAX_PAGES_PER_CATEGORY = 100;       // T-03-04 hard cap (DoS guard) — 100 pages × 100 = 10k goods/cat
  const PACE_MS = 200;                       // D-11
  const BOOTSTRAP_PACE_MS = 150;             // matches services/staff.js:58
  const RETRIES_429   = 3;                   // retry budget when YClients returns 429 Too Many Requests
  const RETRY_BASE_MS = 500;                 // exponential backoff: 500, 1000, 2000ms
  let inserted = 0, updated = 0, goodsSeen = 0;

  logger.info(`Salon ${salonId}: starting catalog sync (cid=${cid})`);

  // ─── STEP A — Bootstrap category id list (D-07, D-08, D-09) ─────────
  const catMap = {};        // cat_id → cat_title (best-effort, used by extractCategoryTitle)
  const catIds = new Set();

  // A1. Try /good_categories — opportunistic, may 404 (D-07)
  try {
    const cats = await ycGet(salon, `/good_categories/${cid}`);
    if (Array.isArray(cats)) {
      for (const c of cats) {
        if (c && c.id != null && c.title) {
          catMap[c.id] = c.title;
          catIds.add(c.id);
        }
      }
      logger.info(`Salon ${salonId}: /good_categories returned ${catIds.size} categories`);
    }
  } catch (e) {
    logger.warn(`Salon ${salonId}: /good_categories failed (${e.message}); will fallback`);
  }

  // A2. Reuse known cat_ids from previous syncs (D-09)
  if (catIds.size === 0) {
    const known = await db.any(
      `SELECT DISTINCT category_id FROM yclients_goods_catalog
        WHERE salon_id = $1 AND category_id IS NOT NULL`,
      [salonId]
    );
    for (const r of known) catIds.add(r.category_id);
    if (catIds.size > 0) {
      logger.info(`Salon ${salonId}: reused ${catIds.size} cat_ids from existing catalog`);
    }
  }

  // A3. Bootstrap from goods_sale_items via per-good /goods/{cid}/{good_id} (D-08)
  // NOTE: goods_sale_items has NO numeric category_id column (verified by mcp__postgres__query
  // before planning); must hit per-good endpoint to discover cat_ids on first-ever sync.
  if (catIds.size === 0) {
    const sold = await db.any(
      `SELECT DISTINCT gsi.yclients_goods_id AS gid
         FROM goods_sale_items gsi
         JOIN goods_sales gs ON gs.id = gsi.sale_id
        WHERE gs.salon_id = $1 AND gsi.yclients_goods_id IS NOT NULL`,
      [salonId]
    );
    logger.info(`Salon ${salonId}: bootstrapping cat_ids from ${sold.length} sold goods`);
    for (let i = 0; i < sold.length; i++) {
      const gid = sold[i].gid;
      try {
        const data = await ycGet(salon, `/goods/${cid}/${gid}`);
        if (data && data.category_id != null) catIds.add(data.category_id);
        if (data && data.category && typeof data.category === 'object' && data.category.title && data.category_id != null) {
          catMap[data.category_id] = data.category.title;
        }
      } catch (e) {
        errors.push({ step: 'bootstrap', goodId: gid, msg: e.message });
      }
      await new Promise(r => setTimeout(r, BOOTSTRAP_PACE_MS));
    }
  }

  // A4. If still nothing — bail; cron will retry (D-19 + D-12)
  if (catIds.size === 0) {
    logger.warn(`Salon ${salonId}: no category_ids discovered; skipping`);
    return { skipped: true, reason: 'no-categories', errors: errors.length, errorSamples: errors.slice(0, 5) };
  }

  // ─── STEP B — Enumerate goods per category (D-06, D-11, D-12) ───────
  const catIdList = [...catIds];
  const okCatIds = [];      // categories fully read this run — the only ones Step C may prune
  logger.info(`Salon ${salonId}: enumerating ${catIdList.length} categories`);

  for (const catId of catIdList) {
    // Pace before each category, not just between pages. Without this, the
    // first-page request of every category fires back-to-back (most categories
    // fit on one page), bursting ~23 requests in <1s and tripping YClients 429.
    await new Promise(r => setTimeout(r, PACE_MS));
    try {
      let page = 1;
      while (page <= MAX_PAGES_PER_CATEGORY) {        // T-03-04 hard cap
        let goods;
        for (let attempt = 0; ; attempt++) {
          try {
            goods = await ycGet(salon, `/goods/${cid}`, { category_id: catId, count: PAGE_SIZE, page });
            break;
          } catch (e) {
            if (isRateLimitError(e) && attempt < RETRIES_429) {
              const wait = RETRY_BASE_MS * (2 ** attempt);
              logger.warn(`Salon ${salonId}: category ${catId} page ${page} rate-limited, retry ${attempt + 1}/${RETRIES_429} in ${wait}ms`);
              await new Promise(r => setTimeout(r, wait));
              continue;
            }
            throw e;
          }
        }
        if (!Array.isArray(goods) || goods.length === 0) break;
        for (const g of goods) {
          if (g.good_id == null) continue;            // D-10 — same gotcha as bug fix in Wave 1
          const categoryTitle = extractCategoryTitle(g, catMap);
          const result = await db.one(`
            INSERT INTO yclients_goods_catalog
              (salon_id, yclients_good_id, category_id, category_title, title, article, last_seen_at, is_archived)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), FALSE)
            ON CONFLICT (salon_id, yclients_good_id) DO UPDATE
              SET category_id    = EXCLUDED.category_id,
                  category_title = EXCLUDED.category_title,
                  title          = EXCLUDED.title,
                  article        = EXCLUDED.article,
                  last_seen_at   = NOW(),
                  is_archived    = FALSE,
                  updated_at     = NOW()
            RETURNING (xmax = 0) AS is_insert
          `, [
            salonId,
            g.good_id,
            g.category_id != null ? g.category_id : null,
            categoryTitle,
            String(g.title || '').slice(0, 500),
            g.article != null ? String(g.article).slice(0, 200) : null,
          ]);
          if (result.is_insert) inserted++; else updated++;
          goodsSeen++;
        }
        // Terminate only on a genuinely empty page (handled at the top of the
        // loop). A short page is NOT terminal — YClients caps page size below
        // the requested count, so the first page of a 33-good category can come
        // back with only ~25 items while page 2 still has the rest.
        page++;
        await new Promise(r => setTimeout(r, PACE_MS));   // D-11
      }
      if (page > MAX_PAGES_PER_CATEGORY) {
        logger.warn(`Salon ${salonId}: category ${catId} hit MAX_PAGES_PER_CATEGORY=${MAX_PAGES_PER_CATEGORY} cap`);
      }
      okCatIds.push(catId);      // read to the end (or to the cap) — safe to prune
    } catch (e) {
      errors.push({ step: 'enumerate', catId, msg: e.message });
      logger.warn(`Salon ${salonId}: category ${catId} failed: ${e.message}`);
      // continue to next category (D-12 — partial-failure resilience)
    }
  }

  // ─── STEP C — Soft-delete stale (D-13) ───────────────────────────────
  // Only inside categories we actually enumerated this run. A category that
  // errored out (rate limit, 5xx) keeps ALL of its goods: it was not read, so
  // their staleness says nothing about whether YClients still has them.
  // Without this scope a few failed requests silently wipe whole brands out of
  // the home-care dropdown 24h later — incident 2026-08-02 cost 72 goods across
  // Forlled, GIGI, Phyto-C, HELEO4, HELIOCARE, Luscious Lips.
  let archived = { rowCount: 0 };
  if (okCatIds.length) {
    archived = await db.query(`
      UPDATE yclients_goods_catalog
         SET is_archived = TRUE, updated_at = NOW()
       WHERE salon_id = $1
         AND category_id = ANY($2::int[])
         AND last_seen_at < NOW() - INTERVAL '24 hours'
         AND NOT is_archived
      RETURNING id
    `, [salonId, okCatIds]);
  }
  if (okCatIds.length < catIdList.length) {
    logger.warn(
      `Salon ${salonId}: ${catIdList.length - okCatIds.length}/${catIdList.length} categories not enumerated — ` +
      `their goods left untouched by archiving`
    );
  }

  // ─── STEP D — Invalidate tree cache (D-18) ──────────────────────────
  clearTreeCache(salonId);

  const durationMs = Date.now() - startedAt;
  logger.info(
    `Salon ${salonId}: catalog sync done. ` +
    `inserted=${inserted} updated=${updated} archived=${archived.rowCount} ` +
    `goodsSeen=${goodsSeen} categories=${okCatIds.length}/${catIdList.length} errors=${errors.length} duration=${durationMs}ms`
  );

  return {
    salonId,
    inserted,
    updated,
    archived: archived.rowCount,
    goodsSeen,
    categoriesSeen: catIdList.length,
    categoriesOk: okCatIds,
    errors: errors.length,
    errorSamples: errors.slice(0, 5),
    durationMs,
  };
}

module.exports = {
  syncGoodsCatalog,
  HOME_CARE_CATEGORY_BLACKLIST,
  isBlacklisted,
  extractCategoryTitle,
  isRateLimitError,
};
