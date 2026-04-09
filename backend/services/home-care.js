// ============================================================
// Home Care Service (tree cache + goods categories sync)
// ============================================================
const { db } = require('../db');
const { ycGet, getTreeCache, setTreeCache, clearTreeCache } = require('./yclients');

async function syncGoodsCategories(salon) {
  const cid = salon.yclients_company_id;
  if (!cid || !salon.yclients_user_token) return { updated: 0, failed: 0, total: 0 };

  // Step 1: category id → title
  let catMap = {};
  try {
    const cats = await ycGet(salon, `/good_categories/${cid}`);
    if (Array.isArray(cats)) for (const c of cats) if (c.id != null && c.title) catMap[c.id] = c.title;
  } catch (_) {}

  // Step 2: bulk goods → goodId → categoryTitle
  let goodCatMap = {};
  try {
    let page = 1;
    while (true) {
      const goods = await ycGet(salon, `/goods/${cid}`, { count: 200, page });
      if (!Array.isArray(goods) || !goods.length) break;
      for (const g of goods) {
        if (g.id == null) continue;
        if (g.category && typeof g.category === 'object' && g.category.title) goodCatMap[g.id] = g.category.title;
        else if (g.category && typeof g.category === 'string') goodCatMap[g.id] = g.category;
        else if (g.category_id != null && catMap[g.category_id]) goodCatMap[g.id] = catMap[g.category_id];
      }
      if (goods.length < 200) break;
      page++;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (_) {}

  // Step 3: update DB
  const { rows } = await db.query(
    `SELECT DISTINCT yclients_goods_id FROM goods_sale_items gsi
     JOIN goods_sales gs ON gs.id = gsi.sale_id
     WHERE gs.salon_id = $1 AND yclients_goods_id IS NOT NULL`,
    [salon.id]
  );
  if (!rows.length) return { updated: 0, failed: 0, total: 0 };

  let updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const goodId = rows[i].yclients_goods_id;
    try {
      let category = goodCatMap[goodId];
      if (!category) {
        const data = await ycGet(salon, `/goods/${cid}/${goodId}`);
        if (data.category && typeof data.category === 'object') category = data.category.title;
        else if (data.category && typeof data.category === 'string') category = data.category;
        else if (data.category_id != null && catMap[data.category_id]) category = catMap[data.category_id];
        if (i > 0 && i % 10 === 0) await new Promise(r => setTimeout(r, 300));
      }
      if (category) {
        await db.query(
          `UPDATE goods_sale_items SET yclients_category = $1 WHERE yclients_goods_id = $2 AND yclients_category IS DISTINCT FROM $1`,
          [category, goodId]
        );
        updated++;
      }
    } catch (_) { failed++; }
  }

  clearTreeCache(salon.id);
  return { updated, failed, total: rows.length, categories: Object.keys(catMap).length };
}

module.exports = {
  syncGoodsCategories,
  // Re-export tree cache helpers so routes can use them via this module
  getTreeCache, setTreeCache, clearTreeCache,
};
