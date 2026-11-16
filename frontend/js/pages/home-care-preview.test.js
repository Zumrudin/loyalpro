const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildHomeCareHtml } = require('../../../backend/homecare-template.js');

function harness(ok) {
  const state = { opened: [], fetches: [], printed: 0, closed: 0, html: '', notices: [] };
  const listeners = {};
  const popup = { print() { state.printed++; }, close() { state.closed++; }, document: {
    write(html) { state.html = html; }, close() {},
    getElementById(id) { return { addEventListener(type, callback) { listeners[id] = callback; } }; }
  } };
  const ctx = vm.createContext({ document: { addEventListener() {} }, TOKEN: 'synthetic-token',
    window: { open(url) { state.opened.push(url); return popup; } },
    fetch: async (url, options) => { state.fetches.push({ url, options }); return { ok, text: async () => '<button id="hcPrintPreview"></button><button id="hcClosePreview"></button><script src="/js/homecare-print.js"></script>' }; },
    notify: (...args) => state.notices.push(args)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'home-care.js'), 'utf8'), ctx);
  return { state, listeners, ctx };
}

test('authenticated preview uses a reserved popup and explicit print/close listeners', async () => {
  const h = harness(true);
  await h.ctx.hcPrintById(123);
  assert.deepEqual(h.state.opened, ['']);
  assert.equal(h.state.fetches[0].url, '/api/home-care/123/preview');
  assert.equal(h.state.fetches[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.doesNotMatch(h.state.html, /<script|\sonclick=/);
  h.listeners.hcPrintPreview(); h.listeners.hcClosePreview();
  assert.equal(h.state.printed, 1); assert.equal(h.state.closed, 1);
});

test('unauthorized preview closes reserved popup and never renders the response body', async () => {
  const h = harness(false);
  await h.ctx.hcPrintById(123);
  assert.equal(h.state.closed, 1);
  assert.equal(h.state.html, '');
  assert.equal(h.state.notices.length, 1);
});

test('direct preview emits external script and fixed controls, without inline JavaScript', () => {
  const html = buildHomeCareHtml({ items: [], client_name: 'Synthetic', created_at: '2026-11-01' });
  assert.match(html, /id="hcPrintPreview"/);
  assert.match(html, /id="hcClosePreview"/);
  assert.match(html, /<script src="\/js\/homecare-print.js"><\/script>/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<script\s*>/i);
});
