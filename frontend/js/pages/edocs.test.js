// «📄 Документы» (edocs-helpers.js + edocs.js): общая глобальная область, чистые помощники,
// разметка ↔ скрипт, паритет справочников с бэкендом.
// Запуск: node --test frontend/js/pages/edocs.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');
const BACK = path.join(__dirname, '..', '..', '..', 'backend');

function browserContext(extra = {}) {
  const ctx = vm.createContext({ console, URLSearchParams, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, ...extra });
  ctx.window = ctx;
  return ctx;
}
function run(ctx, file, src) { vm.runInContext(src !== undefined ? src : fs.readFileSync(file, 'utf8'), ctx, { filename: file }); }
const plain = (x) => JSON.parse(JSON.stringify(x));

const ctx = browserContext();
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js', 'js/pages/edocs.js']) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);

test('edocs-helpers.js и edocs.js грузятся в одну область с core', () => {
  for (const name of ['loadEdocs', 'edocsOnHashArg', 'edGo', 'edStopPolling', 'edRenderClientBlock', 'edDecorateRecords', 'edParseTail', 'edActTotals', 'edOpenMe']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена`);
  }
});

test('edParseTail: адреса страницы', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepStrictEqual(plain(k('edParseTail')('')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('settings')), { view: 'settings' });
  assert.deepStrictEqual(plain(k('edParseTail')('new')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52')), { view: 'new', clientId: 52, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52/30252')), { view: 'new', clientId: 52, recordId: 30252 });
  assert.deepStrictEqual(plain(k('edParseTail')('new/abc/1')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('p/' + id.toUpperCase())), { view: 'package', packageId: id });
  assert.deepStrictEqual(plain(k('edParseTail')('p/123')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('garbage')), { view: 'list' });
});

test('edMissingText', () => {
  assert.strictEqual(k('edMissingText')({ identity: [{ key: 'phone', label: 'Телефон' }, { key: 'passport_number', label: 'Номер паспорта' }], org: [{ key: 'inn', label: 'ИНН' }] }),
    'Не хватает данных пациента: Телефон, Номер паспорта. Не заполнены реквизиты клиники: ИНН');
  assert.strictEqual(k('edMissingText')({ identity: [], org: [] }), '');
  assert.strictEqual(k('edMissingText')(null), '');
});

test('edActTotals и edCollectActLines — как на сервере', () => {
  const rows = [
    { include: true, title: ' Чистка ', qty: '1', price: '17 500', sum: '15750', service_id: 5 },
    { include: false, title: 'Пилинг', qty: 1, price: 6000, sum: 6000 },
    { include: true, title: 'Ботокс', qty: '2', price: '8000,50', sum: 16001 },
  ];
  assert.deepStrictEqual(plain(k('edActTotals')(rows.filter((r) => r.include))), { total: 31751, discount: 1750 });
  assert.deepStrictEqual(plain(k('edCollectActLines')(rows)), { value: [
    { service_id: 5, title: 'Чистка', qty: 1, price: 17500, sum: 15750 },
    { service_id: null, title: 'Ботокс', qty: 2, price: 8000.5, sum: 16001 },
  ] });
  assert.match(k('edCollectActLines')([{ include: true, title: '', qty: 1, price: 1, sum: 1 }]).error, /Строка 1/);
  assert.match(k('edCollectActLines')([{ include: true, title: 'x', qty: 0, price: 1, sum: 1 }]).error, /количество/);
  assert.match(k('edCollectActLines')([{ include: false, title: 'x', qty: 1, price: 1, sum: 1 }]).error, /хотя бы одну/);
});

test('edIdentityBody собирает открытую и паспортную части', () => {
  const vals = { last_name: ' Иванова ', passport_series: '4510', address: 'Москва' };
  const body = plain(k('edIdentityBody')((key) => vals[key], 'recognize'));
  assert.strictEqual(body.last_name, 'Иванова');
  assert.strictEqual(body.secure.passport_series, '4510');
  assert.strictEqual(body.secure.address, 'Москва');
  assert.strictEqual(body.first_name, '');
  assert.strictEqual(body.source, 'recognize');
});

test('форматы: дата, деньги, телефон', () => {
  assert.strictEqual(k('edFmtDate')('2026-10-24'), '24.10.2026');
  assert.strictEqual(k('edFmtDate')(null), '—');
  assert.strictEqual(k('edPhone')('79001234567'), '+7 (900) 123-45-67');
  assert.match(k('edMoney')(12345.5), /^12\s345,50 ₽$/);
  assert.strictEqual(k('edStatusInfo')('signed').cls, 'bg');
  assert.strictEqual(k('edIsFinal')('annulled'), true);
  assert.strictEqual(k('edIsFinal')('sent'), false);
});

// ── все скрипты index.html одной областью ──
function indexScripts() {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (src) {
      if (/^https?:|^\/\//.test(src[1]) || src[1].startsWith('vendor/')) continue;
      out.push({ name: src[1].replace(/\?.*$/, ''), code: fs.readFileSync(path.join(FRONT, src[1].replace(/\?.*$/, '')), 'utf8') });
    } else if (m[2].trim()) out.push({ name: 'index.html (inline)', code: m[2] });
  }
  return out;
}

test('все скрипты index.html грузятся в одну область без SyntaxError; edocs подключён после помощников', () => {
  const scripts = indexScripts();
  const names = scripts.map((s) => s.name);
  assert.ok(names.indexOf('js/pages/edocs-helpers.js') >= 0 && names.indexOf('js/pages/edocs.js') > names.indexOf('js/pages/edocs-helpers.js'));
  const all = browserContext();
  const bad = [];
  for (const s of scripts) { try { run(all, s.name, s.code); } catch (e) { if (e && e.name === 'SyntaxError') bad.push(`${s.name}: ${e.message}`); } }
  assert.deepStrictEqual(bad, []);
});

test('id разметки: каждый getElementById edocs.js есть в index.html или рисуется скриптом', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, 'edocs.js'), 'utf8');
  const ids = new Set([...src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  // Есть в разметке index.html или написан литералом id="…" в самом скрипте (рисует скрипт).
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !src.includes(`id="${id}"`));
  assert.ok(ids.size >= 15, `getElementById не нашлись (${ids.size}) — регулярка устарела`);
  assert.deepStrictEqual(missing, []);
});

test('инлайн-обработчики edocs.js и разметки страницы ссылаются на существующие функции', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const from = html.indexOf('id="page-edocs"');
  const region = html.slice(from, html.indexOf('id="page-economics"', from)) + html.slice(html.indexOf('id="edMeModal"'), html.indexOf('id="notif"'));
  const script = fs.readFileSync(path.join(__dirname, 'edocs.js'), 'utf8');
  const re = /on(?:click|change|input)=\\?"(?:if\(event\.target===this\))?(?:event\.preventDefault\(\);)?([A-Za-z_]+)\(/g;
  const called = new Set([...region.matchAll(re), ...script.matchAll(re)].map((m) => m[1]));
  assert.ok(called.size >= 25, `обработчики не нашлись (${called.size}) — регулярка устарела`);
  const builtin = new Set(['closeModal', 'openModal']);
  const missing = [...called].filter((n) => !builtin.has(n) && typeof ctx[n] !== 'function');
  assert.deepStrictEqual(missing, []);
});

test('паритет справочников фронта с бэкендом', () => {
  const ph = require(path.join(BACK, 'services/edocs/placeholders.js'));
  const st = require(path.join(BACK, 'services/edocs/statuses.js'));
  const id = require(path.join(BACK, 'services/edocs/identity.js'));
  assert.deepStrictEqual(Object.keys(plain(k('ED_KIND_LABELS'))), ph.KINDS);
  assert.deepStrictEqual(plain(k('ED_ORG_FIELDS')).map((f) => f[0]), ph.ORG_KEYS);
  assert.deepStrictEqual(Object.keys(plain(k('ED_STATUS'))).sort(), [...st.STATUSES].sort());
  assert.deepStrictEqual(plain(k('ED_PLAIN_FIELDS')).map((f) => f[0]), id.PLAIN_KEYS);
  assert.deepStrictEqual(plain(k('ED_SECURE_FIELDS')).map((f) => f[0]).sort(), [...id.SECURE_KEYS].sort());
});
