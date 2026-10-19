'use strict';
// Справочники «Экономики» (GET /api/economics/dictionaries) — чистая склейка.
// Услуги — из management-каталога /company/{cid}/services/ (ycGetServiceMeta,
// кэш 10 мин): booking-каталог /services отдаёт только онлайн-записываемые
// (у PERI активны 4 из 317), и правило оплаты/привязку аппарата на остальные
// услуги выбрать было нельзя. Названия категорий — из /service_categories
// (ycGetServiceCatalog, тот же кэш, что у отчёта); категория без названия —
// «категория #id». Плюс услуги из записей за 12 мес. (нет в каталоге — удалена).
// degraded: каталог YClients не ответил — фронт такой ответ не кэширует.

function buildDictionaries({ meta, catalog, staff, recentServices }) {
  const titles = (meta && meta.titleByService instanceof Map) ? meta.titleByService : new Map();
  const cats = (meta && meta.categoryByService instanceof Map) ? meta.categoryByService : new Map();
  const services = new Map();
  for (const [id, title] of titles) {
    const n = Number(id); if (!Number.isInteger(n) || n <= 0) continue;
    services.set(n, { id: n, title: title || `услуга #${n}`, category_id: cats.get(String(id)) ?? null, in_catalog: true });
  }
  for (const s of recentServices || []) {
    if (!s || !Number.isInteger(s.id) || services.has(s.id)) continue;
    services.set(s.id, { id: s.id, title: s.title || `услуга #${s.id}`, category_id: s.category_id ?? null, in_catalog: false });
  }
  const catTitles = new Map();
  for (const c of (catalog && Array.isArray(catalog.categories) ? catalog.categories : [])) {
    const n = Number(c && c.id); if (Number.isInteger(n) && n > 0) catTitles.set(n, String(c.title || ''));
  }
  const catIds = new Set(catTitles.keys());
  for (const s of services.values()) if (s.category_id != null) catIds.add(Number(s.category_id));
  const categories = [...catIds].map(id => ({ id, title: catTitles.get(id) || `категория #${id}` }));
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'ru') || a.id - b.id;
  return {
    services: [...services.values()].sort(byTitle),
    categories: categories.sort(byTitle),
    staff: staff || [],
    degraded: titles.size === 0,
  };
}

module.exports = { buildDictionaries };
