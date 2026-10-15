// Вкладка «Автоуведомления» (notifications.js): глобальная область + чистые помощники + паритет с бэкендом.
// Запуск: node --test frontend/js/pages/notifications.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');            // frontend/
const BACK = path.join(__dirname, '..', '..', '..', 'backend');

// Контекст как у браузера: window — это сам глобальный объект; localStorage нужен api.js на верхнем уровне.
function browserContext(extra = {}) {
  const ctx = vm.createContext({
    console, URLSearchParams,                  // браузерные глобали, которыми пользуются помощники
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    ...extra,
  });
  ctx.window = ctx;
  return ctx;
}
function run(ctx, file, src) {
  vm.runInContext(src !== undefined ? src : fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
// Объекты из vm-контекста — из другой «реальности» (чужие Object/Array.prototype): deepStrictEqual их не сравнит.
const plain = (x) => JSON.parse(JSON.stringify(x));

// Страница как в браузере: те же файлы в том же порядке в одном контексте.
function loadPage(extra) {
  const c = browserContext(extra);
  for (const f of ['core/utils.js', 'core/api.js', 'js/pages/conditions-editor.js', 'js/pages/broadcasts.js', 'js/pages/notifications.js']) {
    run(c, f, fs.readFileSync(path.join(FRONT, f.startsWith('core/') ? `js/${f}` : f), 'utf8'));
  }
  return c;
}

// Один контекст на все чистые помощники (документа в нём нет).
const ctx = loadPage();
const k = (name) => vm.runInContext(name, ctx);            // const верхнего уровня не попадает в свойства контекста

// ── глобальная область ────────────────────────────────────────────────────────────────────────

test('conditions-editor, broadcasts и notifications грузятся в ОДНУ область подряд, как в браузере', () => {
  // Верхнеуровневый const с именем уже объявленной функции — SyntaxError на весь файл (так чат терял список
  // диалогов, 12.08.2026). Обычный require этого не ловит: он грузит модуль в своей области.
  for (const name of ['ntLoad', 'ntSub', 'bcSwitchTab', 'condRender', 'condGet', 'condInit', 'condSet', 'bcOpenComposer']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена — файл не загрузился`);
  }
  assert.ok(Array.isArray(plain(k('NT_TYPE_ORDER'))));
});

// Все <script> index.html в порядке подключения — одним контекстом. SyntaxError любого файла (редекларация имени,
// опечатка) — провал; прочие исключения (скрипты трогают document, которого в vm нет) к области не относятся:
// конфликт имён ловится ДО выполнения первого оператора скрипта.
function indexScripts() {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (src) {
      if (/^https?:|^\/\//.test(src[1]) || src[1].startsWith('vendor/')) continue;       // библиотеки — не наши имена
      out.push({ name: src[1].replace(/\?.*$/, ''), code: fs.readFileSync(path.join(FRONT, src[1].replace(/\?.*$/, '')), 'utf8') });
    } else if (m[2].trim()) {
      out.push({ name: 'index.html (inline)', code: m[2] });
    }
  }
  return out;
}

test('все скрипты index.html грузятся в одну область без SyntaxError', () => {
  const scripts = indexScripts();
  assert.ok(scripts.length > 30, 'список скриптов index.html не разобрался');
  assert.ok(scripts.some((s) => s.name === 'js/pages/notifications.js'), 'notifications.js не подключён в index.html');
  const all = browserContext();
  const bad = [];
  for (const s of scripts) {
    try { run(all, s.name, s.code); } catch (e) { if (e && e.name === 'SyntaxError') bad.push(`${s.name}: ${e.message}`); }
  }
  assert.deepStrictEqual(bad, []);
});

test('проверка области действительно ловит редекларацию (тест теста)', () => {
  const c = browserContext();
  run(c, 'a.js', 'function esc(s) { return s; }');
  assert.throws(() => run(c, 'b.js', 'const esc = 1;'), (e) => e.name === 'SyntaxError' && /already been declared/.test(e.message));
});

test('conditions-editor.js подключён РАНЬШЕ всех потребителей, broadcast-rules.js снят', () => {
  const names = indexScripts().map((s) => s.name);
  const at = (n) => names.indexOf(`js/pages/${n}`);
  assert.ok(at('conditions-editor.js') >= 0);
  for (const user of ['notifications.js', 'care.js', 'reminders.js']) {
    assert.ok(at(user) > at('conditions-editor.js'), `${user} должен стоять после conditions-editor.js`);
  }
  assert.strictEqual(at('broadcast-rules.js'), -1, 'v1-скрипт не должен быть подключён: он объявляет тот же bcSwitchTab');
});

// ── разметка ↔ скрипт ─────────────────────────────────────────────────────────────────────────

test('id разметки: каждый getElementById скрипта и каждый ns-контейнер редактора условий есть в index.html', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, 'notifications.js'), 'utf8');
  const ids = new Set([...src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  ids.add('ntfConds'); ids.add('ntfLogicWrap'); ids.add('ntfLogic-and'); ids.add('ntfLogic-or');   // condRender('ntf')
  // Поля типа (#ntHours, #ntDelay, #ntAsk, #ntNoShow, #ntFile, кнопки каскада) рисует сам скрипт — они не из разметки.
  const dynamic = new Set(['ntHours', 'ntDelay', 'ntAsk', 'ntNoShow', 'ntFile']);
  const missing = [...ids].filter((id) => !dynamic.has(id) && !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, []);
});

test('инлайн-обработчики (в разметке и в строках скрипта) ссылаются на существующие функции', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const from = html.indexOf('id="bcTab-rules"');
  const region = html.slice(from, html.indexOf('CARE PAGE («Забота»', from));   // вкладка + три модалки (HOME CARE PAGE выше — не тот маркер)
  const script = fs.readFileSync(path.join(__dirname, 'notifications.js'), 'utf8');
  const re = /on(?:click|change|input)="(?:if\(event\.target===this\))?([A-Za-z_]+)\(/g;
  const called = new Set([...region.matchAll(re), ...script.matchAll(re)].map((m) => m[1]));
  assert.ok(called.size >= 20, 'обработчики не нашлись — регулярка устарела');
  for (const fn of called) assert.strictEqual(typeof ctx[fn], 'function', `в разметке вызывается ${fn}(), а функции нет`);
});

// ── паритет с бэкендом ────────────────────────────────────────────────────────────────────────

test('типы и статусы совпадают с routes/notification-rules.js', () => {
  const route = fs.readFileSync(path.join(BACK, 'routes', 'notification-rules.js'), 'utf8');
  const list = (name) => [...new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(route)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(plain(k('NT_TYPE_ORDER')), list('TRIGGER_TYPES'));
  assert.deepStrictEqual(Object.keys(plain(k('NT_TYPES'))).sort(), list('TRIGGER_TYPES').sort());
  assert.deepStrictEqual(Object.keys(plain(k('NT_ST'))).sort(), list('JOB_STATUSES').sort());
});

test('мессенджеры каскада — ровно CASCADE_CHANNELS бэкенда', () => {
  const { CASCADE_CHANNELS } = require(path.join(BACK, 'services', 'notifications', 'cascade'));
  assert.deepStrictEqual(Object.keys(plain(k('NT_CH'))).sort(), [...CASCADE_CHANNELS].sort());
});

test('каждый исход шага каскада, который пишет worker.js, имеет подпись', () => {
  const worker = fs.readFileSync(path.join(BACK, 'services', 'notifications', 'worker.js'), 'utf8');
  const codes = new Set([...worker.matchAll(/\bstep\(\s*[^,()]+,\s*'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 5, 'не нашли вызовы step() в worker.js — регулярка устарела');
  const labels = plain(k('NT_STEP'));
  for (const c of codes) assert.ok(labels[c], `у исхода «${c}» нет подписи в NT_STEP`);
});

test('каждая подстановка из NT_VARS заменяется render.js, а образцы текстов используют только известные', () => {
  const { renderTemplate } = require(path.join(BACK, 'services', 'notifications', 'render'));
  const full = { name: 'Иванова Мария', date: 'D', time: 'T', end_time: 'E', services: 'S', staff: 'F', salon: 'X', record_link: 'L' };
  const vars = plain(k('NT_VARS'));
  for (const [tok] of vars) assert.notStrictEqual(renderTemplate(tok, full), tok, `${tok} не подставляется на бэкенде`);
  const known = new Set(vars.map((v) => v[0]));
  for (const [type, meta] of Object.entries(plain(k('NT_TYPES')))) {
    for (const t of meta.sample.match(/\{[a-z_]+\}/g) || []) assert.ok(known.has(t), `образец ${type}: неизвестная подстановка ${t}`);
  }
});

// Тексты, по которым модуль узнаёт «это напоминание/опрос». Здесь — реальные шаблоны салона из
// docs/notifications/chatpush-templates-2026-10-13.md и пограничные строки.
const SAMPLES = [
  'Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись 01.09.2026 в 10:00\nПожалуйста, подтвердите визит',
  'Напоминаем о записи 01.09.2026 в 10:00',
  'Подтвердите, пожалуйста, ваш визит завтра',
  'Ваша запись подтверждена. Отменена? Подтвердите',
  'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5',
  'Спасибо, что были у нас! Отправьте цифру от 2 до 5',
  'Оцените, пожалуйста, наш сервис',
  'Вы записаны на прием 01.09.2026 10:00 в «PERI CLINIC».',
  'Рекомендации после процедуры',
  'Присоединяйтесь к программе лояльности',
  '',
  null,
];

test('ntLooksLikeReminder / ntLooksLikeSurvey дают тот же ответ, что детекторы бэкенда', () => {
  const { isReminder } = require(path.join(BACK, 'services', 'agent', 'visit-confirmation'));
  const { isRatingSurvey } = require(path.join(BACK, 'services', 'agent', 'visit-rating'));
  for (const s of SAMPLES) {
    assert.strictEqual(ctx.ntLooksLikeReminder(s), !!isReminder(s), `напоминание: ${JSON.stringify(s)}`);
    assert.strictEqual(ctx.ntLooksLikeSurvey(s), !!isRatingSurvey(s), `опрос: ${JSON.stringify(s)}`);
  }
  // и сами реальные тексты распознаются так, как нужно
  assert.strictEqual(ctx.ntLooksLikeReminder(SAMPLES[0]), true);
  assert.strictEqual(ctx.ntLooksLikeSurvey(SAMPLES[4]), true);
  assert.strictEqual(ctx.ntLooksLikeReminder(SAMPLES[7]), false);
});

// ── чистые помощники ──────────────────────────────────────────────────────────────────────────

test('ntFmt: время по Москве, формат не зависит от локали', () => {
  assert.strictEqual(ctx.ntFmt('2026-10-14T16:05:00Z'), '14.10 19:05');
  assert.strictEqual(ctx.ntFmt('2026-10-14T21:30:00Z'), '15.10 00:30');       // переход через полночь: 00, а не 24
  assert.strictEqual(ctx.ntFmt(null), '—');
  assert.strictEqual(ctx.ntFmt('чепуха'), '—');
});

test('ntRuleTiming / ntRuleSummary: по одной фразе на тип', () => {
  const t = (o) => ctx.ntRuleTiming(o);
  assert.strictEqual(t({ trigger_type: 'record_created' }), 'сразу');
  assert.strictEqual(t({ trigger_type: 'record_rescheduled' }), 'сразу');
  assert.strictEqual(t({ trigger_type: 'first_visit' }), 'при первой записи нового клиента');
  assert.strictEqual(t({ trigger_type: 'visit_reminder', hours_before: 24, ask_confirmation: true }), 'за 24 ч до визита, просит подтвердить');
  assert.strictEqual(t({ trigger_type: 'visit_reminder', hours_before: 3, ask_confirmation: false }), 'за 3 ч до визита, без запроса подтверждения');
  // «не задано»/0 — как events.reminderAt: 24 ч
  assert.strictEqual(t({ trigger_type: 'visit_reminder', hours_before: null }), 'за 24 ч до визита, просит подтвердить');
  assert.strictEqual(t({ trigger_type: 'visit_reminder', hours_before: 0 }), 'за 24 ч до визита, просит подтвердить');
  assert.strictEqual(t({ trigger_type: 'visit_review', delay_minutes: 30 }), 'через 30 мин после визита');
  // 0 минут — законное значение («сразу по окончании»), а не «не задано»
  assert.strictEqual(t({ trigger_type: 'visit_after', delay_minutes: 0 }), 'через 0 мин после визита');
  assert.strictEqual(t({ trigger_type: 'visit_after', delay_minutes: null }), 'через 5 мин после визита');
  assert.strictEqual(t({ trigger_type: 'record_cancelled', on_no_show: true }), 'при отметке «клиент не придёт»');
  assert.match(t({ trigger_type: 'record_cancelled', on_no_show: false }), /не отправляется/);
  assert.strictEqual(ctx.ntRuleSummary({ trigger_type: 'record_created', conditions: { logic: 'and', items: [] } }, null), 'сразу · любая запись');
});

test('ntCondSummary: названия из справочника, без справочника — числа, И/ИЛИ, «+N»', () => {
  const dicts = {
    staff: [{ id: 1, name: 'Юлия' }], categories: [{ id: 5, title: 'Эпиляция' }],
    services: [{ id: 10, title: 'Бикини' }, { id: 11, title: 'Ноги' }, { id: 12, title: 'Руки' }, { id: 13, title: 'Спина' }],
  };
  const c = { logic: 'and', items: [{ type: 'category', ids: [5] }, { type: 'staff', ids: [1] }] };
  assert.strictEqual(ctx.ntCondSummary(c, dicts), 'Категория: Эпиляция И Специалист: Юлия');
  assert.strictEqual(ctx.ntCondSummary({ ...c, logic: 'or' }, dicts), 'Категория: Эпиляция ИЛИ Специалист: Юлия');
  assert.strictEqual(ctx.ntCondSummary(c, null), 'Категория: 1 шт. И Специалист: 1 шт.');
  assert.strictEqual(ctx.ntCondSummary({ logic: 'and', items: [{ type: 'service', ids: [10, 11, 12, 13] }] }, dicts), 'Услуга: Бикини, Ноги, Руки +1');
  assert.strictEqual(ctx.ntCondSummary({ logic: 'and', items: [{ type: 'service', ids: [999] }] }, dicts), 'Услуга: 999');
  // пустые условия и мусор — «любая запись»
  assert.strictEqual(ctx.ntCondSummary({ logic: 'and', items: [{ type: 'staff', ids: [] }] }, dicts), 'любая запись');
  assert.strictEqual(ctx.ntCondSummary(null, dicts), 'любая запись');
});

test('ntCascadeLine / ntModeLine', () => {
  const s = { mode: 'off', default_channels: ['tdlib', 'whatsapp', 'max'], prefer_last_channel: true };
  assert.strictEqual(ctx.ntCascadeLine(s), 'мессенджер последней переписки, затем Telegram → WhatsApp → MAX');
  assert.strictEqual(ctx.ntCascadeLine({ ...s, prefer_last_channel: false, default_channels: ['max', 'tdlib'] }), 'MAX → Telegram');
  // пустой каскад + «сначала последний» не должен давать бессмыслицу «…, затем не задан»
  assert.strictEqual(ctx.ntCascadeLine({ ...s, default_channels: [] }), 'не задан — отправок не будет');
  assert.match(ctx.ntModeLine(s), /^Режим: ⚪ выключен · Каскад: /);
  assert.match(ctx.ntModeLine({ ...s, mode: 'shadow' }), /^Режим: 🟡 теневой/);
  assert.match(ctx.ntModeLine({ ...s, mode: 'live' }), /^Режим: 🟢 боевой/);
  // неизвестный режим читается как выключенный (fail-closed, как на бэкенде)
  assert.match(ctx.ntModeLine({ ...s, mode: 'что-то' }), /^Режим: ⚪ выключен/);
});

test('ntCascadeSteps / ntCascadePath: подписи шагов, мусор не роняет', () => {
  const log = [{ ch: 'tdlib', res: 'no_recipient', at: 'x' }, { ch: 'whatsapp', res: 'rejected', err: '404' }, { ch: 'max', res: 'sent' }];
  assert.strictEqual(ctx.ntCascadePath(log), 'Telegram: нет адресата → WhatsApp: отказ → MAX: отправлено');
  assert.strictEqual(plain(ctx.ntCascadeSteps(log))[1].err, '404');
  assert.strictEqual(ctx.ntCascadePath([{ ch: 'viber', res: 'zzz' }]), 'viber: zzz');
  assert.strictEqual(ctx.ntCascadePath(null), '');
  assert.strictEqual(ctx.ntCascadePath([null, 5, 'x']), '');
});

test('ntStatus / ntJobWhen / ntReplyLabel', () => {
  assert.deepStrictEqual(plain(ctx.ntStatus('shadow')), { lbl: 'Тень', color: '#6366f1' });
  assert.strictEqual(ctx.ntStatus('weird').lbl, 'weird');
  assert.strictEqual(ctx.ntStatus(undefined).lbl, '—');
  assert.deepStrictEqual(plain(ctx.ntJobWhen({ status: 'pending', scheduled_at: 'S', sent_at: 'E', created_at: 'C' })), { ts: 'S', plan: true });
  assert.deepStrictEqual(plain(ctx.ntJobWhen({ status: 'sent', scheduled_at: 'S', sent_at: 'E', created_at: 'C' })), { ts: 'E', plan: false });
  // тень/пропуск/отмена: sent_at пуст — показываем момент, на который отправка была назначена
  assert.deepStrictEqual(plain(ctx.ntJobWhen({ status: 'shadow', scheduled_at: 'S', sent_at: null, created_at: 'C' })), { ts: 'S', plan: false });
  assert.strictEqual(ctx.ntReplyLabel('visit_reminder'), '✅ подтвердил');
  assert.strictEqual(ctx.ntReplyLabel('visit_review'), '✅ ответил оценкой');
});

test('ntJobsQuery: пустые фильтры и нулевая страница не передаются', () => {
  assert.strictEqual(ctx.ntJobsQuery({ type: '', status: '', date: '', page: 0 }), '');
  assert.strictEqual(ctx.ntJobsQuery({ type: 'visit_review', status: 'sent', date: '2026-10-14', page: 2 }),
    '?type=visit_review&status=sent&date=2026-10-14&page=2');
  assert.strictEqual(ctx.ntJobsQuery({ status: 'shadow' }), '?status=shadow');
  assert.strictEqual(ctx.ntJobsQuery(null), '');
});

test('сверка: разница «мы − Chatpush» и подпись со знаком', () => {
  assert.strictEqual(ctx.ntParityDelta({ ours: { planned: 12 }, chatpush: 10 }), 2);
  assert.strictEqual(ctx.ntParityDelta({ ours: { planned: 3 }, chatpush: 10 }), -7);
  assert.strictEqual(ctx.ntParityDelta({ chatpush: '4' }), -4);
  assert.strictEqual(ctx.ntParityDeltaText(2), '+2');
  assert.strictEqual(ctx.ntParityDeltaText(0), '0');
  assert.strictEqual(ctx.ntParityDeltaText(-7), '-7');
});

test('ntRatingsLine: склонение и пустая сводка', () => {
  assert.strictEqual(ctx.ntRatingsLine({ n: 0, avg: null, high: 0, low: 0 }), 'За 30 дней оценок нет');
  assert.strictEqual(ctx.ntRatingsLine(null), 'За 30 дней оценок нет');
  assert.match(ctx.ntRatingsLine({ n: 1, avg: 5, high: 1, low: 0 }), /^За 30 дней: 1 оценка · средняя 5 · высоких \(4–5\): 1 · низких \(2–3\): 0$/);
  assert.match(ctx.ntRatingsLine({ n: 3, avg: 4.33, high: 2, low: 1 }), /3 оценки/);
  assert.match(ctx.ntRatingsLine({ n: 12, avg: 4.5, high: 10, low: 2 }), /12 оценок/);
  assert.match(ctx.ntRatingsLine({ n: 21, avg: 4.5, high: 10, low: 2 }), /21 оценка/);
});

test('ntTextWarnings: подтверждение и опрос распознаются по тексту, пустой текст молчит', () => {
  const w = ctx.ntTextWarnings;
  // реальные шаблоны салона — без предупреждений
  assert.strictEqual(w('visit_reminder', SAMPLES[0], true).length, 0);
  assert.strictEqual(w('visit_review', SAMPLES[4], true).length, 0);
  // напоминание без просьбы подтвердить при включённом подтверждении — предупреждение
  assert.strictEqual(w('visit_reminder', 'Ждём вас завтра в 10:00', true).length, 1);
  assert.match(w('visit_reminder', 'Ждём вас завтра в 10:00', true)[0], /Подтверждаю/);
  // подтверждение выключено — слова не нужны
  assert.strictEqual(w('visit_reminder', 'Ждём вас завтра в 10:00', false).length, 0);
  // опрос без слов «оцените» / «от 2 до 5»
  assert.strictEqual(w('visit_review', 'Спасибо, что были у нас!', true).length, 1);
  assert.match(w('visit_review', 'Спасибо, что были у нас!', true)[0], /оценк/);
  // прочие типы и пустой текст — тишина
  assert.strictEqual(w('record_created', 'что угодно', true).length, 0);
  assert.strictEqual(w('visit_review', '   ', true).length, 0);
  assert.strictEqual(w('visit_review', null, true).length, 0);
});

test('ntFormError: границы как у parseRuleBody бэкенда, пустое поле — не ноль', () => {
  const ok = { title: 'Т', type: 'record_created', text: 'текст' };
  assert.strictEqual(ctx.ntFormError(ok), null);
  assert.strictEqual(ctx.ntFormError({ ...ok, title: '  ' }), 'Введите название правила');
  assert.strictEqual(ctx.ntFormError({ ...ok, text: ' ' }), 'Введите текст сообщения');
  assert.strictEqual(ctx.ntFormError({ ...ok, type: 'x' }), 'Выберите тип уведомления');
  const rem = { ...ok, type: 'visit_reminder' };
  assert.strictEqual(ctx.ntFormError({ ...rem, hoursBefore: '24' }), null);
  assert.strictEqual(ctx.ntFormError({ ...rem, hoursBefore: '1' }), null);
  assert.strictEqual(ctx.ntFormError({ ...rem, hoursBefore: '72' }), null);
  for (const bad of ['0', '73', '', ' ', '1.5', 'abc', undefined]) {
    assert.match(ctx.ntFormError({ ...rem, hoursBefore: bad }), /Часы до визита/, `hoursBefore=${bad}`);
  }
  const rev = { ...ok, type: 'visit_review' };
  assert.strictEqual(ctx.ntFormError({ ...rev, delayMinutes: '0' }), null);          // 0 — законно
  assert.strictEqual(ctx.ntFormError({ ...rev, delayMinutes: '1440' }), null);
  for (const bad of ['', '-1', '1441', '2.5', 'x', undefined]) {
    assert.match(ctx.ntFormError({ ...rev, delayMinutes: bad }), /Минуты после визита/, `delayMinutes=${bad}`);
  }
  assert.strictEqual(ctx.ntFormError({ ...ok, type: 'visit_after', delayMinutes: '10' }), null);
});

test('ntBuildRuleBody: isEnabled — только когда передан, поля — только своего типа', () => {
  const c = { logic: 'and', items: [{ type: 'category', ids: [5] }] };
  const base = { title: ' Т ', text: ' текст ' };
  // Правка: поля нет вовсе (бэкенд оставляет прежнее состояние — устаревшая копия правила его не затрёт);
  // создание: true (новое правило включено сразу).
  assert.strictEqual('isEnabled' in plain(ctx.ntBuildRuleBody({ ...base, type: 'record_created' }, c, undefined)), false);
  assert.strictEqual('isEnabled' in plain(ctx.ntBuildRuleBody({ ...base, type: 'record_created' }, c)), false);
  assert.strictEqual(ctx.ntBuildRuleBody({ ...base, type: 'record_created' }, c, true).isEnabled, true);
  assert.strictEqual(ctx.ntBuildRuleBody({ ...base, type: 'record_created' }, c, false).isEnabled, false);
  assert.strictEqual('isEnabled' in plain(ctx.ntBuildRuleBody({ ...base, type: 'record_created' }, c, 'yes')), false);   // не булево — не шлём
  const created = plain(ctx.ntBuildRuleBody({ ...base, type: 'record_created', hoursBefore: '5', onNoShow: false }, c));
  assert.deepStrictEqual(created, { title: 'Т', triggerType: 'record_created', messageTemplate: 'текст', conditions: c });
  const rem = plain(ctx.ntBuildRuleBody({ ...base, type: 'visit_reminder', hoursBefore: '24', askConfirmation: false }, c, true));
  assert.strictEqual(rem.hoursBefore, 24);
  assert.strictEqual(rem.askConfirmation, false);
  assert.strictEqual('delayMinutes' in rem, false);
  assert.strictEqual(plain(ctx.ntBuildRuleBody({ ...base, type: 'visit_reminder', hoursBefore: '24' }, c, true)).askConfirmation, true);
  const after = plain(ctx.ntBuildRuleBody({ ...base, type: 'visit_after', delayMinutes: '0' }, c, true));
  assert.strictEqual(after.delayMinutes, 0);
  const cancel = plain(ctx.ntBuildRuleBody({ ...base, type: 'record_cancelled', onNoShow: false }, c, true));
  assert.strictEqual(cancel.onNoShow, false);
  assert.strictEqual(plain(ctx.ntBuildRuleBody({ ...base, type: 'record_cancelled' }, c, true)).onNoShow, true);
});

test('ntFileError: размер и формат вложения', () => {
  assert.strictEqual(ctx.ntFileError(null), null);
  assert.strictEqual(ctx.ntFileError({ size: 1000, type: 'image/jpeg' }), null);
  assert.strictEqual(ctx.ntFileError({ size: 5 * 1024 * 1024, type: 'image/png' }), null);
  assert.strictEqual(ctx.ntFileError({ size: 5 * 1024 * 1024 + 1, type: 'image/png' }), 'Файл больше 5 МБ');
  assert.match(ctx.ntFileError({ size: 10, type: 'image/gif' }), /JPEG, PNG или WEBP/);
  assert.match(ctx.ntFileError({ size: 10, type: 'application/pdf' }), /JPEG, PNG или WEBP/);
  assert.strictEqual(ctx.ntFileError({ size: 10, type: '' }), null);           // браузер не назвал тип — решает сервер по сигнатуре
});

test('настройки: тихие часы, пустые ответы, вопросы confirm()', () => {
  assert.strictEqual(ctx.ntQuietError('21:00', '09:00'), null);
  assert.strictEqual(ctx.ntQuietError('', ''), null);
  assert.strictEqual(ctx.ntQuietError(null, null), null);
  assert.match(ctx.ntQuietError('21:00', ''), /оба поля/);
  assert.match(ctx.ntQuietError('', '09:00'), /оба поля/);
  assert.match(ctx.ntQuietError('09:00', '09:00'), /нулевой длины/);

  const form = { mode: 'off', preferLast: true, quietFrom: '21:00', quietTo: '09:00', confirm: 'a', high: 'b', mid: 'c', low: 'd', escalate: true };
  const body = plain(ctx.ntBuildSettingsBody(form, ['max', 'tdlib']));
  assert.deepStrictEqual(body, {
    mode: 'off', default_channels: ['max', 'tdlib'], prefer_last_channel: true, quiet_from: '21:00', quiet_to: '09:00',
    confirm_reply_text: 'a', rating_high_text: 'b', rating_mid_text: 'c', rating_low_text: 'd', rating_escalate_low: true,
  });
  // пустые тихие часы уходят null: бэкенд читает 'quiet_from' in p
  const noQuiet = plain(ctx.ntBuildSettingsBody({ ...form, quietFrom: '', quietTo: '' }, []));
  assert.strictEqual(noQuiet.quiet_from, null);
  assert.strictEqual(noQuiet.quiet_to, null);

  assert.strictEqual(ctx.ntSettingsError(body), null);
  assert.match(ctx.ntSettingsError({ ...body, confirm_reply_text: '  ' }), /подтверждения визита/);
  assert.match(ctx.ntSettingsError({ ...body, rating_high_text: '' }), /оценки 5/);
  assert.match(ctx.ntSettingsError({ ...body, rating_mid_text: '' }), /оценки 4/);
  assert.match(ctx.ntSettingsError({ ...body, rating_low_text: '' }), /оценки 2–3/);
  assert.match(ctx.ntSettingsError({ ...body, quiet_to: null }), /Тихие часы/);

  // боевой режим: вопрос — только при переходе В него (не при каждом сохранении уже боевого)
  const q = (prev, b) => plain(ctx.ntSettingsQuestions(prev, b));
  assert.deepStrictEqual(q({ mode: 'off' }, { mode: 'off', default_channels: [] }), []);   // в off пустой каскад не страшен
  assert.strictEqual(q({ mode: 'off' }, { mode: 'live', default_channels: ['tdlib'] }).length, 1);
  assert.match(q({ mode: 'shadow' }, { mode: 'live', default_channels: ['tdlib'] })[0], /Chatpush/);
  assert.deepStrictEqual(q({ mode: 'live' }, { mode: 'live', default_channels: ['tdlib'] }), []);
  assert.deepStrictEqual(q(null, { mode: 'shadow', default_channels: ['tdlib'] }), []);
  // не off и пустой каскад — отдельный вопрос; боевой идёт первым
  assert.match(q({ mode: 'off' }, { mode: 'shadow', default_channels: [] })[0], /не выбран ни один мессенджер/);
  const both = q({ mode: 'off' }, { mode: 'live', default_channels: [] });
  assert.strictEqual(both.length, 2);
  assert.match(both[0], /боевой режим/);
});

test('ntNewRule: незнакомый тип → record_created, значения по умолчанию', () => {
  assert.strictEqual(ctx.ntNewRule('visit_review').trigger_type, 'visit_review');
  assert.strictEqual(ctx.ntNewRule('zzz').trigger_type, 'record_created');
  assert.strictEqual(ctx.ntNewRule().trigger_type, 'record_created');
  const r = plain(ctx.ntNewRule('visit_reminder'));
  assert.strictEqual(r.hours_before, 24);
  assert.strictEqual(r.ask_confirmation, true);
  assert.strictEqual(r.is_enabled, true);
  assert.deepStrictEqual(r.conditions, { logic: 'and', items: [] });
});

test('подсказки типов — тексты, утверждённые по реальным данным', () => {
  const T = plain(k('NT_TYPES'));
  assert.match(T.record_cancelled.hint, /клиент не придёт/);
  assert.match(T.record_cancelled.hint, /Удаление записи уведомления не шлёт — как YClients/);
  assert.match(T.visit_reminder.hint, /по умолчанию 24/);
  assert.match(T.visit_reminder.hint, /по уже подтверждённым визитам не шлётся/);
  assert.match(T.visit_review.hint, /не чаще раза в 30 дней/);
  assert.match(T.visit_review.hint, /цифрой 2–5/);
  assert.match(T.visit_after.hint, /по услугам, с картинкой/);
  assert.match(T.first_visit.hint, /при создании первой записи/);
  assert.match(T.record_created.hint, /только для будущих визитов/);
  assert.match(T.record_rescheduled.hint, /только для будущих визитов/);
});

// ── ответы сервера: отмена job'а и тумблер ────────────────────────────────────────────────────

test('ntCancelOutcome: {ok:false} — не «Отправка отменена»', () => {
  assert.deepStrictEqual(plain(ctx.ntCancelOutcome({ ok: true })), { text: 'Отправка отменена', type: 'ok' });
  const no = { text: 'Строка уже не в очереди (ушла или отменена)', type: 'err' };
  for (const reply of [{ ok: false }, {}, null, undefined]) assert.deepStrictEqual(plain(ctx.ntCancelOutcome(reply)), no);
});

test('ntToggleMessage: при выключении показывает cancelledJobs, если поле есть', () => {
  const on = { rule: { is_enabled: true }, cancelledJobs: 0 };
  assert.strictEqual(ctx.ntToggleMessage(on), 'Правило включено');                          // 0 при включении — не новость
  const off = (n) => ({ rule: { is_enabled: false }, ...(n === undefined ? {} : { cancelledJobs: n }) });
  assert.strictEqual(ctx.ntToggleMessage(off(3)), 'Правило выключено. Погашено в очереди: 3');
  assert.strictEqual(ctx.ntToggleMessage(off(0)), 'Правило выключено. Погашено в очереди: 0');   // поле есть — говорим как есть
  assert.strictEqual(ctx.ntToggleMessage(off()), 'Правило выключено');                        // старый бэкенд без поля
  assert.strictEqual(ctx.ntToggleMessage(off('3')), 'Правило выключено');                     // не число — не подставляем
  assert.strictEqual(ctx.ntToggleMessage(null), 'Правило выключено');
});

// ── обработчики с подменёнными api/notify: что реально сказано пользователю и перечитано ───────

// Заглушка document для esc(): в браузере он строится на DOM (textContent → innerHTML), а в vm документа нет.
// Сериализация текстового узла та же: & < > и NBSP, кавычки НЕ экранируются. getElementById хранит «элементы»
// по id — из них читаем то, что скрипт записал в innerHTML.
function domPage() {
  const els = {};
  const htmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
  const document = {
    createElement() { let text = ''; return { set textContent(v) { text = String(v); }, get innerHTML() { return htmlEscape(text); } }; },
    getElementById(id) {
      return els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', placeholder: '', style: {}, className: '',
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false } });
    },
  };
  const page = loadPage({ document, confirm: () => true });
  page.els = els;
  return page;
}

// Подменяем то, что ходит в сеть/на экран, и считаем вызовы. Функции-объявления верхнего уровня — свойства
// глобального объекта: вызовы внутри скрипта находят подмену при каждом обращении.
function stubPage(reply, confirmAnswer = true) {
  const page = domPage();
  const log = { api: [], notify: [], loads: 0, jobsLoads: 0, renders: 0 };
  page.__log = log; page.__reply = reply; page.confirm = () => confirmAnswer;
  vm.runInContext(`
    api = async (m, p) => { __log.api.push([m, p]); return __reply; };
    notify = (t, ty) => { __log.notify.push([t, ty]); };
    ntLoad = async () => { __log.loads++; };
    ntLoadJobs = async () => { __log.jobsLoads++; };
    ntRenderRules = () => { __log.renders++; };`, page);
  return { page, log };
}

test('ntCancelJob: {ok:false} → «Строка уже не в очереди…» и перерисовка журнала, не «Отправка отменена»', async () => {
  const lost = stubPage({ ok: false });
  await lost.page.ntCancelJob(5);
  assert.deepStrictEqual(plain(lost.log.notify), [['Строка уже не в очереди (ушла или отменена)', 'err']]);
  assert.strictEqual(lost.log.jobsLoads, 1);
  assert.deepStrictEqual(plain(lost.log.api), [['POST', '/api/notification-rules/jobs/5/cancel']]);

  const done = stubPage({ ok: true });
  await done.page.ntCancelJob(5);
  assert.deepStrictEqual(plain(done.log.notify), [['Отправка отменена', 'ok']]);
  assert.strictEqual(done.log.jobsLoads, 1);

  const declined = stubPage({ ok: true }, false);          // отказ от confirm — ни запроса, ни сообщений
  await declined.page.ntCancelJob(5);
  assert.deepStrictEqual(plain(declined.log), { api: [], notify: [], loads: 0, jobsLoads: 0, renders: 0 });
});

test('ntToggle: после тумблера список перечитывается, cancelledJobs показан; отказ от confirm ничего не шлёт', async () => {
  const rules = '_ntRules = [{ id: 7, is_enabled: true, pending_count: 2 }, { id: 8, is_enabled: false, pending_count: 0 }];';
  const off = stubPage({ ok: true, rule: { is_enabled: false }, cancelledJobs: 2 });
  vm.runInContext(rules, off.page);
  await off.page.ntToggle(7);
  assert.deepStrictEqual(plain(off.log.notify).map((n) => n[0]), ['Правило выключено. Погашено в очереди: 2']);
  assert.strictEqual(off.log.loads, 1, 'список правил не перечитан');
  assert.deepStrictEqual(plain(off.log.api), [['POST', '/api/notification-rules/7/toggle']]);

  const on = stubPage({ ok: true, rule: { is_enabled: true }, cancelledJobs: 0 });     // включение: confirm не нужен
  vm.runInContext(rules, on.page);
  let asked = false;
  on.page.confirm = () => { asked = true; return true; };
  await on.page.ntToggle(8);
  assert.strictEqual(asked, false);
  assert.deepStrictEqual(plain(on.log.notify).map((n) => n[0]), ['Правило включено']);
  assert.strictEqual(on.log.loads, 1);

  const declined = stubPage({ ok: true, rule: { is_enabled: false }, cancelledJobs: 2 }, false);
  vm.runInContext(rules, declined.page);
  await declined.page.ntToggle(7);
  assert.deepStrictEqual(plain(declined.log.api), []);
  assert.strictEqual(declined.log.loads, 0);
  assert.strictEqual(declined.log.renders, 1, 'тумблер должен вернуться к состоянию модели');
});

// ── экранирование: XSS-фикстуры через настоящие рендеры ───────────────────────────────────────

// Строки, которыми ломают разметку и JS-литерал: сущность, раскодируемая в кавычку ДО JS-разбора; кавычки обоих
// видов; обратный слэш; закрывающий тег; перевод строки и разделитель строк.
const HOSTILE = [
  "&#39;);canary();//", "');canary();//", '");canary();("', "\\');canary();//", '&amp;#39;);canary();//', '&quot;);canary();//',
  '</script><img src=x onerror=canary()>', "a\nb\u2028c", '\'"&<>', '"><img src=x onerror=canary()>',
];

// Раскодирование значения атрибута ровно так, как это делает HTML-парсер: ОДИН проход по сущностям.
const decodeAttr = (v) => v.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
});

// Разбор разметки без браузера: теги с атрибутами в двойных кавычках (так пишет сам скрипт).
function tokens(html) {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:="[^"]*")?)*)\s*>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    for (const a of m[3].matchAll(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push({ close: m[1] === '/', tag: m[2].toLowerCase(), attrs });
  }
  return out;
}

const TAGS_OK = new Set(['a', 'b', 'button', 'code', 'div', 'img', 'input', 'label', 'span', 'td', 'tr']);
const ATTRS_OK = new Set(['alt', 'accept', 'checked', 'class', 'data-ch', 'data-id', 'data-label', 'data-status', 'data-type', 'disabled',
  'href', 'id', 'max', 'min', 'onchange', 'onclick', 'rel', 'src', 'step', 'style', 'target', 'title', 'type', 'value']);

/** Разметка не содержит ничего, кроме своих тегов и атрибутов: ни вставленного тега, ни нового атрибута (onerror=…). */
function assertStructure(html, what) {
  const toks = tokens(html);
  const lt = (html.match(/</g) || []).length;
  assert.strictEqual(lt, toks.length, `${what}: есть '<', не разобранный как свой тег (вставленный тег или пробитая кавычка)`);
  for (const t of toks) {
    assert.ok(TAGS_OK.has(t.tag), `${what}: чужой тег <${t.tag}>`);
    for (const name of Object.keys(t.attrs)) assert.ok(ATTRS_OK.has(name), `${what}: чужой атрибут ${name} у <${t.tag}>`);
  }
  return toks;
}

/** Исполняет каждый on*-обработчик (после раскодирования сущностей) в песочнице: вызов своей функции записывается,
 *  всё постороннее (canary/alert или ReferenceError на чужом имени) — провал. */
function runHandlers(html) {
  const calls = [];
  let stray = 0;
  for (const t of tokens(html)) {
    for (const [name, raw] of Object.entries(t.attrs)) {
      if (!name.startsWith('on')) continue;
      const code = decodeAttr(raw);
      const sandbox = { alert() { stray++; }, canary() { stray++; } };
      const callee = /^([A-Za-z_]\w*)\(/.exec(code);
      if (callee) sandbox[callee[1]] = (...args) => calls.push({ fn: callee[1], args });
      try { vm.runInNewContext(code, sandbox, { timeout: 200 }); } catch (e) { stray++; }
    }
  }
  return { calls, stray };
}

test('ntJsArg / ntAttr: враждебные значения не выходят ни из атрибута, ни из JS-литерала', () => {
  const page = domPage();
  const ntAttr = vm.runInContext('ntAttr', page), ntJsArg = vm.runInContext('ntJsArg', page);   // const верхнего уровня — не свойство контекста
  for (const s of HOSTILE) {
    const html = `<a title="${ntAttr(s)}" onclick="f('${ntJsArg(s)}')">x</a>`;
    const [a] = assertStructure(html, JSON.stringify(s)).filter((t) => t.tag === 'a');
    assert.strictEqual(decodeAttr(a.attrs.title), s, 'значение атрибута искажено');
    const { calls, stray } = runHandlers(html);
    assert.strictEqual(stray, 0, `в обработчике исполнился посторонний код: ${JSON.stringify(s)}`);
    assert.deepStrictEqual(plain(calls), [{ fn: 'f', args: [s] }], `аргумент обработчика искажён: ${JSON.stringify(s)}`);
  }
});

test('прежний ntJsArg (escAttr(escJs(s))) на «&#39;);…» исполнял код — тест это ловит', () => {
  const page = domPage();
  const old = (s) => page.escAttr(page.escJs(s));
  const html = `<a onclick="f('${old(HOSTILE[0])}')">x</a>`;
  assert.ok(runHandlers(html).stray > 0, 'уязвимость не воспроизвелась: тест не отличает безопасный ntJsArg от небезопасного');
});

test('ntUploadHref: только наш каталог загрузок', () => {
  assert.strictEqual(ctx.ntUploadHref('/uploads/notify_1_2_3.jpg'), '/uploads/notify_1_2_3.jpg');
  assert.strictEqual(ctx.ntUploadHref('/uploads/notify_seed/Пилинг.jpg'), '/uploads/notify_seed/Пилинг.jpg');
  for (const bad of ['javascript:canary()', 'https://evil.example/x.jpg', '//evil.example/x.jpg', '/uploads', '/uploadsX/a.jpg',
    'uploads/a.jpg', '/uploads/../etc/passwd', '/other/uploads/a.jpg', '', null, undefined, 5, {}]) {
    assert.strictEqual(ctx.ntUploadHref(bad), '', `пропущено: ${JSON.stringify(bad)}`);
  }
});

test('ntRuleRow с XSS-фикстурой: свои теги и атрибуты, обработчики вызывают только свои функции', () => {
  const page = domPage();
  const evil = '<img src=x onerror=canary()>"\'&#39;);canary();//';
  vm.runInContext(`_ntDicts = { staff: [], categories: [], services: [{ id: 1, title: ${JSON.stringify(evil)}, category_id: 0 }] };`, page);
  const rule = {
    id: 7, title: evil, is_enabled: false, trigger_type: 'visit_reminder', hours_before: 24, ask_confirmation: true,
    attachment_url: '"><script>canary()</script>', sent_count: 2, shadow_count: 1, pending_count: 3, failed_count: 1,
    conditions: { logic: 'and', items: [{ type: 'service', ids: [1, '"><img src=x onerror=canary()>'] }] },
  };
  const html = page.ntRuleRow(rule);
  assertStructure(html, 'ntRuleRow');
  assert.ok(html.includes('&lt;img src=x onerror=canary()&gt;'), 'название правила не экранировано как текст');
  assert.ok(html.includes('care-st-stopped'), 'выключенное правило без бейджа');
  const { calls, stray } = runHandlers(html);
  assert.strictEqual(stray, 0);
  assert.deepStrictEqual(plain(calls).map((c) => [c.fn, ...c.args]), [['ntToggle', 7], ['ntOpenEditor', 7], ['ntOpenEditor', 7]]);

  // id приходит из БД числом; строка с кодом после Number() — NaN, а не исполняемый хвост
  const html2 = page.ntRuleRow({ ...rule, id: '7);canary();//' });
  assertStructure(html2, 'ntRuleRow (id-строка)');
  const r2 = runHandlers(html2);
  assert.strictEqual(r2.stray, 0);
  assert.ok(plain(r2.calls).every((c) => Number.isNaN(c.args[0]) || c.args[0] === null), 'id не превратился в NaN');
});

test('ntTypeCard: неизвестный тип из БД — без кнопки добавления, название экранировано', () => {
  const page = domPage();
  const html = page.ntTypeCard('<img src=x onerror=canary()>', [{ id: 1, title: 'T', trigger_type: 'x', is_enabled: true, conditions: null }]);
  assertStructure(html, 'ntTypeCard');
  assert.ok(!/ntOpenEditor\(null/.test(html), 'у неизвестного типа не должно быть «+ Правило»');
  assert.strictEqual(runHandlers(html).stray, 0);
});

test('ntJobRow с XSS-фикстурой: свои теги и атрибуты, ссылка вложения — только на /uploads/', () => {
  const page = domPage();
  const job = {
    id: '5', status: 'pending', trigger_type: 'visit_reminder', rule_title: '<b onmouseover=canary()>x</b>',
    client_name: '<img src=x onerror=canary()>', phone: '"><script>canary()</script>', yclients_record_id: '0',
    rendered_text: '<script>canary()</script>"\'&#39;);canary();//', attachment_url: 'javascript:canary()',
    cascade_log: [{ ch: 'tdlib', res: 'rejected', err: '"><img src=x onerror=canary()>' }, { ch: '<x>', res: '<y>' }],
    error: '<i>e</i>', decision_reason: null, confirmed_at: '2026-10-14T10:00:00Z', channel_used: '<z>',
    visit_datetime: '2026-10-15T10:00:00Z', scheduled_at: '2026-10-15T08:00:00Z', created_at: '2026-10-14T10:00:00Z', sent_at: null,
  };
  let html = page.ntJobRow(job);
  assertStructure(html, 'ntJobRow');
  assert.ok(html.includes('&lt;script&gt;canary()&lt;/script&gt;'), 'текст сообщения не экранирован');
  assert.ok(!/<a\b/.test(html), 'для javascript: не должно быть ссылки');
  assert.ok(html.includes('📎'), 'признак вложения пропал');
  let r = runHandlers(html);
  assert.strictEqual(r.stray, 0);
  assert.deepStrictEqual(plain(r.calls), [{ fn: 'ntCancelJob', args: [5] }]);

  // пустое значение вложения — без значка; id как строка с кодом не исполняется
  assert.ok(!page.ntJobRow({ ...job, attachment_url: null }).includes('📎'));
  html = page.ntJobRow({ ...job, id: '5);canary();//' });
  assertStructure(html, 'ntJobRow (id-строка)');
  r = runHandlers(html);
  assert.strictEqual(r.stray, 0);

  // свой каталог — ссылка есть; чужой/обходной — нет
  const link = (url) => { const h = page.ntJobRow({ ...job, attachment_url: url }); assertStructure(h, url); return tokens(h).find((t) => t.tag === 'a'); };
  assert.strictEqual(decodeAttr(link('/uploads/notify_1_2_3.jpg').attrs.href), '/uploads/notify_1_2_3.jpg');
  for (const bad of ['https://evil.example/x.jpg', '//evil.example/x.jpg', '/uploads/../etc/passwd', 'data:text/html,<script>']) {
    assert.strictEqual(link(bad), undefined, `ссылка на ${bad}`);
  }
});

test('ntRenderTypeFields: превью картинки — только для /uploads/, «Убрать картинку» остаётся', () => {
  const page = domPage();
  const render = (url, name) => {
    page.ntRenderTypeFields({ trigger_type: 'visit_after', delay_minutes: 5, attachment_url: url, attachment_name: name });
    const html = page.els.ntTypeFields.innerHTML;
    assertStructure(html, 'ntRenderTypeFields');
    return html;
  };
  assert.match(render('/uploads/notify_1_2_3.jpg', '<b>a.jpg</b>'), /<img src="\/uploads\/notify_1_2_3\.jpg"/);
  const bad = render('javascript:canary()', '"><img src=x onerror=canary()>');
  assert.ok(!/<img/.test(bad), 'для javascript: не должно быть <img>');
  assert.ok(bad.includes('Убрать картинку'), 'без превью удалить вложение стало бы нечем');
  assert.ok(bad.includes('&lt;img src=x onerror=canary()&gt;'), 'имя файла не экранировано');
  assert.ok(!/<img/.test(render(null, null)));
  assert.strictEqual(runHandlers(bad).stray, 0);
});

test('ntRenderCascade: враждебный идентификатор мессенджера из настроек не исполняется', () => {
  const page = domPage();
  vm.runInContext(`_ntCascade = [${JSON.stringify(HOSTILE[0])}, 'tdlib'];`, page);
  page.ntRenderCascade();
  const html = page.els.ntsChannels.innerHTML;
  assertStructure(html, 'ntRenderCascade');
  const { calls, stray } = runHandlers(html);
  assert.strictEqual(stray, 0);
  const toggles = plain(calls).filter((c) => c.fn === 'ntToggleCh').map((c) => c.args[0]);
  assert.ok(toggles.includes(HOSTILE[0]), 'аргумент ntToggleCh искажён');
  assert.ok(plain(calls).some((c) => c.fn === 'ntMoveCh'));
});
