'use strict';
// registry.start: живой клиент переиспользуется, остановившийся сам (closed) —
// пересоздаётся. Модули с БД/TDLib подменяем через require.cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function stub(rel, exports) {
  const p = require.resolve(path.join('..', 'lib', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
let created = 0;
class FakeClient {
  constructor(account) { this.id = account.id; this.authState = 'starting'; this.closed = false; this.n = ++created; }
  async start() {}
  async close() { this.closed = true; }
}
stub('accounts-repo', { get: async (id) => ({ id, channel: 'tdlib' }), setAuth: async () => {}, listActive: async () => [] });
stub('telegram-client', { TelegramClient: FakeClient });
const registry = require('../lib/registry');

test('start: живой клиент тот же; закрытый сам по себе — пересоздаётся', async () => {
  const a = await registry.start(5);
  assert.equal(await registry.start(5), a);
  a.closed = true;                       // например, брошенный мастер QR → error
  const b = await registry.start(5);
  assert.notEqual(b, a);
  assert.equal(b.n, 2);
  assert.equal(registry.get(5), b);
});
