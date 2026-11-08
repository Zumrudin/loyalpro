// Монитор рассылки через мессенджеры: чистые помощники + загрузка всех скриптов index.html в ОДНУ область.
// Запуск: node --test frontend/js/pages/broadcasts-monitor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');
function browserContext() {
  const ctx = vm.createContext({ console, URLSearchParams, Intl, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  ctx.window = ctx;
  return ctx;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const ctx = browserContext();
vm.runInContext(fs.readFileSync(path.join(FRONT, 'js/pages/broadcasts-monitor.js'), 'utf8'), ctx, { filename: 'broadcasts-monitor.js' });
const call = (fn, ...a) => { ctx.__a = a; return plain(vm.runInContext(`${fn}(...__a)`, ctx)); };

const live = { status: 'in_progress', paused: false, pauseReason: null, cancelRequested: false, inWindow: true };

test('bcMonState: статусы шапки и доступные кнопки', () => {
  let s = call('bcMonState', live);
  assert.strictEqual(s.text, 'Идёт'); assert.ok(s.canPause && !s.canResume && s.canCancel && !s.done);
  s = call('bcMonState', { ...live, inWindow: false });
  assert.strictEqual(s.text, 'Ночная пауза до 09:00'); assert.ok(s.canCancel);
  s = call('bcMonState', { ...live, paused: true, pauseReason: 'gateway_unreachable' });
  assert.strictEqual(s.text, 'Пауза: шлюз недоступен'); assert.ok(s.canResume && !s.canPause);
  s = call('bcMonState', { ...live, paused: true, pauseReason: 'manual', inWindow: false });
  assert.strictEqual(s.text, 'Пауза'); // ручная пауза главнее ночной
  s = call('bcMonState', { ...live, cancelRequested: true });
  assert.match(s.text, /Отменяется/); assert.ok(!s.canCancel);
  s = call('bcMonState', { ...live, status: 'completed' });
  assert.strictEqual(s.text, 'Завершена'); assert.ok(s.done && !s.canPause && !s.canCancel && !s.canResume);
  assert.strictEqual(call('bcMonState', { ...live, status: 'cancelled' }).text, 'Отменена');
  assert.strictEqual(call('bcMonState', { ...live, status: 'pending' }).text, 'В очереди');
  assert.strictEqual(call('bcMonState', null).text, '…');
});

test('bcChannelLabel: состояния мессенджера и обратный отсчёт', () => {
  const now = Date.UTC(2026, 10, 2, 11, 0, 0);   // 14:00:00 МСК
  assert.strictEqual(call('bcChannelLabel', { state: 'free' }, now), '🟢 отправляет');
  assert.strictEqual(call('bcChannelLabel', { state: 'disabled' }, now), '⚪ выключен');
  assert.strictEqual(call('bcChannelLabel', { state: 'limit', sent: 50, limit: 50 }, now), '🔴 лимит 50/50');
  assert.strictEqual(call('bcChannelLabel', { state: 'paused', pausedUntil: now + 72000 }, now), '⏸ пауза до 14:01:12 · ещё 1:12');
  assert.strictEqual(call('bcChannelLabel', { state: 'paused', pausedUntil: now + 5000 }, now), '⏸ пауза до 14:00:05 · ещё 0:05');
  assert.strictEqual(call('bcChannelLabel', { state: 'paused', pausedUntil: now - 1 }, now), '🟢 отправляет');
  assert.strictEqual(call('bcChannelLabel', { state: 'paused', pausedUntil: null }, now), '⏸ пауза');
});

test('bcStatusText: статусы получателя и причины по-русски', () => {
  const t = (r) => call('bcStatusText', r);
  assert.strictEqual(t({ status: 'pending' }), 'ждёт');
  assert.strictEqual(t({ status: 'sending' }), 'отправляется');
  assert.strictEqual(t({ status: 'sent', delivery_status: 'accepted' }), 'отправлено');
  assert.strictEqual(t({ status: 'sent', delivery_status: 'delivered' }), 'доставлено');
  assert.strictEqual(t({ status: 'sent', delivery_status: 'undeliverable' }), 'не доставлено');
  // причина отказа от мессенджера (Chatpush 55/58) — с маленькой буквы после двоеточия
  assert.strictEqual(t({ status: 'sent', delivery_status: 'undeliverable', error: 'Клиент не зарегистрирован в MAX' }), 'не доставлено: клиент не зарегистрирован в MAX');
  assert.strictEqual(t({ status: 'sent', delivery_status: 'delivered', error: 'старое' }), 'доставлено');
  assert.strictEqual(t({ status: 'sent', delivery_status: 'unknown' }), 'отправлено, доставка неизвестна');
  assert.strictEqual(t({ status: 'cancelled' }), 'отменено');
  assert.strictEqual(t({ status: 'skipped', reason: 'limit' }), 'пропущен: лимит мессенджера');
  assert.strictEqual(t({ status: 'skipped', reason: 'no_recipient' }), 'пропущен: нет адресата');
  assert.strictEqual(t({ status: 'failed', reason: 'ambiguous_failure' }), 'мессенджер не подтвердил — могло уйти');
  assert.strictEqual(t({ status: 'failed', reason: 'all_rejected' }), 'все мессенджеры отказали');
  assert.strictEqual(t({ status: 'skipped', reason: 'zzz_internal' }), 'пропущен');
  assert.strictEqual(t({ status: 'failed', reason: 'zzz_internal' }), 'ошибка');
});

test('bcCascadePath: путь по мессенджерам', () => {
  assert.strictEqual(call('bcCascadePath', [
    { at: 1, from: 'tdlib', to: 'whatsapp', why: 'rejected' }, { at: 2, channel: 'whatsapp', ok: true },
  ]), 'Telegram: отказ → WhatsApp');
  assert.strictEqual(call('bcCascadePath', [
    { at: 1, channel: 'tdlib', ok: false, why: 'unreachable', error: 'x' },
  ]), 'Telegram: шлюз недоступен');
  assert.strictEqual(call('bcCascadePath', [
    { at: 1, channel: 'tdlib', ok: false, why: 'ambiguous', error: 'x' },
    { at: 2, channel: 'whatsapp', skipped: 'limit' },
  ]), 'Telegram: неизвестно · WhatsApp: лимит');
  assert.strictEqual(call('bcCascadePath', [{ at: 1, from: 'max', to: 'tdlib', why: 'limit' }]), 'MAX: лимит → Telegram');
  assert.strictEqual(call('bcCascadePath', [
    { at: 1, channel: 'tdlib', ok: true }, { at: 2, from: 'tdlib', to: 'whatsapp', why: 'not_registered', error: 'Пользователь не найден в Telegram' },
  ]), 'Telegram: нет в мессенджере → WhatsApp');
  assert.strictEqual(call('bcCascadePath', [{ at: 1, channel: 'max', ok: true }]), '');
  assert.strictEqual(call('bcCascadePath', null), '');
});

test('bcChannelSummary: числа карточки сходятся, «неизвестно» и «проверяется» видны', () => {
  // рассылка №3 до правки: ушло 30, доставлено 22, а 8 «доставка неизвестна» не показывались вовсе
  let s = call('bcChannelSummary', { sent: 30, byStatus: { sent: 30 }, byDelivery: { delivered: 22, unknown: 8 }, advancedFrom: 51, advancedBy: { limit: 51 } });
  assert.strictEqual(s.line, 'ушло 30 · доставлено 22 · не доставлено 0 · доставка неизвестна 8 · ждут 0 · отказ 0');
  assert.strictEqual(s.adv, 'перешли дальше по каскаду: 51 (лимит)');
  s = call('bcChannelSummary', {
    sent: 30, byStatus: { sent: 28, pending: 1, failed: 1 }, byDelivery: { delivered: 26, accepted: 2 },
    advancedFrom: 51, advancedBy: { not_registered: 2, limit: 49 },
  });
  assert.strictEqual(s.line, 'ушло 30 · доставлено 26 · не доставлено 0 · проверяется 2 · ждут 1 · отказ 1');
  assert.strictEqual(s.adv, 'перешли дальше по каскаду: 51 (лимит 49 · нет в мессенджере 2)');
  s = call('bcChannelSummary', { sent: 0 });
  assert.strictEqual(s.line, 'ушло 0 · доставлено 0 · не доставлено 0 · ждут 0 · отказ 0');
  assert.strictEqual(s.adv, '');
  assert.strictEqual(call('bcChannelSummary', { advancedFrom: 3, advancedBy: { zzz: 3 } }).adv, 'перешли дальше по каскаду: 3 (другое)');
  assert.strictEqual(call('bcChannelSummary', { advancedFrom: 2 }).adv, 'перешли дальше по каскаду: 2'); // старый сервер без advancedBy
});

test('bcMonLost: «не получили» включает и не доставленных после приёма', () => {
  assert.strictEqual(call('bcMonLost', { byStatus: { skipped: 8, sent: 90 }, byDelivery: { undeliverable: 11, unknown: 2 } }), 19);
  assert.strictEqual(call('bcMonLost', { byStatus: { failed: 1, cancelled: 2 } }), 3);
  assert.strictEqual(call('bcMonLost', {}), 0);
  assert.strictEqual(call('bcMonLost', null), 0);
});

test('все <script src> index.html грузятся в ОДНУ область без ошибок', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(js\/[^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]);
  assert.ok(srcs.includes('js/pages/broadcasts-monitor.js'), 'broadcasts-monitor.js не подключён в index.html');
  const c = browserContext();
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
  c.document = el(); c.navigator = { userAgent: '' }; c.location = { hash: '', pathname: '/', search: '' };
  c.addEventListener = () => {}; c.matchMedia = () => ({ matches: false, addEventListener() {} });
  c.setTimeout = setTimeout; c.setInterval = () => 0; c.clearTimeout = clearTimeout; c.clearInterval = () => {};
  c.fetch = async () => ({ ok: true, text: async () => '' }); c.Chart = function () {}; c.confetti = () => {};
  const bad = [];
  for (const f of srcs) {
    const code = fs.readFileSync(path.join(FRONT, f), 'utf8');
    try { vm.runInContext(code, c, { filename: f }); } catch (e) {
      if (e instanceof SyntaxError || (e.constructor && e.constructor.name === 'SyntaxError')) bad.push(`${f}: ${e.message}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  for (const n of ['bcMonState', 'bcOpenMonitor', 'bcCloseMonitor', 'bcStopMonitor', 'bcOpenComposerWithList']) assert.strictEqual(vm.runInContext(`typeof ${n}`, c), 'function', n);
});
