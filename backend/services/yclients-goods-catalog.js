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
  // SCAFFOLD ONLY — body implemented in Wave 2 (Plan 02).
  // Self-guard against missing creds (matches syncGoodsCategories line 9):
  if (!salon || !salon.yclients_company_id || !salon.yclients_user_token) {
    return { skipped: true, reason: 'no-yclients' };
  }
  logger.warn(`syncGoodsCatalog: scaffold called for salon ${salon.id} — body not yet implemented`);
  return { skipped: true, reason: 'not-implemented' };
}

module.exports = {
  syncGoodsCatalog,
  HOME_CARE_CATEGORY_BLACKLIST,
  isBlacklisted,
  extractCategoryTitle,
};
