'use strict';

const fs = require('fs');
const vm = require('vm');

function htmlElement() {
  return { innerHTML: '', textContent: '', value: '', style: {}, addEventListener() {} };
}

function createContext(api) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, htmlElement());
      return elements.get(id);
    },
    createElement() {
      let value = '';
      return {
        set textContent(next) { value = String(next ?? ''); },
        get innerHTML() {
          return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },
      };
    },
  };
  const context = vm.createContext({ UIEvents: require('../frontend/js/core/ui-events.js'),
    document,
    api,
    notify: jest.fn(),
    openModal: jest.fn(),
    closeModal: jest.fn(),
    fireConfetti: jest.fn(),
    avc: () => '#000000',
    avi: name => String(name || '').slice(0, 1),
    LVL_B: {},
    LVL_L: {},
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Date,
    Number,
    parseFloat,
    parseInt,
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/js/core/utils.js`, 'utf8'), context);
  vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/js/pages/clients.js`, 'utf8'), context);
  context.cdLoadPurchases = jest.fn(async () => {});
  return { context, elements };
}

const injectedDescription = '<img src=x onerror="globalThis.__injected=1"> Операция & проверка';

test('openCD encodes stored HTML and other dynamic fields instead of creating markup', async () => {
  const api = jest.fn(async (_method, url) => {
    if (url === '/api/clients/7') return {
      client: {
        id: 7, name: '<b>Клиент</b>', phone: '', email: 'synthetic@example.invalid',
        yclients_card_id: 4, yclients_card_number: '<svg onload=globalThis.__injected=1>',
        bonus_balance: '-12.5', total_spent: 0, visits_count: 1,
      },
      history: [{ created_at: '2026-01-01', amount: -12.5, balance_after: 0, description: injectedDescription }],
      records: [],
    };
    if (url === '/api/clients/7/card-transactions') return { local: [], yclients: [] };
    throw new Error(`Unexpected URL: ${url}`);
  });
  const { context, elements } = createContext(api);
  await context.openCD(7);
  const html = elements.get('cmBody').innerHTML;
  expect(html).toContain('&lt;img src=x onerror=');
  expect(html).toContain('&lt;svg onload=');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<svg onload=');
  expect(html).toContain('&lt;b&gt;Клиент&lt;/b&gt;');
  expect(html).toContain('Операция &amp; проверка');
  expect(elements.get('cmTitle').textContent).toBe('<b>Клиент</b>');
  expect(context.__injected).toBeUndefined();
  expect(context.openModal).toHaveBeenCalledWith('clientModal');
});

test('openCD preserves Unicode, empty history and signed fractional amounts', async () => {
  const api = jest.fn(async (_method, url) => {
    if (url === '/api/clients/8') return {
      client: { id: 8, name: 'Ирина', bonus_balance: 0, total_spent: 0, visits_count: 0 },
      history: [{ created_at: '2026-01-01', amount: 2.75, balance_after: -1.25, description: 'Корректировка — причина' }],
      records: [],
    };
    if (url === '/api/clients/8/card-transactions') return { local: [], yclients: [] };
    throw new Error(`Unexpected URL: ${url}`);
  });
  const { context, elements } = createContext(api);
  await context.openCD(8);
  const html = elements.get('cmBody').innerHTML;
  expect(html).toContain('Корректировка — причина');
  expect(html).toContain('+2,75');
  expect(html).toContain('-1,25');
});

test('bonus search uses numeric data attributes and encoded text', async () => {
  const api = jest.fn(async () => ({ clients: [{
    id: '7 onclick=globalThis.__injected=1', name: '<b>Клиент</b>', phone: '', bonus_balance: '1 onmouseover=globalThis.__injected=1',
  }] }));
  const { context, elements } = createContext(api);
  await context.searchBonusC('synthetic');
  const html = elements.get('bmr').innerHTML;
  expect(html).toContain('data-bonus-pick="0"');
  expect(html).toContain('data-bonus-balance="0"');
  expect(html).toContain('&lt;b&gt;Клиент&lt;/b&gt;');
  expect(html).not.toContain('<b>Клиент</b>');
  expect(html).not.toContain('onmouseover=');
});
