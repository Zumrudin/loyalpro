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
function browserContext() {
  const ctx = vm.createContext({
    console, URLSearchParams,                  // браузерные глобали, которыми пользуются помощники
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  ctx.window = ctx;
  return ctx;
}
function run(ctx, file, src) {
  vm.runInContext(src !== undefined ? src : fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}
// Объекты из vm-контекста — из другой «реальности» (чужие Object/Array.prototype): deepStrictEqual их не сравнит.
const plain = (x) => JSON.parse(JSON.stringify(x));

// Один контекст на все помощники: файл грузится ровно так же, как в браузере.
const ctx = browserContext();
for (const f of ['core/utils.js', 'core/api.js', 'js/pages/conditions-editor.js', 'js/pages/broadcasts.js', 'js/pages/notifications.js']) {
  run(ctx, f, fs.readFileSync(path.join(FRONT, f.startsWith('core/') ? `js/${f}` : f), 'utf8'));
}
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
