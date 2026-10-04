// frontend/js/pages/dashboard-messengers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { msgPct, msgChannelRows, MSG_VERDICT_COLS, msgTableColumns, msgTileTexts, MSG_CHANNEL_BADGE } = require('./dashboard-messengers');

test('msgPct: округлённый процент, при нулевом знаменателе — прочерк', () => {
  assert.strictEqual(msgPct(81, 201), '40%');
  assert.strictEqual(msgPct(0, 10), '0%');
  assert.strictEqual(msgPct(5, 0), '—');
  assert.strictEqual(msgPct(undefined, undefined), '—');
});

test('msgChannelRows: строка на канал + итоговая, бейдж, конверсия и вердикты', () => {
  const v = { booked: 10, declined: 3, pending: 5, reschedule: 1, question: 2, broadcast_reply: 4, no_dialog: 6, other: 1, unanalyzed: 350 };
  const byChannel = [
    { channel: 'tdlib', label: 'Telegram', dialogs: 382, clientFirst: 201, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30, verdicts: v },
    { channel: 'max_bot', label: 'max_bot', dialogs: 3, clientFirst: 1, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 },
  ];
  const totals = { dialogs: 385, clientFirst: 202, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30, verdicts: v };
  const rows = msgChannelRows(byChannel, totals);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { label: 'Telegram', short: 'TG', cls: 'ch-tg', channel: 'tdlib', dialogs: 382, clientFirst: 201, bookedSameDay: 81, conv: '40%', convPct: 40, isTotal: false, verdicts: v });
  // незнакомый канал — бейдж из первых двух букв, нейтральный класс; без verdicts — нули
  assert.strictEqual(rows[1].short, 'MA');
  assert.strictEqual(rows[1].cls, 'ch-all');
  assert.strictEqual(rows[1].conv, '0%');
  assert.deepStrictEqual(rows[1].verdicts, { booked: 0, declined: 0, pending: 0, reschedule: 0, question: 0, broadcast_reply: 0, no_dialog: 0, other: 0, unanalyzed: 0 });
  assert.strictEqual(rows[2].isTotal, true);
  assert.strictEqual(rows[2].channel, '');
  assert.strictEqual(rows[2].conv, '40%');
});

test('MSG_VERDICT_COLS совпадает с таксономией бэкенда (плюс unanalyzed последним)', () => {
  const { STATUS_CODES, UNANALYZED } = require('../../../backend/services/dialog-verdicts/taxonomy');
  assert.deepStrictEqual(MSG_VERDICT_COLS.map(c => c.code), [...STATUS_CODES, UNANALYZED]);
  for (const c of MSG_VERDICT_COLS) { assert.ok(c.short); assert.ok(c.title); }
});

test('msgTableColumns: четыре колонки факта, затем статусы', () => {
  const cols = msgTableColumns();
  assert.deepStrictEqual(cols.slice(0, 5).map(c => c.key), ['label', 'dialogs', 'clientFirst', 'bookedSameDay', 'conv']);
  assert.strictEqual(cols.length, 5 + MSG_VERDICT_COLS.length);
  assert.strictEqual(cols[5].key, 'v:booked');
});

test('msgChannelRows: без каналов — только итог с нулями', () => {
  const rows = msgChannelRows([], { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isTotal, true);
  assert.strictEqual(rows[0].conv, '—');
  assert.strictEqual(rows[0].convPct, 0);
});


test('msgTileTexts: подписи трёх плиток', () => {
  const t = msgTileTexts({ dialogs: 716, clientFirst: 386, clientFirstNoPhone: 30, bookedSameDay: 154, bookedByAgent: 61 });
  assert.strictEqual(t.firstShare, '54% диалогов');
  assert.strictEqual(t.firstSub, '30 из них без номера телефона');
  assert.strictEqual(t.bookedPct, '40%');
  assert.strictEqual(t.bookedSub, 'из написавших первыми · 61 оформила Мила');
});

test('msgTileTexts: нули и отсутствие Милы/без номера', () => {
  const t = msgTileTexts({ dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
  assert.strictEqual(t.firstShare, '');
  assert.strictEqual(t.firstSub, 'все с номером телефона');
  assert.strictEqual(t.bookedPct, '');
  assert.strictEqual(t.bookedSub, 'из написавших первыми');
});

// Устойчивость к пустому ответу ручки и к имени канала из прототипа Object:
// бейдж берётся только у СОБСТВЕННЫХ свойств карты (hasOwnProperty.call, а не `in`).
test('null-входы не роняют помощники; канал «constructor» не достаёт бейдж из прототипа', () => {
  const rows = msgChannelRows(null, null);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isTotal, true);
  assert.deepStrictEqual(msgTileTexts(null), { firstShare: '', firstSub: 'все с номером телефона', bookedPct: '', bookedSub: 'из написавших первыми' });
  const ctor = msgChannelRows([{ channel: 'constructor', dialogs: 1, clientFirst: 1, bookedSameDay: 0 }], {})[0];
  assert.strictEqual(ctor.short, 'CO');
  assert.strictEqual(ctor.cls, 'ch-all');
});

test('бейджи известных каналов', () => {
  assert.deepStrictEqual(MSG_CHANNEL_BADGE.whatsapp, { short: 'WA', cls: 'ch-wa' });
  assert.deepStrictEqual(MSG_CHANNEL_BADGE.max, { short: 'M', cls: 'ch-max' });
});

// Файл делит глобальную область со всеми страничными скриптами: верхнеуровневое
// имя, занятое в dashboard.js, — синтаксическая ошибка, гасящая ВЕСЬ файл
// (класс дефекта chat-wait-status.js). Грузим оба файла в один vm-контекст, как браузер.
test('dashboard.js и dashboard-messengers.js живут в одной глобальной области', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  for (const f of ['dashboard.js', 'dashboard-messengers.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: f }),
      `${f} не загрузился в общей области — проверь редекларацию имён`);
  }
  assert.strictEqual(typeof ctx.loadMessengerStats, 'function');
  assert.strictEqual(typeof ctx.renderMessengerStats, 'function');
  assert.strictEqual(typeof ctx.loadDashboard, 'function');
  assert.strictEqual(ctx.msgPct(1, 4), '25%');
});

// Ошибка ручки (400 «период не больше 731 дней») доходит до подписи плитки
// текстом, а не глотается в «нет данных»; без причины — прежняя заглушка.
test('loadMessengerStats: текст ошибки ручки попадает в подпись плитки через textContent', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const els = {};
  const el = id => (els[id] ||= { textContent: '', innerHTML: '' });
  const ctx = vm.createContext({
    console: { warn() {} },
    document: { getElementById: el, documentElement: { getAttribute: () => null } },
    esc: s => String(s),
    animateCount() {},
    api: async () => { throw new Error('период не больше 731 дней'); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dashboard-messengers.js'), 'utf8'), ctx);
  await ctx.loadMessengerStats('?from=2020-01-01&to=2026-10-03', 'x');
  assert.strictEqual(el('msgDialogsSub').textContent, 'период не больше 731 дней');
  assert.strictEqual(el('msgDialogs').textContent, '—');
  ctx.clearMessengerStats();
  assert.strictEqual(el('msgDialogsSub').textContent, 'нет данных за период');
});
