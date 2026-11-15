'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function harness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', addEventListener() {}, querySelectorAll: () => [], classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  let uuid = 0;
  const c = vm.createContext({ document: { getElementById: get }, crypto: { randomUUID: () => `new-key-${++uuid}` },
    notify: jest.fn(), Date, URLSearchParams, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/pages/journal.js'), 'utf8'), c);
  vm.runInContext("journal.session={sessionId:'initial',recordId:71,edit:{comment:'draft'}}", c);
  c.jrApi = jest.fn().mockResolvedValue({ recordId: 71 });
  c.jrClose = jest.fn(); c.loadJournal = jest.fn();
  c.jrStockHasDirtyGoods = jest.fn(() => true);
  c.jrStockSaveGoods = jest.fn().mockResolvedValue(true);
  return { c, get, run: code => vm.runInContext(code, c) };
}

test('acknowledged service edits are not resubmitted after a stock rejection', async () => {
  const h = harness();
  h.c.jrStockSaveGoods.mockRejectedValueOnce(Object.assign(new Error('stock validation'), { status: 400 }));
  expect(await h.c.jrSave(h.c.jrSessionBody())).toBe(false);
  expect(h.c.jrClose).not.toHaveBeenCalled();
  expect(h.run('journal.session.sessionId')).toBe('initial');
  expect(h.get('jrModalError').textContent).toContain('товары пока не сохранены');
  expect(await h.c.jrSave(h.c.jrSessionBody())).toBe(true);
  expect(h.c.jrApi).toHaveBeenCalledTimes(1);
  expect(h.c.jrStockSaveGoods).toHaveBeenCalledTimes(2);
});

test('goods-only save does not enqueue an empty journal operation', async () => {
  const h = harness(); h.run('delete journal.session.edit');
  expect(await h.c.jrSave(h.c.jrSessionBody())).toBe(true);
  expect(h.c.jrApi).not.toHaveBeenCalled();
  expect(h.c.jrStockSaveGoods).toHaveBeenCalledWith(71);
});

test('session conflict keeps unsaved goods open and does not claim full success', async () => {
  const h = harness();
  h.c.jrApi.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'session_used', status: 409 }));
  expect(await h.c.jrSave(h.c.jrSessionBody())).toBe(false);
  expect(h.c.jrClose).not.toHaveBeenCalled();
  expect(h.c.jrStockSaveGoods).not.toHaveBeenCalled();
  expect(h.get('jrModalError').textContent).toContain('остались в черновике');
});

test('new service edits after an acknowledged package use a new session key', async () => {
  const h = harness();
  h.c.jrStockSaveGoods.mockRejectedValueOnce(new Error('lost stock response'));
  await h.c.jrSave(h.c.jrSessionBody());
  h.run("journal.session.edit.comment='changed after save'");
  await h.c.jrSave(h.c.jrSessionBody());
  expect(h.c.jrApi).toHaveBeenCalledTimes(2);
  expect(h.c.jrApi.mock.calls[1][1].sessionId).not.toBe('initial');
});
