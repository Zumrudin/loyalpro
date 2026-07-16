'use strict';

// Стартовый набор папок, создаётся при первом заходе (когда категорий 0).
// display_order повторяет нумерацию разделов из спеки (3-й у клиента не показан).
const STARTER_CATEGORIES = [
  { title: 'Информация о салоне и услугах', icon: '📋', display_order: 1 },
  { title: 'Скрипты для клиентов',          icon: '💬', display_order: 2 },
  { title: 'Отмены, переносы, опоздания',    icon: '📅', display_order: 4 },
  { title: 'Жалобы и конфликты',             icon: '⚠️', display_order: 5 },
  { title: 'Полномочия администратора',      icon: '🛡', display_order: 6 },
  { title: 'Чек-листы смены',                icon: '✅', display_order: 7 },
  { title: 'Документы и регламенты',         icon: '📁', display_order: 8 },
  { title: 'Лояльность и акции',             icon: '🎁', display_order: 9 },
];

// Приводит теги (массив или строку "a, b") к уникальному массиву непустых строк.
function normalizeTags(tags) {
  let arr;
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(',');
  else return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const s = String(t).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Валидация входа статьи для POST/PUT.
function validateArticleInput(body) {
  if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
    return { valid: false, error: 'title обязателен' };
  }
  if (!Number.isInteger(body.category_id)) {
    return { valid: false, error: 'category_id обязателен' };
  }
  return { valid: true };
}

// Строит prefix-tsquery для to_tsquery('russian', …) из пользовательского ввода:
// разбивает по пробелам, вычищает операторы tsquery (& | ! ( ) < > : * ' " \),
// к каждому токену добавляет :* (префиксный матч), склеивает через ' & '.
// Пустой/мусорный ввод → '' (вызывающий код тогда падает в ILIKE-ветку).
function buildPrefixTsQuery(q) {
  if (typeof q !== 'string') return '';
  const tokens = q
    .split(/\s+/)
    .map(t => t.replace(/[&|!()<>:*'"\\]/g, '').trim())
    .filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map(t => `${t}:*`).join(' & ');
}

module.exports = { STARTER_CATEGORIES, validateArticleInput, normalizeTags, buildPrefixTsQuery };
