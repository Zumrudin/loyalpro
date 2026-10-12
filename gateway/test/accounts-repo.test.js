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
