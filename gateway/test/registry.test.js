'use strict';
// registry.start: живой клиент переиспользуется, остановившийся сам (closed) —
// пересоздаётся. Модули с БД/TDLib подменяем через require.cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

function stub(rel, exports) {
  const p = require.resolve(path.join('..', 'lib', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
let created = 0;
class FakeClient {
  constructor(account) { this.id = account.id; this.authState = 'starting'; this.closed = false; this.n = ++created; }
  async start() {}
  async close() { this.closed = true; }
  async logout() { this.loggedOut = true; }
}
stub('accounts-repo', { get: async (id) => ({ id, channel: 'tdlib' }), setAuth: async () => {}, listActive: async () => [] });
class FakeWa extends FakeClient {}
FakeClient.dirsFor = (cfg, id) => ({ base: path.join(cfg.DATA_DIR, `acc-${id}`), db: path.join(cfg.DATA_DIR, `acc-${id}`, 'db') });
FakeWa.dirsFor = (cfg, id) => ({ base: path.join(cfg.DATA_DIR, `acc-${id}`), wa: path.join(cfg.DATA_DIR, `acc-${id}`, 'wa') });
stub('telegram-client', { TelegramClient: FakeClient });
stub('whatsapp-client', { WhatsappClient: FakeWa });
class FakeMax extends FakeClient {}
FakeMax.dirsFor = (cfg, id) => ({ base: path.join(cfg.DATA_DIR, `acc-${id}`), max: path.join(cfg.DATA_DIR, `acc-${id}`, 'max'), session: path.join(cfg.DATA_DIR, `acc-${id}`, 'max', 'session.json') });
stub('max-client', { MaxClient: FakeMax });
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

test('clientClassFor: tdlib → Telegram, whatsapp → WhatsApp, max → MAX, прочее → 422', () => {
  assert.equal(registry.clientClassFor({ channel: 'tdlib' }), FakeClient);
  assert.equal(registry.clientClassFor({ channel: 'whatsapp' }), FakeWa);
  assert.equal(registry.clientClassFor({ channel: 'max' }), FakeMax);
  assert.throws(() => registry.clientClassFor({ channel: 'max_bot' }), e => e.status === 422);
});

test('logout MAX без живого клиента: каталог max есть, а session.json нет → клиент НЕ запускается (не было бы лишнего QR), logged_out', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-reg-'));
  const cfgPath = require.resolve('../config');
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { DATA_DIR: tmp } };
  fs.mkdirSync(path.join(tmp, 'acc-77', 'max'), { recursive: true });
  const before = created;
  await registry.logout(77);
  assert.equal(created, before, 'клиент не создавался');
  assert.equal(fs.existsSync(path.join(tmp, 'acc-77')), false, 'каталог аккаунта удалён');
  // С сохранённой сессией — поднимаем и разлогиниваем по-настоящему (токен гасится на сервере).
  fs.mkdirSync(path.join(tmp, 'acc-78', 'max'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'acc-78', 'max', 'session.json'), '{"deviceId":"d","loginToken":"T"}');
  await registry.logout(78);
  assert.equal(created, before + 1);
});
