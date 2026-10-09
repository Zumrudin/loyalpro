'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDeliveries, STATUS, parseId } = require('../lib/deliveries');

function fakeDb() {
  const calls = [];
  return { calls,
    oneOrNone: async (sql, p) => { calls.push([sql, p]); return sql.includes('INSERT') ? { id: 12 } : (p[0] === 12 ? { id: 12, account_id: 1, status_id: 1, description: 'Принято', error: null } : null); },
    query: async (sql, p) => { calls.push([sql, p]); return { rowCount: 1 }; },
  };
}

test('parseId: g<n> → n, иначе null', () => {
  assert.equal(parseId('g12'), 12);
  assert.equal(parseId('12'), null);
  assert.equal(parseId('gx'), null);
  assert.equal(parseId(null), null);
  assert.equal(parseId('g0'), null);
  assert.equal(parseId('g' + '1'.repeat(20)), null);
});

test('STATUS: 5 — «Невозможно доставить» (его проверяет бэкенд)', () => {
  assert.deepEqual(STATUS.FAILED, [5, 'Невозможно доставить']);
  assert.equal(STATUS.ACCEPTED[0], 1);
});

test('create → id строки; setStatus обновляет статус/ошибку/tdlib id; get скоупится аккаунтом', async () => {
  const db = fakeDb();
  const d = makeDeliveries(db);
  const id = await d.create({ accountId: 1, chatId: 5, phone: '79001112233', kind: 'text', text: 'hi' });
  assert.equal(id, 12);
  assert.match(db.calls[0][0], /INSERT INTO gateway_deliveries/);
  assert.deepEqual(db.calls[0][1], [1, 5, '79001112233', 'text', 'hi', 1, 'Принято']);
  await d.setStatus(12, STATUS.SENT, { tdlibMessageId: 777 });
  assert.match(db.calls[1][0], /UPDATE gateway_deliveries SET status_id=\$2/);
  assert.deepEqual(db.calls[1][1], [12, 2, 'Отправлено', 777, null]);
  await d.setStatus(12, STATUS.FAILED, { error: 'boom' });
  assert.deepEqual(db.calls[2][1], [12, 5, 'Невозможно доставить', null, 'boom']);
  const row = await d.get(1, 12);
  assert.equal(row.id, 12);
  assert.match(db.calls[3][0], /WHERE id=\$1 AND account_id=\$2/);
  assert.equal(await d.get(2, 99), null);
});

test('create бросает, если INSERT не вернул строку', async () => {
  const d = makeDeliveries({ oneOrNone: async () => null, query: async () => ({}) });
  await assert.rejects(d.create({ accountId: 1, chatId: 5, phone: 'p', kind: 'text', text: 't' }), /не вернул id/);
});
