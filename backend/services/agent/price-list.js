'use strict';
// ============================================================
// Чистая логика прайс-листов в картинках. Без БД/HTTP — юнит-тестируемо.
// Данные готовит services/agent/price-list-data.loadPriceIndex.
//
// Узел дерева адресуется СТРОКОВЫМ ключом: `c<ycCategoryId>` (направление
// YClients) или `s<subcategoryId>` (локальная подкатегория агента). Ключ уходит
// в промпт и возвращается моделью аргументом инструмента — числовой id без
// префикса перепутал бы направление с подкатегорией.
// ============================================================

// Кап фото на ОДИН ход диалога. Экспортируется ради тестов и инструмента.
// Кап на УЗЕЛ живёт в agent-settings (его проверяет маршрут загрузки) —
// второй копии числа тут быть не должно.
const MAX_PHOTOS_PER_TURN = 10;

// Названия категорий приходят из YClients и попадают в системный промпт —
// привилегированную позицию. Управляющие символы и переносы строк — вектор
// «дописать агенту правила», | ломает колонку ключа. Тот же приём, что
// в catalog-block.cell: копия намеренная — каталог и прайсы не должны
// зависеть друг от друга ради четырёх строк.
function cell(v, maxLen) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const catKey = (id) => `c${Number(id)}`;
const subKey = (id) => `s${Number(id)}`;

function parseKey(key) {
  const m = /^([cs])(\d+)$/.exec(String(key == null ? '' : key).trim());
  if (!m) return null;
  return { kind: m[1] === 'c' ? 'cat' : 'sub', id: Number(m[2]) };
}

// { categories:[{id,title}], subcats:[{id,yc_category_id,parent_id,title}],
//   photos:[{id,yc_category_id,subcategory_id,file_url,file_name,mime_type}],
//   priceListUrl }
//   → { nodes: Map(key → {key,title,path,parentKey,photos}), priceListUrl }
function buildIndex({ categories, subcats, photos, priceListUrl } = {}) {
  const nodes = new Map();
  for (const c of (categories || [])) {
    if (c == null || c.id == null) continue;
    nodes.set(catKey(c.id), {
      key: catKey(c.id), title: cell(c.title, 80), parentKey: null, path: null, photos: [],
    });
  }
  for (const s of (subcats || [])) {
    if (s == null || s.id == null) continue;
    nodes.set(subKey(s.id), {
      key: subKey(s.id),
      title: cell(s.title, 80),
      parentKey: s.parent_id == null ? catKey(s.yc_category_id) : subKey(s.parent_id),
      path: null,
      photos: [],
    });
  }

  // Путь сверху вниз. Разрыв циклов parent_id через seen — тот же приём, что
  // в category-tree.subcatChain: битые данные не имеют права повесить процесс.
  for (const node of nodes.values()) {
    const chain = [];
    const seen = new Set();
    let cur = node;
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      chain.push(cur.title);
      cur = cur.parentKey ? nodes.get(cur.parentKey) : null;
    }
    node.path = chain.reverse();
  }

  for (const p of (photos || [])) {
    if (!p) continue;
    const key = p.subcategory_id != null ? subKey(p.subcategory_id)
      : p.yc_category_id != null ? catKey(p.yc_category_id) : null;
    const node = key && nodes.get(key);
    if (!node) continue;   // сирота: узел удалён из дерева — фото просто не показываем
    node.photos.push({
      id: p.id, fileUrl: p.file_url, fileName: p.file_name, mimeType: p.mime_type,
    });
  }

  return { nodes, priceListUrl: priceListUrl || null };
}

// Фото узла, а если своих нет — ближайшего предка с фото.
// → { node, photos, inheritedFrom } | null (ключ неизвестен).
function resolvePhotos(key, index) {
  const nodes = index && index.nodes;
  if (!nodes) return null;
  const node = nodes.get(String(key == null ? '' : key).trim());
  if (!node) return null;
  const seen = new Set();
  let cur = node;
  while (cur && !seen.has(cur.key)) {
    seen.add(cur.key);
    if (cur.photos.length) {
      return { node, photos: cur.photos.slice(), inheritedFrom: cur.key === node.key ? null : cur.key };
    }
    cur = cur.parentKey ? nodes.get(cur.parentKey) : null;
  }
  return { node, photos: [], inheritedFrom: null };
}

// Блок системного промпта. Порядок строк ДЕТЕРМИНИРОВАН (направления, затем
// подкатегории, внутри — по возрастанию id): блок стоит в кэшируемом префиксе,
// и «плавающий» порядок ломал бы префикс-кэш провайдера на каждом ходу.
function renderPriceListBlock(index) {
  const nodes = index && index.nodes ? [...index.nodes.values()] : [];
  const withOwn = nodes
    .filter(n => n.photos.length)
    .sort((a, b) => {
      const ka = parseKey(a.key), kb = parseKey(b.key);
      if (ka.kind !== kb.kind) return ka.kind === 'cat' ? -1 : 1;
      return ka.id - kb.id;
    });
  const url = index && index.priceListUrl;
  if (!withOwn.length && !url) return null;
  const lines = [
    'ПРАЙС-ЛИСТЫ В КАРТИНКАХ (готовые листы с ценами; отправляются пациенту инструментом send_price_list. Формат строки: ключ|направление>подкатегория — ключ передавай в инструмент дословно):',
    ...withOwn.map(n => `${n.key}|${n.path.join('>')}`),
  ];
  if (!withOwn.length) lines[0] = 'ПРАЙС-ЛИСТЫ В КАРТИНКАХ: готовых листов у клиники сейчас нет.';
  if (url) lines.push(`Полный прайс на сайте клиники: ${url}`);
  return lines.join('\n');
}

module.exports = {
  catKey, subKey, parseKey, buildIndex, resolvePhotos, renderPriceListBlock,
  MAX_PHOTOS_PER_TURN,
};
