'use strict';
// ============================================================
// Чистая логика дерева категорий/подкатегорий услуг агента. Без БД/HTTP —
// юнит-тестируемо. Данные готовит services/agent-settings.loadCategoryTree(Safe)
// + ycGetServiceCatalog (плоские YClients-категории и услуги).
//
//   ycCategories — [{ id, title, weight }]           (топ-категории YClients)
//   subcats      — [{ id, salon_id, yc_category_id, parent_id, title, display_order }]
//   placements   — [{ yc_service_id, subcategory_id }]  (услуга → подкатегория)
//   services     — [{ yc_id, title, category_id, _weight, ... }]  (для дерева админки)
//
// Инвариант подкатегорий: yc_category_id — ЯКОРЬ всего поддерева (одинаков на всех
// уровнях), поэтому путь строится без обхода до корня категории.
// ============================================================

// Сортировка «по весу (убыв.), затем по названию» — как в getServicesForAdmin.
const byWeightTitle = (a, b) =>
  ((Number(b._weight) || 0) - (Number(a._weight) || 0)) ||
  String(a.title).localeCompare(String(b.title), 'ru');

// Сортировка подкатегорий: по display_order, затем по названию.
const byOrderTitle = (a, b) =>
  ((Number(a._order) || 0) - (Number(b._order) || 0)) ||
  String(a.title).localeCompare(String(b.title), 'ru');

// Индексы для быстрых lookup'ов.
function indexTree(ycCategories, subcats, placements) {
  const ycCatById = new Map();
  for (const c of (ycCategories || [])) {
    ycCatById.set(String(c.id), { id: c.id, title: c.title, weight: Number(c.weight) || 0 });
  }
  const subcatById = new Map();
  for (const s of (subcats || [])) subcatById.set(String(s.id), s);
  const placementBySvc = new Map();
  for (const p of (placements || [])) {
    placementBySvc.set(String(p.yc_service_id), String(p.subcategory_id));
  }
  return { ycCatById, subcatById, placementBySvc };
}

// Цепочка названий подкатегорий сверху вниз (от корня поддерева до самой S).
// Разрыв циклов parent_id через seen; сирота (parent нет) трактуется как верхняя.
function subcatChain(idx, subcat) {
  const chain = [];
  const seen = new Set();
  let cur = subcat;
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    chain.push(cur.title);
    const pid = cur.parent_id;
    if (pid === null || pid === undefined) break;
    const parent = idx.subcatById.get(String(pid));
    if (!parent) break;   // сирота → выше некуда
    cur = parent;
  }
  return chain.reverse();
}

// Путь категорий услуги сверху вниз (массив названий).
//   помещена в существующую подкатегорию S → [название YClients-категории-якоря S,
//     ...цепочка подкатегорий до S];
//   не помещена (или placement на удалённую/чужую подкатегорию) → [название родной
//     YClients-категории] либо [] если категории нет/не найдена.
function categoryPathForService(idx, ycServiceId, nativeCategoryId) {
  const subcatId = idx.placementBySvc.get(String(ycServiceId));
  if (subcatId && idx.subcatById.has(subcatId)) {
    const subcat = idx.subcatById.get(subcatId);
    const chain = subcatChain(idx, subcat);
    const cat = idx.ycCatById.get(String(subcat.yc_category_id));
    return cat ? [cat.title, ...chain] : [...chain];
  }
  const cat = (nativeCategoryId === null || nativeCategoryId === undefined)
    ? null : idx.ycCatById.get(String(nativeCategoryId));
  return cat ? [cat.title] : [];
}

// Вложенное дерево для админки. Каждая услуга попадает в узел своего эффективного
// расположения: placement-подкатегория (если существует) → иначе родная
// YClients-категория → иначе «Без категории». Пустые подкатегории присутствуют.
function buildAdminTree(ycCategories, services, subcats, placements) {
  const idx = indexTree(ycCategories, subcats, placements);

  // Узлы подкатегорий (все — даже пустые).
  const subNodeById = new Map();
  for (const s of (subcats || [])) {
    subNodeById.set(String(s.id), {
      id: s.id, title: s.title, subcategory: true,
      services: [], subcategories: [],
      _order: Number(s.display_order) || 0,
      _yc: s.yc_category_id, _parent: s.parent_id,
    });
  }

  // Узлы категорий (создаются лениво по мере надобности). Ключ '' → «Без категории».
  const catNodeByKey = new Map();
  const catNode = (catId) => {
    const key = (catId === null || catId === undefined) ? '' : String(catId);
    if (catNodeByKey.has(key)) return catNodeByKey.get(key);
    const c = key === '' ? null : idx.ycCatById.get(key);
    const node = {
      id: c ? c.id : (key === '' ? null : catId),
      title: c ? c.title : 'Без категории',
      services: [], subcategories: [],
      _weight: c ? c.weight : -1,   // «Без категории» — в конец
    };
    catNodeByKey.set(key, node);
    return node;
  };

  // Развесить подкатегории: под родителя (если валиден) либо под якорную категорию.
  for (const node of subNodeById.values()) {
    const pid = node._parent;
    const parent = (pid === null || pid === undefined) ? null : subNodeById.get(String(pid));
    if (parent) parent.subcategories.push(node);
    else catNode(node._yc).subcategories.push(node);   // сирота/верхняя → под категорию
  }

  // Разложить услуги по эффективному расположению.
  for (const s of (services || [])) {
    const subId = idx.placementBySvc.get(String(s.yc_id));
    if (subId && subNodeById.has(subId)) {
      subNodeById.get(subId).services.push(s);
    } else {
      const catId = s.category_id;
      const known = (catId !== null && catId !== undefined) && idx.ycCatById.has(String(catId));
      catNode(known ? catId : null).services.push(s);
    }
  }

  // Рекурсивная сортировка/очистка подкатегорий (seen — на всякий случай от циклов).
  const finalizeSub = (node, seen) => {
    if (seen.has(node)) return;
    seen.add(node);
    node.services.sort(byWeightTitle);
    node.services.forEach(x => { delete x._weight; });
    node.subcategories.sort(byOrderTitle);
    node.subcategories.forEach(ch => finalizeSub(ch, seen));
    node.subcategories.forEach(ch => { delete ch._order; delete ch._yc; delete ch._parent; });
  };

  const out = [...catNodeByKey.values()].sort(byWeightTitle);
  for (const cat of out) {
    cat.services.sort(byWeightTitle);
    cat.services.forEach(x => { delete x._weight; });
    cat.subcategories.sort(byOrderTitle);
    const seen = new Set();
    cat.subcategories.forEach(ch => finalizeSub(ch, seen));
    cat.subcategories.forEach(ch => { delete ch._order; delete ch._yc; delete ch._parent; });
    delete cat._weight;
  }
  return out;
}

module.exports = { indexTree, categoryPathForService, buildAdminTree };
