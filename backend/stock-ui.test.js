'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const files = [
  'stock.js',
  'stock-balances.js',
  'stock-docs.js',
  'stock-sale.js',
  'stock-inventory.js',
  'stock-refs.js',
];
function harness() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '',
        checked: false,
        innerHTML: '',
        textContent: '',
        hidden: false,
        disabled: false,
        open: false,
        dataset: {},
        classList: { toggle: jest.fn() },
        addEventListener: jest.fn(),
        querySelector: () => null,
        querySelectorAll: () => [],
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    document: { getElementById: get },
    api: jest.fn(),
    fetch: jest.fn(),
    TOKEN: 'synthetic-token',
    ME: { role: 'owner' },
    location: { hash: '#stock' },
    window: { confirm: jest.fn(() => true) },
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
  });
  for (const file of files)
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8'), ctx, {
      filename: file,
    });
  return { ctx, get, run: (s) => vm.runInContext(s, ctx) };
}
test('quantities preserve fractional base units and negative signs', () => {
  const { ctx } = harness();
  expect(ctx.stockFmtQty(941, 500, 'шт', 'мл')).toBe('1 шт + 441 мл');
  expect(ctx.stockFmtQty(-4059, 500, 'шт', 'мл')).toBe('−9 шт + 441 мл');
  expect(ctx.stockFmtQty(7, 1, 'шт', 'шт')).toBe('7 шт');
  expect(ctx.stockFmtQty(-941, 500, 'шт', 'мл')).toBe('−2 шт + 59 мл');
  expect(ctx.stockFmtQty(0.25, 1, 'мл', 'мл')).toBe('0,25 мл');
});
test('balance filters and rendering escape catalog and storage titles', () => {
  const { ctx } = harness();
  const goods = [
    {
      id: 1,
      title: '<script>x</script>',
      unit_equals: 1,
      unit: 'шт',
      balances: [{ storage_id: 3, qty_base: -2, negative: true, critical: true }],
    },
    { id: 2, title: 'Normal', balances: [] },
  ];
  expect(ctx.stockBalanceRows(goods, [], { onlyNegative: true })).toHaveLength(1);
  const html = ctx.stockBalancesHtml(goods, [{ id: 3, title: '<img>' }], {});
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;img&gt;');
  expect(html).toContain('stock-neg');
});
test('stale catalog response cannot overwrite the newest filters', async () => {
  const h = harness();
  let resolve;
  h.ctx.stockApi = jest
    .fn()
    .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    .mockResolvedValueOnce({ goods: [{ id: 2, title: 'new', balances: [] }] });
  h.ctx.stockRenderGoodsCatalog = jest.fn();
  const first = h.ctx.stockLoadGoods();
  await h.ctx.stockLoadGoods();
  resolve({ goods: [{ id: 1, title: 'old', balances: [] }] });
  await first;
  expect(h.run('_stock.goods[0].title')).toBe('new');
});
test('catalog page slices rows and moving pages clears selection without changing the active filters', () => {
  const h = harness();
  h.run(`
    _stock.goods = Array.from({ length: 27 }, (_, i) => ({ id: i + 1, title: 'Товар ' + (i + 1) }));
    _stock.catalogPageSize = 25;
    _stock.catalogPage = 99;
    _stock.selectedGoods = new Set([1, 2]);
  `);
  expect(h.ctx.stockCatalogPageRows()).toMatchObject({ totalPages: 2, from: 25 });
  expect(h.ctx.stockCatalogPageRows().rows.map((g) => g.id)).toEqual([26, 27]);
  h.ctx.stockRenderGoodsCatalog = jest.fn();
  h.ctx.stockCatalogSetPage(1);
  expect(h.run('_stock.catalogPage')).toBe(1);
  expect(h.run('_stock.selectedGoods.size')).toBe(0);
  expect(h.ctx.stockRenderGoodsCatalog).toHaveBeenCalledTimes(1);
});
test('catalog escapes category, title, article and comment in its tree and rows', () => {
  const h = harness();
  h.run(`
    _stock.dictionaries.categories = [[{ id: 9, title: '<img src=x onerror=1>' }]];
    _stock.goods = [{ id: 1, title: '<script>title</script>', article: '<b>SKU</b>', comment: '<svg>', unit: 'шт', service_unit: 'мл', unit_equals: 10 }];
  `);
  const html = h.ctx.stockGoodsHtml(h.run('_stock.goods'));
  expect(html).toContain('&lt;script&gt;title&lt;/script&gt;');
  expect(html).toContain('&lt;b&gt;SKU&lt;/b&gt;');
  expect(html).toContain('&lt;svg&gt;');
  expect(html).toContain('&lt;img src=x onerror=1&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<svg>');
});
test('bulk archive stops after a partial or uncertain outcome and reports completed rows', async () => {
  const h = harness();
  h.run(`
    _stock.goods = [11, 12, 13].map((id) => ({ id, title: 'Товар ' + id }));
    _stock.selectedGoods = new Set([11, 12, 13]);
  `);
  h.ctx.stockLoadGoods = jest.fn().mockResolvedValue();
  h.ctx.stockLoadCounters = jest.fn().mockResolvedValue();
  const uncertain = Object.assign(new Error('Результат операции неизвестен.'), { uncertain: true });
  h.ctx.stockApi = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(uncertain);
  await h.ctx.stockArchiveSelectedGoods();
  expect(h.ctx.stockApi).toHaveBeenCalledTimes(2);
  expect(h.ctx.stockApi).toHaveBeenNthCalledWith(1, '/goods/11', { stockActive: false }, 'PUT');
  expect(h.get('stockStatus').textContent).toContain('Архивировано: 1 из 3');
  expect(h.get('stockStatus').textContent).toContain('неизвестен');
  expect(h.run('_stock.selectedGoods.size')).toBe(0);
  expect(h.ctx.stockLoadGoods).toHaveBeenCalledTimes(1);
});
test('good draft maps empty optional values to null and preserves zero prices', () => {
  const h = harness();
  h.get('stockGoodTitle').value = 'Local';
  h.get('stockGoodUnit').value = '1';
  h.get('stockGoodRatio').value = '1';
  h.get('stockGoodPrice').value = '0';
  h.get('stockGoodActive').checked = true;
  expect(h.ctx.stockGoodFormDraft()).toMatchObject({
    title: 'Local',
    unitId: 1,
    unitEquals: 1,
    salePrice: 0,
    actualCost: null,
    stockActive: true,
  });
});
test('closed good card cannot be reopened by a late response', async () => {
  const h = harness();
  let resolve;
  h.ctx.stockApi = () => new Promise((r) => (resolve = r));
  const pending = h.ctx.stockOpenGood(3);
  h.ctx.stockCloseGood();
  resolve({
    good: { id: 3, title: 'late' },
    balances: [],
    openings: [],
    receipts: [],
    techCards: [],
    movements: { movements: [], total: 0 },
  });
  await pending;
  expect(h.get('stockGoodModal').open).toBe(false);
});
test('stock scripts share global scope with all application scripts and are versioned', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  for (const file of files) expect(html).toMatch(new RegExp('pages/' + file.replace('.', '\\.') + '\\?v='));
  const all = [...html.matchAll(/<script src="(js\/[^"?]+)\?[^\"]*"/g)].map((m) => m[1]);
  const names = new Map();
  for (const file of all) {
    const code = fs.readFileSync(path.join(__dirname, '../frontend', file), 'utf8');
    for (const m of code.matchAll(/^(?:async\s+function|function|const|let|var)\s+((?:stock|STOCK_|_stock)[\w$]*)/gm)) {
      expect({ name: m[1], previous: names.get(m[1]) }).toEqual({ name: m[1], previous: undefined });
      names.set(m[1], file);
    }
  }
  expect(html.match(/data-p="stock"/g) || []).toHaveLength(2);
});
test('document totals round each line to kopeks and badges escape nothing untrusted', () => {
  const { ctx } = harness();
  expect(
    ctx.stockLinesTotal([
      { qty: 3, costPerUnit: 0.1, discount: 0 },
      { qty: 1, costPerUnit: 1, discount: 10 },
    ]),
  ).toBe(120);
  expect(ctx.stockDocBadge({ origin: 'yclients', status: 'cancelled' })).toContain('Отменён');
  expect(
    ctx.stockDocumentHtml({
      id: 1,
      kind: 'receipt',
      origin: 'loyalpro',
      status: 'posted',
      comment: '<script>x</script>',
      lines: [],
    }),
  ).not.toContain('<script>');
});
test('sale rejects mismatch and bonus payments, gift has no payments', () => {
  const { ctx } = harness();
  expect(() => ctx.stockCheckPayments([{ method: 'cash', amount: 9 }], 1000, false)).toThrow();
  expect(() => ctx.stockCheckPayments([{ method: 'bonus', amount: 10 }], 1000, false)).toThrow();
  expect(() => ctx.stockCheckPayments([], 0, true)).not.toThrow();
  expect(() => ctx.stockCheckPayments([{ method: 'cash', amount: 1 }], 0, true)).toThrow();
});
test('inventory difference is signed and turnover CSV neutralizes formulas', () => {
  const { ctx } = harness();
  expect(ctx.stockInvRows([{ good_row_id: 1, expected_base: 5, counted_base: 3 }])[0].diff).toBe(-2);
  expect(ctx.stockInvRows([{ good_row_id: 1, expected_base: 5, counted_base: null }])[0].diff).toBeNull();
  expect(ctx.stockCsvCell('=HYPERLINK("evil")')).toContain("'=HYPERLINK");
  expect(ctx.stockTurnoverRows([{ title: 'Cream' }, { title: 'Soap' }], { search: 'soap' })).toHaveLength(1);
});

test('stock API keeps validation lists and flags uncertain write outcomes', async () => {
  const h = harness();
  h.ctx.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ errors: ['first', 'second'] }) });
  await expect(h.ctx.stockApi('/sales', {})).rejects.toMatchObject({
    status: 400,
    message: 'first\nsecond',
    uncertain: false,
  });
  h.ctx.fetch.mockRejectedValue(new Error('synthetic timeout'));
  await expect(h.ctx.stockApi('/sales', {})).rejects.toMatchObject({ uncertain: true });
});
test('uncertain sale locks resubmit until operator reviews operations', async () => {
  const h = harness();
  h.ctx.stockSaleDraft = () => ({ lines: [] });
  h.ctx.stockApi = jest.fn().mockRejectedValue(Object.assign(new Error('unknown result'), { uncertain: true }));
  await h.ctx.stockSaveSale({ preventDefault() {} });
  await h.ctx.stockSaveSale({ preventDefault() {} });
  expect(h.ctx.stockApi).toHaveBeenCalledTimes(1);
  expect(h.get('stockSaleSave').disabled).toBe(true);
});
test('invalid inventory count blocks posting rather than using the previous persisted value', async () => {
  const h = harness();
  h.run('_stockInv.doc={id:1,lines:[]};');
  h.ctx.stockInventoryChanged(1, '');
  await expect(h.ctx.stockFlushInventory()).rejects.toThrow('факт');
});
