// Форма рассылки через мессенджеры: чистые помощники + загрузка всех скриптов index.html в ОДНУ область.
// Запуск: node --test frontend/js/pages/broadcasts-form.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');

function browserContext() {
  const ctx = vm.createContext({
    console, URLSearchParams, Intl,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  ctx.window = ctx;
  return ctx;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

const ctx = browserContext();
vm.runInContext(fs.readFileSync(path.join(FRONT, 'js/pages/broadcasts-form.js'), 'utf8'), ctx, { filename: 'broadcasts-form.js' });
const call = (fn, ...a) => { ctx.__a = a; return vm.runInContext(`${fn}(...__a)`, ctx); };

const mkRead = (o) => (id) => o[id];

test('bcCollectChannelSettings: пустой лимит → null, пустая пауза → дефолт канала', () => {
  const r = plain(call('bcCollectChannelSettings', mkRead({
    'bcCh-tdlib-on': true, 'bcCh-tdlib-delay': '', 'bcCh-tdlib-limit': '',
    'bcCh-whatsapp-on': true, 'bcCh-whatsapp-delay': '', 'bcCh-whatsapp-limit': '50',
    'bcCh-max-on': false, 'bcCh-max-delay': '30', 'bcCh-max-limit': '',
  })));
  assert.deepStrictEqual(r.tdlib, { enabled: true, delay_sec: 60, limit: null });
  assert.deepStrictEqual(r.whatsapp, { enabled: true, delay_sec: 180, limit: 50 });
  assert.deepStrictEqual(r.max, { enabled: false, delay_sec: 30, limit: null });
});

test('bcFormatForecast: сегодня/завтра, итог и пропущенные', () => {
  // 14:40 UTC = 17:40 МСК
  const at = Date.UTC(2026, 10, 2, 14, 40);
  const base = { byChannel: { tdlib: 40, whatsapp: 50, max: 8, none: 2 }, durationMin: 250, finishAt: at, nextDay: false, total: 100, skipped: 0, skippedBy: {} };
  assert.strictEqual(call('bcFormatForecast', base),
    'Всего 100 · Telegram 40 · WhatsApp 50 · MAX 8 · без мессенджера 2 · ≈ 4 ч 10 мин, закончится сегодня в 17:40');
  const next = { ...base, nextDay: true, skipped: 2, skippedBy: { blacklist: 1, no_recipient: 1 }, finishAt: Date.UTC(2026, 10, 3, 8, 20) };
  const s = call('bcFormatForecast', next);
  assert.match(s, /пропущено 2 \(чёрный список 1, нет адресата 1\)/);
  assert.match(s, /закончится завтра в 11:20$/);
});

test('bcFormatForecast: длительность меньше часа и пустой ответ', () => {
  const s = call('bcFormatForecast', { byChannel: { tdlib: 3 }, durationMin: 12, finishAt: Date.UTC(2026, 10, 2, 9, 0), nextDay: false, total: 3, skipped: 0 });
  assert.match(s, /≈ 12 мин/);
  assert.strictEqual(call('bcFormatForecast', null), '');
});

test('bcValidateMessengerForm: ни одного мессенджера, пустой текст, пустой список, битые числа', () => {
  const off = { tdlib: { enabled: false, delay_sec: 60, limit: null }, whatsapp: { enabled: false, delay_sec: 180, limit: null }, max: { enabled: false, delay_sec: 60, limit: null } };
  let e = plain(call('bcValidateMessengerForm', { audienceSource: 'filters', messageTemplate: 'Привет', channelSettings: off }));
  assert.deepStrictEqual(e, ['Включите хотя бы один мессенджер']);
  const on = { ...off, whatsapp: { enabled: true, delay_sec: 5000, limit: 0 } };
  e = plain(call('bcValidateMessengerForm', { audienceSource: 'list', list: [], messageTemplate: '  ', channelSettings: on }));
  assert.strictEqual(e.length, 4);
  e = plain(call('bcValidateMessengerForm', { audienceSource: 'list', list: [{ phone: '79200000000' }], messageTemplate: 'ok', channelSettings: { ...off, max: { enabled: true, delay_sec: 0, limit: null } } }));
  assert.deepStrictEqual(e, []);
});

test('все <script src> index.html грузятся в ОДНУ область без ошибок', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(js\/[^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]);
  assert.ok(srcs.includes('js/pages/broadcasts-form.js'), 'broadcasts-form.js не подключён в index.html');
  const c = browserContext();
  // Верхний уровень чужих страниц может трогать DOM — даём безопасные заглушки; ловим только SyntaxError
  // и коллизии объявлений (const с именем уже объявленной функции).
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
  c.document = el(); c.navigator = { userAgent: '' }; c.location = { hash: '', pathname: '/', search: '' };
  c.addEventListener = () => {}; c.matchMedia = () => ({ matches: false, addEventListener() {} });
  c.setTimeout = setTimeout; c.setInterval = () => 0; c.clearTimeout = clearTimeout; c.clearInterval = () => {};
  c.fetch = async () => ({ ok: true, text: async () => '' }); c.Chart = function () {}; c.confetti = () => {};
  const syntaxOrRedeclare = [];
  for (const f of srcs) {
    const code = fs.readFileSync(path.join(FRONT, f), 'utf8');
    try { vm.runInContext(code, c, { filename: f }); } catch (e) {
      if (e instanceof SyntaxError || (e.constructor && e.constructor.name === 'SyntaxError')) syntaxOrRedeclare.push(`${f}: ${e.message}`);
    }
  }
  assert.deepStrictEqual(syntaxOrRedeclare, []);
  for (const n of ['bcFormatForecast', 'bcOpenComposerWithList', 'bcSend']) assert.strictEqual(vm.runInContext(`typeof ${n}`, c), 'function', n);
});
