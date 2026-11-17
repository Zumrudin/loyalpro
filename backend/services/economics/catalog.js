'use strict';
// Settings is the only current catalog. External IDs remain accounting keys;
// never substitute a local serial ID for a YClients service/category ID.
const { db } = require('../../db');
async function loadCatalog(salonId) {
  const rows = await db.any(`SELECT c.id, c.title, c.duration, c.active,
    CASE WHEN c.yclients_company_id IS NULL OR c.yclients_company_id::text=s.yclients_company_id::text
      THEN c.economics_yc_id END AS economics_yc_id,
    CASE WHEN c.yclients_company_id::text=s.yclients_company_id::text THEN c.yclients_id END AS linked_yclients_id,
    CASE WHEN g.yclients_company_id::text=s.yclients_company_id::text THEN g.yclients_id END AS external_category_id,
    g.title AS category_title
    FROM service_catalog c JOIN salons s ON s.id=c.salon_id
    LEFT JOIN service_categories g ON g.salon_id=c.salon_id AND g.id=COALESCE(c.accounting_category_id,c.category_id)
    WHERE c.salon_id=$1 ORDER BY c.id`, [salonId]);
  const meta = { titleByService: new Map(), categoryByService: new Map(), durationByService: new Map() };
  const categories = new Map(), unlinkedServices = [];
  for (const row of rows) {
    const id = Number(row.economics_yc_id || row.linked_yclients_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      unlinkedServices.push({ local_id: Number(row.id), title: row.title, active: row.active });
      continue;
    }
    const key = String(id), categoryId = row.external_category_id == null ? null : Number(row.external_category_id);
    // A shared economics key must not silently acquire an arbitrary category.
    if (meta.titleByService.has(key)) throw new Error('Несколько услуг связаны с одной услугой экономики. Проверьте настройки услуг.');
    meta.titleByService.set(key, row.title);
    meta.categoryByService.set(key, categoryId);
    meta.durationByService.set(key, Number(row.duration) * 60);
    if (categoryId) categories.set(categoryId, { id: categoryId, title: row.category_title });
  }
  return { meta, catalog: { categories: [...categories.values()] }, unlinkedServices };
}
module.exports = { loadCatalog };
