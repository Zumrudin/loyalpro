'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../frontend/js/pages/journal-toolbar.js'), 'utf8');

function harness() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      querySelector: selector => selector === '[data-summary-retry]' ? { onclick: null } : null, querySelectorAll: () => [],
    });
    return nodes.get(id);
  };
  const document = {
    readyState: 'loading',
    getElementById: node,
    querySelectorAll: () => [],
    addEventListener: jest.fn(),
  };
  const context = vm.createContext({ document, window: {}, journal: {}, URLSearchParams, Intl, Date, Number, String, Set, Math, Promise, console });
  vm.runInContext(SOURCE, context, { filename: 'journal-toolbar.js' });
  return { context, get: node };
}

test('summary loading clears stale total and rejects an old date response', async () => {
  const h = harness();
  h.get('jrDate').value = '2030-04-02';
  h.get('jrSummaryTotal').textContent = '123';
  const resolvers = [];
  h.context.jrApi = jest.fn(() => new Promise(resolve => { resolvers.push(resolve); }));
  const pending = h.context.jrSummaryLoad('2030-04-01');
  expect(h.get('jrSummaryTotal').textContent).toBe('—');
  h.get('jrDate').value = '2030-04-02';
  const newer = h.context.jrSummaryLoad('2030-04-02');
  resolvers[0]({ date: '2030-04-01', total: 10 });
  await pending;
  expect(h.get('jrSummaryTotal').textContent).toBe('—');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('Загрузка');
  resolvers[1]({ date: '2030-04-02', total: 20 });
  await newer;
});

test('summary date mismatch becomes a retryable error', async () => {
  const h = harness();
  h.get('jrDate').value = '2030-04-02';
  h.context.jrApi = jest.fn().mockResolvedValue({ date: '2030-04-01', total: 10 });
  await h.context.jrSummaryLoad('2030-04-02');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('другой даты');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('Повторить');
  expect(h.get('jrSummaryTotal').textContent).toBe('—');
});

test('summary errors render a retry action and do not turn unknown values into zero', async () => {
  const h = harness();
  h.get('jrDate').value = '2030-04-02';
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('synthetic failure'));
  await h.context.jrSummaryLoad('2030-04-02');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('synthetic failure');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('Повторить');
  expect(h.get('jrSummaryTotal').textContent).toBe('—');
  h.context.jrSummaryRender({ date: '2030-04-02', clientCount: null, total: null, cash: 0 });
  expect(h.get('jrSummaryPopup').innerHTML).toContain('0 ₽');
  expect(h.get('jrSummaryPopup').innerHTML).toContain('—');
});
