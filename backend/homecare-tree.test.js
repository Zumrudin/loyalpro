'use strict';

/**
 * Tests for /api/home-care/service-tree and /api/home-care/product-tree
 * logic: grouping, sorting, search filtering.
 *
 * We test the pure grouping logic extracted inline (same algorithm as server.js).
 */

// ── Pure grouping functions (mirrors server.js logic) ────────────────────────

function buildServiceTree(rows, search = '') {
  const lq = search.toLowerCase();
  const filtered = search
    ? rows.filter(r => r.title.toLowerCase().includes(lq))
    : rows;
  const grouped = {};
  for (const r of filtered) {
    const cat = r.category || 'Без категории';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r.title);
  }
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([cat, items]) => ({ cat, items }));
}

function extractBrand(title) {
  const t = title.trim();
  const firstWord = t.split(/[\s\\|\/\(]+/)[0] || '';
  const clean = firstWord.replace(/[^A-Za-z0-9\-\.™®]/g, '');
  if (/[A-Za-z]/.test(clean) && clean.length >= 2) return clean.toUpperCase();
  return 'Прочее';
}

function buildProductTree(rows, search = '', catByTitle = {}) {
  const lq = search.toLowerCase();
  const filtered = search
    ? rows.filter(r => r.title.toLowerCase().includes(lq))
    : rows;
  const grouped = {};
  for (const r of filtered) {
    const key = r.title.trim().toLowerCase();
    const cat = catByTitle[key] || extractBrand(r.title);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r.title);
  }
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([cat, items]) => ({ cat, items }));
}

// ── Sample data ───────────────────────────────────────────────────────────────

const SERVICE_ROWS = [
  { title: 'Чистка лица', category: 'Уходы' },
  { title: 'Массаж лица', category: 'Уходы' },
  { title: 'Инъекция ботокса', category: 'Инъекции' },
  { title: 'Контурная пластика', category: 'Инъекции' },
  { title: 'Лазерная эпиляция', category: 'Эпиляция' },
  { title: 'Без категории сервис', category: null },
];

const PRODUCT_ROWS = [
  { title: 'Крем увлажняющий' },
  { title: 'Крем для век' },
  { title: 'Сыворотка витамин C' },
  { title: 'Тоник балансирующий' },
  { title: 'Ампула коллаген' },
];

// ── Service tree tests ────────────────────────────────────────────────────────

describe('buildServiceTree', () => {
  test('groups services by category', () => {
    const tree = buildServiceTree(SERVICE_ROWS);
    const cats = tree.map(g => g.cat);
    expect(cats).toContain('Уходы');
    expect(cats).toContain('Инъекции');
    expect(cats).toContain('Эпиляция');
  });

  test('null category becomes "Без категории"', () => {
    const tree = buildServiceTree(SERVICE_ROWS);
    const cats = tree.map(g => g.cat);
    expect(cats).toContain('Без категории');
  });

  test('items inside category are correct', () => {
    const tree = buildServiceTree(SERVICE_ROWS);
    const uhodGroup = tree.find(g => g.cat === 'Уходы');
    expect(uhodGroup.items).toContain('Чистка лица');
    expect(uhodGroup.items).toContain('Массаж лица');
    expect(uhodGroup.items).not.toContain('Инъекция ботокса');
  });

  test('categories are sorted alphabetically (ru)', () => {
    const tree = buildServiceTree(SERVICE_ROWS);
    const cats = tree.map(g => g.cat).filter(c => c !== 'Без категории');
    const sorted = [...cats].sort((a, b) => a.localeCompare(b, 'ru'));
    expect(cats).toEqual(sorted);
  });

  test('search filters by title (case-insensitive)', () => {
    const tree = buildServiceTree(SERVICE_ROWS, 'ботокс');
    expect(tree.length).toBe(1);
    expect(tree[0].cat).toBe('Инъекции');
    expect(tree[0].items).toContain('Инъекция ботокса');
  });

  test('search returns empty for no matches', () => {
    const tree = buildServiceTree(SERVICE_ROWS, 'несуществующая услуга xyz');
    expect(tree).toEqual([]);
  });

  test('search across multiple categories', () => {
    const tree = buildServiceTree(SERVICE_ROWS, 'лица');
    const allItems = tree.flatMap(g => g.items);
    expect(allItems).toContain('Чистка лица');
    expect(allItems).toContain('Массаж лица');
    expect(allItems).not.toContain('Инъекция ботокса');
  });

  test('empty input returns empty tree', () => {
    expect(buildServiceTree([])).toEqual([]);
  });
});

// ── Product tree tests ────────────────────────────────────────────────────────

const BRAND_ROWS = [
  { title: 'ALLIES OF SKIN 20% Vitamin C Serum' },
  { title: 'ALLIES OF SKIN Cleanser' },
  { title: 'EYECELL Eye Contour Cream' },
  { title: 'EYECELL Eye Peptide Gel' },
  { title: 'TiZO3 Primer SPF40' },
  { title: 'TIZO Photoceutical Cream' },
  { title: 'Masktini Gone Girl' },
  { title: '360º Fluid SPF50' },         // starts with number → Прочее
  { title: 'Антисептик' },               // Cyrillic → Прочее
];

describe('buildProductTree', () => {
  test('groups products by first Latin word (uppercase)', () => {
    const tree = buildProductTree(BRAND_ROWS);
    const cats = tree.map(g => g.cat);
    expect(cats).toContain('ALLIES');
    expect(cats).toContain('EYECELL');
    expect(cats).toContain('TIZO');  // TiZO → TIZO
    expect(cats).toContain('MASKTINI');
  });

  test('normalises brand to uppercase (TiZO → TIZO)', () => {
    // Both "TiZO" and "TIZO" first-word → same TIZO group after .toUpperCase()
    const tree = buildProductTree([
      { title: 'TiZO Primer SPF40' },
      { title: 'TIZO Photoceutical Cream' },
    ]);
    expect(tree.length).toBe(1);
    expect(tree[0].cat).toBe('TIZO');
    expect(tree[0].items.length).toBe(2);
  });

  test('multiple products with same brand prefix grouped together', () => {
    const tree = buildProductTree(BRAND_ROWS);
    const allies = tree.find(g => g.cat === 'ALLIES');
    expect(allies.items.length).toBe(2);
  });

  test('title starting with number → Прочее', () => {
    const tree = buildProductTree([{ title: '360º Fluid SPF50' }]);
    expect(tree[0].cat).toBe('Прочее');
  });

  test('Cyrillic-only title → Прочее', () => {
    const tree = buildProductTree([{ title: 'Антисептик' }]);
    expect(tree[0].cat).toBe('Прочее');
  });

  test('YClients catByTitle overrides extractBrand', () => {
    const catByTitle = { 'skin formula крем': 'Skin Formula' };
    const tree = buildProductTree([{ title: 'Skin Formula Крем' }], '', catByTitle);
    expect(tree[0].cat).toBe('Skin Formula');
  });

  test('search filters products', () => {
    const tree = buildProductTree(BRAND_ROWS, 'eye');
    const allItems = tree.flatMap(g => g.items);
    expect(allItems.length).toBe(2);
    expect(allItems).toContain('EYECELL Eye Contour Cream');
  });

  test('search is case-insensitive', () => {
    const tree = buildProductTree(BRAND_ROWS, 'ALLIES');
    expect(tree.flatMap(g => g.items).length).toBe(2);
  });

  test('empty input returns empty tree', () => {
    expect(buildProductTree([])).toEqual([]);
  });
});
