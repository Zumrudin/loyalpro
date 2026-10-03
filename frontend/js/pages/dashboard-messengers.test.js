// frontend/js/pages/dashboard-messengers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { msgPct, msgChannelRows, msgChartSeries, msgTileTexts, MSG_CHANNEL_BADGE } = require('./dashboard-messengers');

test('msgPct: округлённый процент, при нулевом знаменателе — прочерк', () => {
  assert.strictEqual(msgPct(81, 201), '40%');
  assert.strictEqual(msgPct(0, 10), '0%');
  assert.strictEqual(msgPct(5, 0), '—');
  assert.strictEqual(msgPct(undefined, undefined), '—');
});

test('msgChannelRows: строка на канал + итоговая, бейдж и конверсия', () => {
  const byChannel = [
    { channel: 'tdlib', label: 'Telegram', dialogs: 382, clientFirst: 201, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30 },
    { channel: 'max_bot', label: 'max_bot', dialogs: 3, clientFirst: 1, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 },
  ];
  const totals = { dialogs: 385, clientFirst: 202, clientFirstNoPhone: 27, bookedSameDay: 81, bookedByAgent: 30 };
  const rows = msgChannelRows(byChannel, totals);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], { label: 'Telegram', short: 'TG', cls: 'ch-tg', dialogs: 382, clientFirst: 201, bookedSameDay: 81, conv: '40%', convPct: 40, isTotal: false });
  // незнакомый канал — бейдж из первых двух букв, нейтральный класс
  assert.strictEqual(rows[1].short, 'MA');
  assert.strictEqual(rows[1].cls, 'ch-all');
  assert.strictEqual(rows[1].conv, '0%');
  assert.deepStrictEqual(rows[2], { label: 'Все каналы', short: 'Σ', cls: 'ch-all', dialogs: 385, clientFirst: 202, bookedSameDay: 81, conv: '40%', convPct: 40, isTotal: true });
});

test('msgChannelRows: без каналов — только итог с нулями', () => {
  const rows = msgChannelRows([], { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].isTotal, true);
  assert.strictEqual(rows[0].conv, '—');
  assert.strictEqual(rows[0].convPct, 0);
});

test('msgChartSeries: подписи d.m и два ряда чисел', () => {
  const s = msgChartSeries([
    { date: '2026-09-04', clientFirst: 12, bookedSameDay: 5 },
    { date: '2026-10-01', clientFirst: '3', bookedSameDay: '1' },
  ]);
  assert.deepStrictEqual(s, { labels: ['4.9', '1.10'], first: [12, 3], booked: [5, 1] });
  assert.deepStrictEqual(msgChartSeries([]), { labels: [], first: [], booked: [] });
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
  assert.deepStrictEqual(msgChartSeries(null), { labels: [], first: [], booked: [] });
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
