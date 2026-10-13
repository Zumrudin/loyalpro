'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// accounts-repo тянет ../db (пул Postgres) — подменяем через кэш require.
const dbPath = require.resolve('../db');
const calls = [];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db: {
  oneOrNone: async (sql, p) => { calls.push([sql, p]); return sql.includes('gateway_contacts') ? { phone: '79001112233' } : null; },
  any: async (sql, p) => { calls.push([sql, p]); return []; },
  query: async (sql, p) => { calls.push([sql, p]); },
} } };
const repo = require('../lib/accounts-repo');

test('listActive: оба канала шлюза, статусы active|pending', async () => {
  await repo.listActive();
  assert.match(calls.at(-1)[0], /channel IN \('tdlib','whatsapp'\)/);
  assert.match(calls.at(-1)[0], /status IN \('active','pending'\)/);
});
test('phoneByLid: ищет в gateway_contacts по account_id и user_id', async () => {
  assert.equal(await repo.phoneByLid(9, '46810865385627'), '79001112233');
  assert.match(calls.at(-1)[0], /FROM gateway_contacts WHERE account_id=\$1 AND user_id=\$2/);
  assert.deepEqual(calls.at(-1)[1], [9, '46810865385627']);
});
test('phoneByLid: пустой lid → null без запроса', async () => {
  const n = calls.length;
  assert.equal(await repo.phoneByLid(9, null), null);
  assert.equal(calls.length, n);
});

test('rememberContacts: пачка пар одним INSERT … ON CONFLICT (account_id, phone) DO UPDATE', async () => {
  const n = calls.length;
  await repo.rememberContacts(9, [{ phone: '79001112233', userId: '111' }, { phone: '79004445566', userId: '222' }]);
  assert.equal(calls.length, n + 1);
  const [sql, params] = calls.at(-1);
  assert.match(sql, /INSERT INTO gateway_contacts \(account_id, phone, user_id\) VALUES \(\$1,\$2,\$3\),\(\$1,\$4,\$5\)/);
  assert.match(sql, /ON CONFLICT \(account_id, phone\) DO UPDATE SET user_id=EXCLUDED\.user_id/);
  assert.deepEqual(params, [9, '79001112233', '111', '79004445566', '222']);
});
test('rememberContacts: дубль номера в пачке схлопывается (последний LID), иначе Postgres: «cannot affect row a second time»', async () => {
  await repo.rememberContacts(9, [{ phone: '79001112233', userId: '111' }, { phone: '79001112233', userId: '333' }]);
  assert.deepEqual(calls.at(-1)[1], [9, '79001112233', '333']);
});
test('rememberContacts: пусто/мусор → без запроса; больше пачки → несколько запросов', async () => {
  const n = calls.length;
  await repo.rememberContacts(9, []);
  await repo.rememberContacts(9, [null, { phone: '', userId: '1' }, { phone: '79001112233' }]);
  assert.equal(calls.length, n);
  const many = Array.from({ length: repo.CONTACTS_BATCH + 1 }, (_, i) => ({ phone: String(79000000000 + i), userId: String(i + 1) }));
  await repo.rememberContacts(9, many);
  assert.equal(calls.length, n + 2);
});
