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
const ED_FILES = ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js', 'js/pages/edocs.js', 'js/pages/edocs-board.js', 'js/pages/edocs-client.js'];
for (const f of ED_FILES) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);
const ED_PAGE_SRC = ['edocs.js', 'edocs-board.js', 'edocs-client.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

test('помощники, роутер, дашборд и страница пациента грузятся в одну область с core', () => {
  for (const name of ['loadEdocs', 'edocsOnHashArg', 'edGo', 'edStopPolling', 'edRenderClientBlock', 'edDecorateRecords', 'edParseTail', 'edTailOf', 'edActTotals', 'edOpenMe',
    'edbRender', 'edbRefresh', 'edcRender', 'edcRefresh', 'edFormOpen', 'edConfirm', 'edOpenAutomation', 'edFilterCards', 'edBoardChanges']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена`);
  }
});

test('edParseTail и edTailOf: адреса страницы, старые адреса мастера', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const t = (x) => plain(k('edParseTail')(x));
  assert.deepStrictEqual(t(''), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('r/week'), { view: 'board', range: 'week' });
  assert.deepStrictEqual(t('r/open'), { view: 'board', range: 'open' });
  assert.deepStrictEqual(t('r/all'), { view: 'board', range: 'all' });
  assert.deepStrictEqual(t('r/year'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('settings'), { view: 'settings' });
  assert.deepStrictEqual(t('packages'), { view: 'list' });
  assert.deepStrictEqual(t('c/52'), { view: 'client', clientId: 52, recordId: null });
  assert.deepStrictEqual(t('c/52/30252'), { view: 'client', clientId: 52, recordId: 30252 });
  assert.deepStrictEqual(t('c/abc'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('new'), { view: 'board', range: 'all' });
  assert.deepStrictEqual(t('new/52/30252'), { view: 'client', clientId: 52, recordId: 30252, legacy: true });
  assert.deepStrictEqual(t('p/' + id.toUpperCase()), { view: 'package', packageId: id });
  assert.deepStrictEqual(t('p/123'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('garbage'), { view: 'board', range: 'today' });
  for (const tail of ['', 'r/week', 'c/52', 'c/52/30252', 'packages', 'settings', 'p/' + id]) assert.strictEqual(k('edTailOf')(k('edParseTail')(tail)), tail);
});

test('дашборд: фильтр карточек, изменения между опросами, подписи дней, «Повторить» через 15 минут', () => {
  const cards = [
    { key: '1:d', name: 'Иванова Анна', phone: '+79200255591', color: 'red', tags: ['no_contract'], docs: { contract: { state: 'missing' }, consent_pd: { state: 'signed' }, act: { state: 'later' } } },
    { key: '2:d', name: 'Петрова Ольга', phone: '+79001112233', color: 'blue', tags: ['waiting'], docs: { contract: { state: 'pending' }, consent_pd: { state: 'pending' }, act: { state: 'later' } } },
  ];
  const f = (chip, color, q) => k('edFilterCards')(cards, chip, color, q).map((c) => c.key);
  assert.deepStrictEqual(f('', '', ''), ['1:d', '2:d']);
  assert.deepStrictEqual(f('waiting', '', ''), ['2:d']);
  assert.deepStrictEqual(f('', 'red', ''), ['1:d']);
  assert.deepStrictEqual(f('', '', 'петр'), ['2:d']);
  assert.deepStrictEqual(f('', '', '0255'), ['1:d']);
  const snap = k('edBoardSnapshot')(cards);
  assert.deepStrictEqual(plain(k('edBoardChanges')(null, cards)), []);
  const next = [cards[0], { ...cards[1], color: 'green', docs: { contract: { state: 'signed' }, consent_pd: { state: 'signed' }, act: { state: 'later' } } }];
  assert.deepStrictEqual(plain(k('edBoardChanges')(snap, next)), [{ key: '2:d', text: 'Петрова Ольга: подписаны договор, согласие пд' }]);
  assert.strictEqual(k('edDayLabel')('2026-10-25', '2026-10-25'), 'Сегодня');
  assert.strictEqual(k('edDayLabel')('2026-10-26', '2026-10-25'), 'Завтра');
  assert.strictEqual(k('edDayLabel')('2026-10-24', '2026-10-25'), 'Вчера');
  assert.strictEqual(k('edDayLabel')('2026-10-27', '2026-10-25'), 'вт, 27.10');
  assert.strictEqual(k('edRemindReady')({ availableAt: '2026-10-25T10:05:00Z' }, Date.parse('2026-10-25T10:04:00Z')), false);
  assert.strictEqual(k('edRemindReady')({ availableAt: '2026-10-25T10:05:00Z' }, Date.parse('2026-10-25T10:06:00Z')), true);
  assert.strictEqual(k('edRemindReady')(null), true);
  assert.deepStrictEqual([1, 2, 5, 11, 21, 22].map((n) => k('edPlural')(n, 'поле', 'поля', 'полей')), ['поле', 'поля', 'полей', 'полей', 'поле', 'поля']);
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
  for (const f of ['js/pages/edocs-board.js', 'js/pages/edocs-client.js']) assert.ok(names.indexOf(f) > names.indexOf('js/pages/edocs-helpers.js'), f + ' не подключён');
  const all = browserContext();
  const bad = [];
  for (const s of scripts) { try { run(all, s.name, s.code); } catch (e) { if (e && e.name === 'SyntaxError') bad.push(`${s.name}: ${e.message}`); } }
  assert.deepStrictEqual(bad, []);
});

test('id разметки: каждый getElementById страницы есть в index.html или рисуется скриптом', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const src = ED_PAGE_SRC;
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
  const script = ED_PAGE_SRC;
  const re = /on(?:click|change|input|toggle)=\\?"(?:if\(event\.target===this\))?(?:event\.(?:preventDefault|stopPropagation)\(\);)?([A-Za-z_]+)\(/g;
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
  // форма страницы пациента — ровно те же поля данных, что сохраняет сервер
  assert.deepStrictEqual(plain(k('EDC_FIELDS')).map((f) => f[0]).sort(), [...id.PLAIN_KEYS, ...id.SECURE_KEYS].sort());
  const board = require(path.join(BACK, 'services/edocs/board.js'));
  assert.deepStrictEqual(Object.keys(plain(k('ED_KIND_SHORT'))), board.KINDS);
});

// ── поведение страницы: заглушка DOM, location.hash, fetch и таймеры ──
// Элементы создаются по id при первом обращении; setInterval считается, а не запускается.
function pageContext({ fetch, confirm = () => true, hash = '#edocs' } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const cls = new Set();
      els.set(id, { id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false, checked: false, focus() {},
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
          toggle: (c, on) => ((on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c)) } });
    }
    return els.get(id);
  };
  const st = { hash, live: new Set(), timerSeq: 0, fetches: [], modals: [] };
  const ctx = browserContext({
    document: { getElementById: el, body: { dataset: {} }, querySelectorAll: () => [],
      createElement: () => ({ set textContent(v) { this.t = String(v); }, get innerHTML() { return this.t; } }) },
    location: { get hash() { return st.hash; }, set hash(v) { st.hash = String(v).startsWith('#') ? String(v) : '#' + v; } },
    history: { replaceState: (_a, _b, u) => { st.hash = u; } },
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; }, clearTimeout,
    setInterval: () => { st.live.add(++st.timerSeq); return st.timerSeq; },
    clearInterval: (id) => { st.live.delete(id); },
    fetch: (url, o) => { st.fetches.push(url); return fetch(url, o); },
    confirm: () => confirm(),
    openModal: (id) => st.modals.push(id), closeModal() {},
  });
  for (const f of ED_FILES) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
  return { st, el, run: (code) => vm.runInContext(code, ctx), k: (name) => vm.runInContext(name, ctx) };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 20));
const PID = '22222222-2222-4222-8222-222222222222';
const STATE = { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false, login: 'admin' } };
// Страница пациента с готовым ответом /page и выбранным договором (id 10). Окно подтверждения в тестах
// отвечает «да» само: edConfirm — обычная глобальная функция, её можно подменить в контексте.
const PAGE = { client: { id: 52, name: 'Тестова Анна', phone: '79001234567', initials: 'ТА' }, today: '2026-10-25',
  header: { color: 'red', label: 'Нужно до визита', day: '2026-10-25', time: '10:40', services: ['Чистка'], staffName: 'Врач', firstVisit: true,
    steps: [{ key: 'data', tone: 'ok' }, { key: 'contract', tone: 'no' }, { key: 'consent_pd', tone: 'ok' }, { key: 'act', tone: 'none' }] },
  data: { exists: true, complete: true, missing: [], required: ['last_name', 'first_name', 'phone'] },
  docs: { contract: { state: 'missing', tile: { text: 'нет', tone: 'no' } }, consent_pd: { state: 'signed', at: '2026-07-03T09:00:00Z', tile: { text: '✓ 03.07', tone: 'ok' } } },
  visits: [], focusRecordId: null, form: null, warnings: [], kinds: { contract: { id: 10, title: 'Договор' }, consent_pd: { id: 11, title: 'Согласие' }, act: null },
  numbering: { auto: true, contractNo: null, yclientsNo: null, next: 1999 }, actsRequiredFrom: '2026-10-01', module: { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false } },
  identity: { exists: true }, templates: [{ id: 10, kind: 'contract', title: 'Договор', placeholders: ['fio'] }, { id: 11, kind: 'consent_pd', title: 'Согласие', placeholders: ['fio'] }],
  packages: [], events: [] };
const CLIENT_PAGE = `edConfirm = async () => true; _ed.state = ${JSON.stringify({ enabled: true, configured: true, encReady: true, me: { connected: true, broken: false, login: 'admin' } })};
  _ed.route = { view: 'client', clientId: 52, recordId: null }; location.hash = '#edocs/c/52';
  _edc = { clientId: 52, recordId: null, page: ${JSON.stringify(PAGE)}, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
    selected: new Set([10]), act: null, actEdited: false, docDate: '', missingSel: { identity: [], org: [] }, checking: false };`;
const pageFetch = (handler) => async (url, o) => (/\/clients\/52\/page/.test(url) ? res(200, PAGE) : /packages\/check/.test(url) ? res(200, { missing: { identity: [], org: [] } }) : handler(url, o));

test('страница пациента: packageId вместе с ошибкой учётки — карточка комплекта, «Мой F.Doc» поверх, кнопка не включается', async () => {
  const p = pageContext({ fetch: pageFetch(async () => res(409, { error: 'F.Doc не принял логин или пароль — обновите их в «Мой F.Doc»', code: 'fdoc_credentials_invalid', packageId: PID })) });
  p.run(CLIENT_PAGE);
  await p.k('edcSend')();
  assert.strictEqual(p.st.hash, '#edocs/p/' + PID);
  assert.deepStrictEqual(p.st.modals, ['edMeModal']);
  assert.match(p.el('notif').textContent, /не принял логин или пароль/);
  assert.deepStrictEqual(p.st.fetches, ['/api/edocs/packages']);   // ни второй отправки, ни перечитывания
  assert.strictEqual(p.k('_ed').sending, false);
});

test('страница пациента: ответа нет (сеть, 502 прокси) — «комплект мог уйти», выбор не сбрасывается вслепую, страница перечитывается', async () => {
  const proxy502 = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  for (const send of [() => Promise.reject(new TypeError('Failed to fetch')), proxy502]) {
    const p = pageContext({ fetch: pageFetch(send) });
    p.run(CLIENT_PAGE);
    await p.k('edcSend')();
    await settle();
    assert.strictEqual(p.st.hash, '#edocs/c/52');
    assert.match(p.el('notif').textContent, /комплект мог уйти/);
    assert.strictEqual(p.st.fetches.filter((u) => u === '/api/edocs/packages').length, 1);
    assert.ok(p.st.fetches.some((u) => /\/clients\/52\/page/.test(u)), 'страница не перечитана');
  }
});

test('страница пациента: пока идёт отправка, выбор документа кнопку не включает; второй клик не шлёт второй комплект', async () => {
  let release;
  const p = pageContext({ fetch: pageFetch((url) => (url === '/api/edocs/packages'
    ? new Promise((r) => { release = () => r(res(400, { error: 'Шаблон не прошёл проверку' })); }) : Promise.resolve(res(200, {})))) });
  p.run(CLIENT_PAGE);
  const sending = p.k('edcSend')();
  await settle();
  assert.strictEqual(p.k('_ed').sending, true);
  p.k('edcToggle')(11);
  await settle();
  assert.match(p.el('edcSend').innerHTML, /id="edcSendBtn" onclick="edcSend\(\)" disabled>Отправляем…</);
  await p.k('edcSend')();   // второй клик во время отправки
  release();
  await sending;
  await settle();
  assert.strictEqual(p.k('_ed').sending, false);
  assert.strictEqual(p.st.fetches.filter((u) => u === '/api/edocs/packages').length, 1);
  assert.match(p.el('notif').textContent, /Шаблон не прошёл проверку/);
  assert.doesNotMatch(p.el('edcSend').innerHTML, /Отправляем…/);
});

test('страница пациента: тело отправки — выбранные шаблоны, дата документа; нехватка данных блокирует кнопку', async () => {
  let body;
  const p = pageContext({ fetch: pageFetch(async (url, o) => { body = JSON.parse(o.body); return res(200, { packageId: PID }); }) });
  p.run(CLIENT_PAGE + " _edc.docDate = '2026-10-24';");
  await p.k('edcSend')();
  assert.deepStrictEqual(body, { clientId: 52, templateIds: [10], docDate: '2026-10-24' });
  assert.match(p.el('notif').textContent, /отправлены пациенту/);
  p.run("_edc.missingSel = { identity: [{ key: 'passport_number', label: 'Номер паспорта' }], org: [] }; _edc.selected = new Set([10]); edcSendRender();");
  assert.match(p.el('edcSend').innerHTML, /Не хватает данных пациента: Номер паспорта/);
  assert.match(p.el('edcSend').innerHTML, /id="edcSendBtn" onclick="edcSend\(\)" disabled>/);
});

test('старый адрес мастера #edocs/new/52/30252 переписывается на страницу пациента', async () => {
  const p = pageContext({ hash: '#edocs/new/52/30252', fetch: async (url) => res(200, /state$/.test(url) ? STATE
    : /\/page/.test(url) ? { ...PAGE, focusRecordId: null } : {}) });
  p.run("edRoute('new/52/30252')");
  await settle();
  assert.strictEqual(p.st.hash, '#edocs/c/52/30252');
  assert.deepStrictEqual(plain(p.k('_ed').route), { view: 'client', clientId: 52, recordId: 30252 });
  assert.ok(p.st.fetches.some((u) => u === '/api/edocs/clients/52/page?record=30252'));
});

const BOARD = { now: '2026-10-25T07:00:00Z', today: '2026-10-25', range: 'today', rangeCounts: { today: 2, tomorrow: 0, week: 2, open: 0 },
  summary: { total: 2, red: 1, amber: 0, blue: 0, green: 1, grey: 0 }, chips: { all: 2, no_contract: 1, no_consent: 0, act: 0, waiting: 0, ready: 1 },
  cards: [
    { key: '52:2026-10-25', clientId: 52, name: 'Тестова Анна', initials: 'ТА', phone: '79001234567', day: '2026-10-25', time: '10:40', services: ['Чистка'], staffName: 'Врач',
      visits: [{ recordId: 100 }], color: 'red', label: 'Нужно до визита', tags: ['no_contract'], warnings: ['⏱ Первичный · через 40 мин'], hint: 'Данные полные',
      tiles: { contract: { text: 'нет', tone: 'no' }, consent_pd: { text: '✓ 03.07', tone: 'ok' }, act: { text: 'после визита', tone: 'na' } },
      docs: { contract: { state: 'missing' }, consent_pd: { state: 'signed' }, act: { state: 'later' } }, action: { type: 'send', kinds: ['contract'], recordId: null, label: 'Отправить договор' } },
    { key: '53:2026-10-25', clientId: 53, name: 'Петрова Ольга', initials: 'ПО', phone: null, day: '2026-10-25', time: '12:00', services: [], staffName: '',
      visits: [{ recordId: 101 }], color: 'green', label: 'Документы готовы', tags: ['ready'], warnings: [], hint: 'Акт — после визита',
      tiles: { contract: { text: '✓ 2025', tone: 'ok' }, consent_pd: { text: '✓ 2025', tone: 'ok' }, act: { text: 'после визита', tone: 'na' } },
      docs: { contract: { state: 'signed' }, consent_pd: { state: 'signed' }, act: { state: 'later' } }, action: null },
  ],
  kinds: { contract: { id: 10, title: 'Договор' }, consent_pd: { id: 11, title: 'Согласие' }, act: null },
  module: { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false } },
  automation: { previsit: { on: false, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: false, hours: 2 }, senderName: null },
  warnings: [{ code: 'no_template', kind: 'act' }], actsRequiredFrom: '2026-10-01' };

test('дашборд: карточки по группам, цвет, плитки, кнопка действия; без F.Doc — «Открыть»; один опрос', async () => {
  const p = pageContext({ fetch: async (url) => res(200, /state$/.test(url) ? STATE : /\/board/.test(url) ? BOARD : {}) });
  p.run("loadEdocs(); edocsOnHashArg(null)");
  await settle();
  assert.deepStrictEqual(p.st.fetches, ['/api/edocs/state', '/api/edocs/board?range=today']);
  assert.strictEqual(p.st.live.size, 1);
  const html = p.el('edbCards').innerHTML;
  assert.match(html, /Требуют действия · 1[\s\S]*Готово · 1/);
  assert.match(html, /class="edb-card ed-c-red"/);
  assert.match(html, /<div class="edb-doc no"><b>Договор<\/b>нет<\/div>/);
  assert.match(html, /edbAct\('52:2026-10-25'\)">Отправить договор</);
  assert.match(p.el('edbWarns').innerHTML, /Не загружен шаблон «Акт оказанных услуг»/);
  assert.match(p.el('edbHead').innerHTML, /<span>1\/2<\/span>/);
  p.run("_ed.state = Object.assign({}, _ed.state, { me: { connected: false } }); edbCardsRender([])");
  assert.match(p.el('edbCards').innerHTML, />Открыть</);
  p.run("edbSetChip('ready')");
  assert.doesNotMatch(p.el('edbCards').innerHTML, /Тестова/);
  p.run('edStopPolling()');
  assert.strictEqual(p.st.live.size, 0);
});

test('дашборд: «Отправить договор» — подтверждение, тело запроса по шаблону вида, перечитывание', async () => {
  let body;
  const p = pageContext({ fetch: async (url, o) => {
    if (/state$/.test(url)) return res(200, STATE);
    if (/\/board/.test(url)) return res(200, BOARD);
    if (url === '/api/edocs/packages') { body = JSON.parse(o.body); return res(200, { packageId: PID }); }
    return res(200, {});
  } });
  p.run("loadEdocs()");
  await settle();
  p.run('edConfirm = async () => true');
  await p.k('edbAct')('52:2026-10-25');
  await settle();
  assert.deepStrictEqual(body, { clientId: 52, templateIds: [10], recordId: null });
  assert.strictEqual(p.st.fetches.filter((u) => /\/board/.test(u)).length, 2);
});

test('двойная загрузка: меню (loadEdocs + hashchange тем же хвостом) и «Назад» до конца загрузки — один опрос', async () => {
  const fetch = async (url) => res(200, /state$/.test(url) ? STATE : /\/board/.test(url) ? BOARD
    : url.includes('/packages/') ? { id: PID, title: 'Документы', status: 'sent', documents: [], events: [] } : { rows: [] });
  const p = pageContext({ fetch });
  p.run('loadEdocs(); edocsOnHashArg(null)');
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  p.run(`edocsOnHashArg('p/${PID}'); edocsOnHashArg(null)`);   // карточка, и сразу «Назад» к дашборду
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  assert.strictEqual(p.k('_ed').route.view, 'board');
  p.run("edRoute(''); edRoute('')");
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  p.run("edGo('packages'); edocsOnHashArg('packages')");   // в браузере вторую половину делает hashchange
  await settle();
  assert.strictEqual(p.k('_ed').route.view, 'list');
  assert.strictEqual(p.st.live.size, 1);
  p.run('edStopPolling()');   // уход со страницы, выход
  assert.strictEqual(p.st.live.size, 0);
});

test('«Отправить ссылку ещё раз»: без подтверждения запроса нет; на время запроса кнопка заблокирована', async () => {
  let answer = false;
  let release;
  const p = pageContext({ confirm: () => answer, fetch: (url) => (url.endsWith('/permalink')
    ? new Promise((r) => { release = () => r(res(200, { ok: true })); })
    : Promise.resolve(res(200, { id: PID, title: 'Документы', status: 'sent', documents: [], events: [] }))) });
  const btn = { disabled: false };
  await p.k('edPkgAction')(PID, 'permalink', btn);
  assert.deepStrictEqual(p.st.fetches, []);
  answer = true;
  const first = p.k('edPkgAction')(PID, 'permalink', btn);
  await settle();
  assert.strictEqual(btn.disabled, true);
  await p.k('edPkgAction')(PID, 'permalink', btn);   // повторный клик, пока идёт запрос
  release();
  await first;
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(p.st.fetches.filter((u) => u.endsWith('/permalink')).length, 1);
});
test('встройки: карточка клиента и «Записи» зовут хуки «Документов», колонка «Акт» в таблице записей', () => {
  const clients = fs.readFileSync(path.join(__dirname, 'clients.js'), 'utf8');
  const records = fs.readFileSync(path.join(__dirname, 'records.js'), 'utf8');
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  assert.match(clients, /<div id="edClientBlock_\$\{c\.id\}"><\/div>/);
  assert.match(clients, /typeof edRenderClientBlock === 'function'\) edRenderClientBlock\(c\.id\)/);
  assert.match(records, /class="r-act" data-rid="\$\{r\.id\}" data-cid="\$\{r\.client_id \|\| ''\}"/);
  assert.match(records, /typeof edDecorateRecords === 'function'\) edDecorateRecords\(d\.records\)/);
  assert.doesNotMatch(records, /colspan="9"/);
  assert.match(html, /<th>Статус<\/th><th>Источник<\/th><th><\/th><\/tr><\/thead>/);
  assert.match(html, /<td colspan="10" class="empty">Выберите период<\/td>/);
});
