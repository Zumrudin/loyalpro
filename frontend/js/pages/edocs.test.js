// «📄 Документы»: чистые помощники edocs-helpers.js и паритет справочников с бэкендом.
// (Задача 14 плана заменит файл итоговой версией с проверками страницы и разметки.)
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
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js']) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);

test('edocs-helpers.js грузится в одну область с core', () => {
  for (const name of ['edParseTail', 'edActTotals', 'edCollectActLines', 'edIdentityBody', 'edMissingText', 'edStatusInfo']) {
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
