'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, dataset: {},
        classList: { toggle: jest.fn() },
        addEventListener: jest.fn(),
        close: jest.fn(), showModal: jest.fn(),
      });
    return nodes.get(id);
  };
  const context = vm.createContext({ UIEvents: require('../frontend/js/core/ui-events.js'),
    document: { getElementById: get },
    URLSearchParams,
    Date,
    Intl,
    fetch: jest.fn(),
    TOKEN: 'synthetic-token',
    location: { hash: '#stock/docs' },
    setTimeout,
    clearTimeout,
  });
  for (const file of ['stock.js', 'stock-balances.js', 'stock-docs.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8'), context, { filename: file });
  return { context, get, run: (code) => vm.runInContext(code, context) };
}

test('operation filter query uses the applied UI filters and a bounded page size', () => {
  const h = harness();
  Object.assign(h.get('stockOpsFrom'), { value: '2026-11-01' });
  Object.assign(h.get('stockOpsTo'), { value: '2026-11-15' });
  Object.assign(h.get('stockOpsKind'), { value: 'writeoff' });
  Object.assign(h.get('stockOpsStorage'), { value: '5' });
  Object.assign(h.get('stockOpsSearch'), { value: 'раствор' });
  Object.assign(h.get('stockOpsCounterparty'), { value: 'Поставщик' });
  Object.assign(h.get('stockOpsClient'), { value: 'Анна' });
  Object.assign(h.get('stockOpsDocumentNumber'), { value: '2450693265' });
  Object.assign(h.get('stockOpsService'), { value: '19' });
  Object.assign(h.get('stockOpsPaymentStatus'), { value: 'paid' });
  Object.assign(h.get('stockOpsOrigin'), { value: 'yclients' });
  Object.assign(h.get('stockOpsStatus'), { value: 'posted' });
  Object.assign(h.get('stockOpsLimit'), { value: '100' });
  expect(h.context.stockOpsParams(2).toString()).toBe(
    'page=2&limit=100&from=2026-11-01&to=2026-11-15&kind=writeoff&origin=yclients&status=posted&storage=5&search=%D1%80%D0%B0%D1%81%D1%82%D0%B2%D0%BE%D1%80&counterparty=%D0%9F%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%89%D0%B8%D0%BA&client_search=%D0%90%D0%BD%D0%BD%D0%B0&document_number=2450693265&service=19&payment_status=paid',
  );
});

test('operation rows escape external text, retain fractional signed quantities and mark unavailable historical values', () => {
  const { context } = harness();
  const html = context.stockOperationsTable([{
    movement_id: 4,
    document_id: 3,
    document_number: '<script>doc</script>',
    occurred_at: '2026-11-15T11:20:00+03:00',
    counterparty_name: '<img src=x>',
    kind: 'writeoff', origin: 'yclients', status: 'posted', storage_title: '<svg>',
    comment: '<script>alert(1)</script>', good_row_id: 9, good_title: '<b>Раствор</b>', article: '<i>001</i>',
    qty_base: -0.00001, qty_pack: -1, unit_title: 'фл.', service_unit_title: 'мл',
    cost_basis: null, balance_after: null,
  }]);
  expect(html).toContain('−1 фл.');
  expect(html).toContain('0,00001 мл');
  expect(html).toContain('Нет данных');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&lt;img src=x&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<svg>');
});

test('operation pagination remains consistent for an empty result set', () => {
  const { context } = harness();
  expect(context.stockOperationsPagination(1, 0, 25)).toContain('Страница 1 из 1');
  expect(context.stockOperationsPagination(1, 0, 25)).toContain('disabled');
});

test('history hides technical identifiers and known legacy events disclose their limitation', () => {
  const { context } = harness();
  expect(context.stockOpsHistoryChanges({ storage_id: { from: 1, to: 2 }, comment: { from: 'a', to: 'b' } })).toBe(
    'Склад изменён; Комментарий изменён',
  );
  expect(context.stockOpsHistoryChanges({ status: { from: 'draft', to: 'posted' } })).toBe(
    'Статус документа: Черновик → Проведён',
  );
  expect(context.stockOpsQuantity({ qty_base: -0.25, qty_pack: null, unit_title: 'фл.', service_unit_title: 'мл' })).toBe('−0,25 мл');
  expect(context.stockOpsHistoryChanges({ qty_base: { from: 1, to: 2 }, unit_type: { from: 1, to: 2 } })).toBe(
    'Количество: 1 → 2; Единица измерения: Единица продажи → Единица списания',
  );
  context.stockToday = () => '2026-03-31';
  expect(context.stockOpsMonthPeriod()).toEqual({ from: '2026-02-28', to: '2026-03-31' });
});

test('paging and export keep the applied filters until the next submit', async () => {
  const h = harness();
  h.run('_stockDoc.servicesLoaded = true');
  h.get('stockOpsSearch').value = 'applied';
  h.get('stockOpsLimit').value = '25';
  h.context.stockApi = jest.fn().mockResolvedValue({ operations: [], total: 60, limit: 25 });
  await h.context.stockLoadDocs(1);
  h.get('stockOpsSearch').value = 'not submitted';
  await h.context.stockLoadDocs(2, true);
  expect(h.context.stockApi.mock.calls[1][0]).toContain('search=applied');
  expect(h.context.stockApi.mock.calls[1][0]).toContain('page=2');
  h.context.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Synthetic export failure' }) });
  await h.context.stockExportOperations();
  expect(h.context.fetch.mock.calls[0][0]).toContain('search=applied');
  expect(h.context.fetch.mock.calls[0][0]).not.toContain('not+submitted');
  await h.context.stockLoadDocs(1);
  expect(h.context.stockApi.mock.calls[2][0]).toContain('search=not+submitted');
});

test('a late response cannot replace the latest result; failure clears rows and export snapshot', async () => {
  const h = harness();
  h.run('_stockDoc.servicesLoaded = true');
  let resolveOld;
  h.context.stockApi = jest.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ operations: [], total: 2, limit: 25 });
  const old = h.context.stockLoadDocs(1);
  await h.context.stockLoadDocs(1);
  resolveOld({ operations: [], total: 99, limit: 25 });
  await old;
  expect(h.get('stockOperationsCount').textContent).toBe('2');
  h.context.stockApi.mockRejectedValueOnce(new Error('Synthetic failure'));
  await h.context.stockLoadDocs(1);
  expect(h.get('stockOperationsList').innerHTML).toBe('');
  expect(h.get('stockOperationsError').textContent).toBe('Synthetic failure');
  expect(h.run('_stockDoc.appliedQuery')).toBe('');
});
