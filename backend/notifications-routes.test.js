'use strict';

// Task 9 плана «уведомления YClients своим модулем»: API правил, настроек, журнала job'ов,
// вложения, теста на свой номер, оценок и паритета с Chatpush (routes/notification-rules.js).
//
// Два уровня:
//   • чистые функции (parseRuleBody, PARITY_PATTERNS, sniffImageExt, ownAttachmentFile);
//   • НАСТОЯЩИЙ Express-роутер в памяти (http.createServer + fetch/FormData, как в
//     agent-price-photos-upload.test.js; supertest в проекте нет). db, auth, настройки и YClients
//     замоканы — в БД не ходим. SQL эти моки не проверяют: после правок запросов обязателен живой
//     прогон на дев-БД (см. отчёт Task 9).

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const mockDb = { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() };
// Транзакция: настоящий withTransaction (db.js) делает BEGIN/COMMIT/ROLLBACK на клиенте пула; здесь fn получает
// заглушку клиента, и тесты видят порядок и параметры его запросов (откат при сбое проверяет db.js, не этот файл).
const mockClient = { query: jest.fn() };
const mockWithTx = jest.fn(async (fn) => fn(mockClient));
jest.mock('./db', () => ({ db: mockDb, withTransaction: (...a) => mockWithTx(...a) }));

const mockYcGet = jest.fn();
jest.mock('./services/yclients', () => ({ ycGet: (...a) => mockYcGet(...a) }));

// Настоящий requireRole (middleware/auth) без .env: config грузится ради одного JWT_SECRET.
jest.mock('./config', () => ({ JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789' }));

// В боевом JWT лежит { userId, salonId, role } — поля `id` НЕТ (v1 писал created_by = req.user.id = undefined).
// Пользователя запроса задаёт тест (mockUser). auth подменён, проверка роли — НАСТОЯЩАЯ: тест гарда
// закрепляет, что пускают ровно owner и admin, а не «хоть какой-то второй middleware в stack».
let mockUser = { salonId: 1, userId: 42, role: 'owner' };
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = { ...mockUser }; next(); },
  requireRole: jest.requireActual('./middleware/auth').requireRole,
}));

const mockSettings = { getSettings: jest.fn(), updateSettings: jest.fn() };
jest.mock('./services/notifications/settings', () => ({
  getSettings: (...a) => mockSettings.getSettings(...a),
  updateSettings: (...a) => mockSettings.updateSettings(...a),
  // чистая сверка пилотного номера — боевая, копия правила в моке разъехалась бы с settings.js
  isPilotPhone: jest.requireActual('./services/notifications/settings').isPilotPhone,
}));

// rules.js тянет chatpush/config (JWT_SECRET из env) — тесту это ни к чему.
jest.mock('./services/notifications/rules', () => ({
  ALLOWED_CHANNELS: ['telegram', 'whatsapp', 'tdlib', 'max', 'max_bot', 'notify'],
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const router = require('./routes/notification-rules');
const { parseRuleBody, TRIGGER_TYPES, PARITY_PATTERNS, sniffImageExt, ownAttachmentFile } = router;

const uploadsDir = path.join(__dirname, '../frontend/uploads');

// ───────────────────────── parseRuleBody ─────────────────────────

const ok = (over = {}) => ({ title: 'r', messageTemplate: 'Текст', triggerType: 'record_created', ...over });

test('типы триггеров известны', () => {
  expect(TRIGGER_TYPES).toEqual(['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit']);
});
test('неизвестный trigger_type → ошибка', () => {
  expect(parseRuleBody(ok({ triggerType: 'birthday' })).error).toMatch(/тип/i);
});
test('visit_reminder: hours_before 1..72, дефолт 24', () => {
  expect(parseRuleBody(ok({ triggerType: 'visit_reminder' })).value.hoursBefore).toBe(24);
  expect(parseRuleBody(ok({ triggerType: 'visit_reminder', hoursBefore: 100 })).error).toMatch(/час/i);
});
test('visit_review/visit_after: delay_minutes 0..1440', () => {
  expect(parseRuleBody(ok({ triggerType: 'visit_review', delayMinutes: 5 })).value.delayMinutes).toBe(5);
  expect(parseRuleBody(ok({ triggerType: 'visit_after', delayMinutes: -1 })).error).toMatch(/минут/i);
});
test('каналы у правила не задаются — каскад общий для салона (настройки)', () => {
  const v = parseRuleBody(ok({ channels: ['max'], preferLastChannel: false })).value;
  expect(v).not.toHaveProperty('channels');
  expect(v).not.toHaveProperty('preferLastChannel');
});
test('флаги нормализуются', () => {
  const v = parseRuleBody(ok({ onNoShow: false, askConfirmation: false })).value;
  expect(v).toMatchObject({ onNoShow: false, askConfirmation: false });
});
// null = «не передано»: PUT его не трогает (иначе правка текста выключенного правила его включала бы),
// а дефолт «включено» живёт только в POST.
test('isEnabled: не передан → null; true/false как есть', () => {
  expect(parseRuleBody(ok()).value.isEnabled).toBeNull();
  expect(parseRuleBody(ok({ isEnabled: null })).value.isEnabled).toBeNull();
  expect(parseRuleBody(ok({ isEnabled: true })).value.isEnabled).toBe(true);
  expect(parseRuleBody(ok({ isEnabled: false })).value.isEnabled).toBe(false);
});
test('isEnabled: не-булево значение → ошибка (опечатка в переключателе отправки не должна молча сработать как «вкл»)', () => {
  for (const bad of ['false', 'true', 'no', 0, 1, [], {}, [false]]) {
    expect({ bad, error: parseRuleBody(ok({ isEnabled: bad })).error }).toEqual({ bad, error: expect.stringMatching(/isEnabled/) });
  }
});
test('пустые название/текст и неизвестный тип условия отвергаются', () => {
  expect(parseRuleBody(ok({ title: '  ' })).error).toMatch(/название/i);
  expect(parseRuleBody(ok({ messageTemplate: '' })).error).toMatch(/текст/i);
  expect(parseRuleBody(ok({ conditions: { items: [{ type: 'color', ids: [1] }] } })).error).toMatch(/условия/i);
});
test('условия нормализуются: logic, числовые id, пустые пункты отбрасываются', () => {
  const v = parseRuleBody(ok({ conditions: { logic: 'or', items: [{ type: 'staff', ids: ['5', 'x', 7] }, { type: 'service', ids: [] }] } })).value;
  expect(v.conditions).toEqual({ logic: 'or', items: [{ type: 'staff', ids: [5, 7] }] });
});
test('поля чужого типа обнуляются: hoursBefore только у visit_reminder, delayMinutes только у review/after', () => {
  const v = parseRuleBody(ok({ triggerType: 'record_created', hoursBefore: 5, delayMinutes: 5 })).value;
  expect(v.hoursBefore).toBeNull();
  expect(v.delayMinutes).toBeNull();
});

// ───────────────────────── PARITY_PATTERNS ─────────────────────────

// SQL LIKE → RegExp (% — любая последовательность, включая переводы строк, как в PostgreSQL).
const likeToRe = (p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*') + '$');

test('PARITY_PATTERNS: по шаблону на каждый тип, и ровно на те же типы', () => {
  expect(Object.keys(PARITY_PATTERNS).sort()).toEqual([...TRIGGER_TYPES].sort());
});

test('PARITY_PATTERNS: каждый реальный текст Chatpush из выгрузки попадает ровно в свой тип', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/notifications/chatpush-templates-2026-10-13.md'), 'utf8');
  const blocks = [...doc.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  expect(blocks.length).toBeGreaterThanOrEqual(8);   // не опустела ли выгрузка

  const hits = {};
  for (const t of TRIGGER_TYPES) hits[t] = blocks.filter((b) => likeToRe(PARITY_PATTERNS[t]).test(b));
  // Каждый тип находит свой шаблон…
  for (const t of TRIGGER_TYPES) expect({ t, n: hits[t].length }).toEqual({ t, n: 1 });
  // …и ни один текст не засчитан двум типам сразу.
  for (const b of blocks) {
    const types = TRIGGER_TYPES.filter((t) => likeToRe(PARITY_PATTERNS[t]).test(b));
    expect(types.length).toBeLessThanOrEqual(1);
  }
});

test('PARITY_PATTERNS: чужие системные тексты не считаются уведомлениями', () => {
  const alien = [
    // Мила, ошибочно помеченная authored_by=system (встречается на дев-данных)
    'Здравствуйте, Дарья! Я Мила, виртуальный администратор PERI CLINIC. Прежняя запись на 6 октября отменена, поэтому…',
    'Ваша запись перенесена? Подскажите, пожалуйста, удобное время.',
    '✅ Ваша запись подтверждена.\nБудем ждать вас!',
    'Спасибо за отличную оценку нашей работы! 🙏🏻\nМы были бы очень благодарны за отзыв о нас',
    'Благодарим Вас за оценку.\nНе могли бы Вы рассказать, что именно Вас не устроило?',
  ];
  for (const txt of alien) {
    expect(TRIGGER_TYPES.filter((t) => likeToRe(PARITY_PATTERNS[t]).test(txt))).toEqual([]);
  }
});

test('PARITY_PATTERNS: «отменена» не привязана к эмодзи ❌ (шаблон могут поменять)', () => {
  expect(likeToRe(PARITY_PATTERNS.record_cancelled).test('Ваша запись в «PERI CLINIC» 01.09.2026 в 13:00 отменена')).toBe(true);
});

// ───────────────────────── чистые помощники вложения ─────────────────────────

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);

test('sniffImageExt: расширение — по сигнатуре содержимого; GIF и мусор не поддерживаются', () => {
  expect(sniffImageExt(JPEG)).toBe('.jpg');
  expect(sniffImageExt(PNG)).toBe('.png');
  expect(sniffImageExt(WEBP)).toBe('.webp');
  expect(sniffImageExt(GIF)).toBeNull();     // воркер знает MIME только jpg/png/webp/pdf
  expect(sniffImageExt(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  expect(sniffImageExt(Buffer.alloc(2))).toBeNull();
  expect(sniffImageExt('not a buffer')).toBeNull();
  expect(sniffImageExt(null)).toBeNull();
});

test('ownAttachmentFile: только наши notify_<салон>_<правило>_<ts>.<jpg|png|webp>', () => {
  expect(ownAttachmentFile('/uploads/notify_1_5_1760000000000.jpg')).toBe('notify_1_5_1760000000000.jpg');
  expect(ownAttachmentFile('/uploads/notify_12_345_1760000000000.webp')).toBe('notify_12_345_1760000000000.webp');
  for (const bad of [
    '/uploads/notify_seed/Пилинг.jpg',            // сид из выгрузки Chatpush — не файл правила
    '/uploads/portfolio_cat_1_1.jpg',
    '/uploads/app_logo.jpg',
    '/uploads/../notify_1_5_1.jpg',
    '/uploads/notify_1_5_1.jpg/../../x',
    '/uploads/notify_1_5_1.html',
    '/uploads/notify_1_5_1.gif',
    '/uploads/notify_1_5_1.JPG',
    '/uploads/sub/notify_1_5_1.jpg',
    'notify_1_5_1.jpg',
    'https://evil.example/uploads/notify_1_5_1.jpg',
    '', null, undefined, 42, {},
  ]) {
    expect({ bad, r: ownAttachmentFile(bad) }).toEqual({ bad, r: null });
  }
});

// ───────────────────────── роутер: порядок и гард ─────────────────────────

const routeLayers = () => router.stack.filter((l) => l.route);
const methodsOf = (l) => Object.keys(l.route.methods).filter((m) => l.route.methods[m]);

test('порядок: статические пути объявлены РАНЬШЕ маршрутов с :id в первом сегменте (иначе PUT /settings поймает PUT /:id)', () => {
  const layers = routeLayers();
  const firstSeg = (p) => p.split('/')[1] || '';
  const isParam = (l) => firstSeg(l.route.path).startsWith(':');
  const params = layers.map((l, i) => ({ l, i })).filter(({ l }) => isParam(l));
  const statics = layers.map((l, i) => ({ l, i })).filter(({ l }) => !isParam(l) && firstSeg(l.route.path) !== '');
  expect(params.length).toBeGreaterThan(0);

  const expected = ['/settings', '/jobs', '/jobs/:id/cancel', '/ratings', '/parity', '/dictionaries'];
  for (const p of expected) expect(statics.some(({ l }) => l.route.path === p)).toBe(true);

  for (const s of statics) {
    for (const p of params) {
      const shared = methodsOf(s.l).filter((m) => methodsOf(p.l).includes(m));
      if (shared.length) {
        expect({ static: s.l.route.path, param: p.l.route.path, before: s.i < p.i }).toEqual({ static: s.l.route.path, param: p.l.route.path, before: true });
      }
    }
  }
});

// Прогон одного middleware «как Express»: что он ответил и позвал ли next.
function runMw(handle, user) {
  const out = { status: null, nextCalled: false };
  const res = { status(c) { out.status = c; return this; }, json() { return this; } };
  handle({ user }, res, () => { out.nextCalled = true; });
  return out;
}

describe('гард: owner и admin, больше никто', () => {
  test('у каждого маршрута первым стоит auth, вторым — проверка роли, и только потом обработчик', () => {
    const { auth } = require('./middleware/auth');
    for (const l of routeLayers()) {
      expect({ path: l.route.path, n: l.route.stack.length >= 3 }).toEqual({ path: l.route.path, n: true });
      expect({ path: l.route.path, first: l.route.stack[0].handle === auth }).toEqual({ path: l.route.path, first: true });
    }
  });

  test('проверка роли на КАЖДОМ маршруте пускает owner и admin и режет остальных (specialist, admin_cashier, пусто, без user) → 403', () => {
    for (const l of routeLayers()) {
      const mw = l.route.stack[1].handle;
      for (const role of ['owner', 'admin']) {
        expect({ path: l.route.path, role, ...runMw(mw, { role }) }).toEqual({ path: l.route.path, role, status: null, nextCalled: true });
      }
      for (const role of ['specialist', 'admin_cashier', 'superadmin', 'OWNER', '', null, undefined]) {
        expect({ path: l.route.path, role, ...runMw(mw, { role }) }).toEqual({ path: l.route.path, role, status: 403, nextCalled: false });
      }
      expect({ path: l.route.path, ...runMw(mw, undefined) }).toEqual({ path: l.route.path, status: 403, nextCalled: false });
    }
  });
});

// ───────────────────────── HTTP ─────────────────────────

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/notification-rules', router);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/notification-rules`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  mockUser = { salonId: 1, userId: 42, role: 'owner' };
  for (const f of [mockDb.any, mockDb.one, mockDb.oneOrNone, mockDb.query, mockClient.query, mockYcGet, mockSettings.getSettings, mockSettings.updateSettings]) f.mockReset();
  mockWithTx.mockClear();                                    // реализация (fn(mockClient)) остаётся
  for (const f of Object.values(mockLog)) f.mockClear();
});

// То же, но по HTTP через весь стек: специалист не доходит ни до БД, ни до настроек ни на одном маршруте.
describe('гард по HTTP: чужая роль получает 403 на каждом маршруте и ничего не затрагивает', () => {
  const allRoutes = () => routeLayers().flatMap((l) => methodsOf(l).map((m) => [m.toUpperCase(), l.route.path.replace(/:id/g, '5')]));

  test.each(['specialist', 'admin_cashier'])('роль %s', async (role) => {
    mockUser = { salonId: 1, userId: 9, role };
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThan(15);
    for (const [method, p] of routes) {
      const r = await call(method, p === '/' ? '' : p, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect({ method, p, status: r.status }).toEqual({ method, p, status: 403 });
    }
    expect(mockDb.any).not.toHaveBeenCalled();
    expect(mockDb.one).not.toHaveBeenCalled();
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockWithTx).not.toHaveBeenCalled();
    expect(mockSettings.getSettings).not.toHaveBeenCalled();
    expect(mockSettings.updateSettings).not.toHaveBeenCalled();
  });

  test.each(['owner', 'admin'])('роль %s проходит гард', async (role) => {
    mockUser = { salonId: 1, userId: 9, role };
    mockSettings.getSettings.mockResolvedValue({ mode: 'off' });
    expect((await call('GET', '/settings')).status).toBe(200);
  });
});

async function call(method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(`${baseUrl}${p}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Ответ клиента транзакции на UPDATE … RETURNING *: строка правила либо пусто (нет правила / чужой салон).
const txRows = (rule) => ({ rows: rule ? [rule] : [], rowCount: rule ? 1 : 0 });
// Гашение очереди правила — ровно этот запрос (при выключении и при удалении отличается только причина).
function expectCancelSql(sql, reason) {
  expect(String(sql).replace(/\s+/g, ' ').trim())
    .toBe(`UPDATE notification_jobs SET status='cancelled', decision_reason='${reason}' WHERE rule_id=$1 AND salon_id=$2 AND status='pending'`);
}

describe('настройки салона', () => {
  test('GET /settings → сервис настроек', async () => {
    mockSettings.getSettings.mockResolvedValue({ mode: 'off' });
    const r = await call('GET', '/settings');
    expect(r).toEqual({ status: 200, body: { mode: 'off' } });
    expect(mockSettings.getSettings).toHaveBeenCalledWith(1);
  });

  test('PUT /settings доходит до сервиса настроек, а не до PUT /:id', async () => {
    mockSettings.updateSettings.mockResolvedValue({ mode: 'off', default_channels: ['max', 'tdlib'] });
    const patch = { mode: 'off', default_channels: ['max', 'tdlib', 'sms', 'tdlib'], prefer_last_channel: true };
    const r = await call('PUT', '/settings', patch);
    expect(r.status).toBe(200);
    expect(r.body.default_channels).toEqual(['max', 'tdlib']);
    expect(mockSettings.updateSettings).toHaveBeenCalledWith(1, patch);
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();      // обработчик PUT /:id (UPDATE правила) не вызывался
  });

  // Ошибки валидации сервиса настроек — 400 с понятным текстом (раньше чужой mode и не-массив в каскаде молча
  // игнорировались: админ получал 200 при несохранённом переключателе отправки).
  test.each([
    ['BAD_TIME', { quiet_from: '25:00' }, /Тихие часы/],
    ['BAD_MODE', { mode: 'turbo' }, /off, shadow или live/],
    ['BAD_CHANNELS', { default_channels: 'tdlib' }, /массив/],
    ['BAD_PILOT_PHONES', { pilot_phones: '79200255591' }, /Пилотные номера.*массив/],
  ])('PUT /settings: %s → 400 с текстом', async (code, patch, textRe) => {
    mockSettings.updateSettings.mockRejectedValueOnce(Object.assign(new Error('internal ' + code), { code }));
    const r = await call('PUT', '/settings', patch);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(textRe);
    expect(r.body.error).not.toMatch(/internal/);        // сообщение исключения наружу не уходит
  });

  test('PUT /settings: прочие сбои → 500 с общим текстом, подробность — в лог (не в ответ)', async () => {
    mockSettings.updateSettings.mockRejectedValueOnce(new Error('db down: postgres://user:pass@host/db'));
    const r = await call('PUT', '/settings', { mode: 'off' });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Внутренняя ошибка' });
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  test('мусор вместо id → 400, а не уход в БД (PUT /jobs, POST /abc/toggle)', async () => {
    expect((await call('PUT', '/jobs', ok())).status).toBe(400);
    expect((await call('POST', '/abc/toggle')).status).toBe(400);
    expect((await call('DELETE', '/0')).status).toBe(400);
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockWithTx).not.toHaveBeenCalled();
  });
});

describe('правила', () => {
  test('GET / → правила со счётчиками job\'ов и список типов', async () => {
    mockDb.any.mockResolvedValue([{ id: 1, title: 'a', sent_count: 3 }]);
    const r = await call('GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rules: [{ id: 1, title: 'a', sent_count: 3 }], triggerTypes: TRIGGER_TYPES });
    const [sql, params] = mockDb.any.mock.calls[0];
    expect(params).toEqual([1]);
    expect(sql).toMatch(/r\.salon_id = \$1/);
    for (const c of ['sent_count', 'failed_count', 'pending_count', 'shadow_count']) expect(sql).toContain(c);
  });

  test('POST / пишет created_by = req.user.userId (а не req.user.id — его в JWT нет)', async () => {
    mockDb.one.mockResolvedValue({ id: 7 });
    const r = await call('POST', '/', { title: 'Напоминание', triggerType: 'visit_reminder', hoursBefore: 24, messageTemplate: 'Напоминаем о записи {date} в {time}' });
    expect(r).toEqual({ status: 200, body: { ok: true, rule: { id: 7 } } });
    const [sql, params] = mockDb.one.mock.calls[0];
    expect(sql).toMatch(/created_by/);
    expect(params[0]).toBe(1);                       // salon_id
    expect(params[params.length - 1]).toBe(42);      // created_by
    expect(params).toContain('visit_reminder');
    expect(params).toContain(24);
    expect(params.filter((p) => p === undefined)).toEqual([]);
  });

  test('POST / с невалидным телом → 400 без запроса в БД', async () => {
    const r = await call('POST', '/', { title: '', messageTemplate: 'x' });
    expect(r.status).toBe(400);
    expect(mockDb.one).not.toHaveBeenCalled();
  });

  describe('PUT /:id', () => {
    const put = (id, body) => call('PUT', `/${id}`, body);

    test('UPDATE в транзакции и со скоупом по салону; нет такого правила → 404, очередь не трогается', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: true }));
      const good = await put(5, ok({ triggerType: 'visit_review', delayMinutes: 10 }));
      expect(good.status).toBe(200);
      expect(mockWithTx).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toMatch(/UPDATE notification_rules SET/);
      expect(sql).toMatch(/WHERE id=\$1 AND salon_id=\$2/);
      expect(params.slice(0, 2)).toEqual([5, 1]);
      expect(params).toContain('visit_review');
      expect(params).toContain(10);

      mockClient.query.mockReset();
      mockClient.query.mockResolvedValueOnce(txRows(null));
      expect((await put(6, ok())).status).toBe(404);
      expect(mockClient.query).toHaveBeenCalledTimes(1);         // правила нет — гасить нечего
    });

    // Редактор присылает правило целиком, но переключатель «включено» живёт отдельно; прежний дефолт
    // `isEnabled !== false` включал выключенное правило при любой правке текста.
    test('БЕЗ isEnabled выключенное правило не включается: параметр null и is_enabled=COALESCE($4, is_enabled)', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockResolvedValueOnce({ rowCount: 0 });
      const r = await put(5, ok({ triggerType: 'visit_review' }));
      expect(r.status).toBe(200);
      expect(r.body.rule.is_enabled).toBe(false);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toMatch(/is_enabled=COALESCE\(\$4, is_enabled\)/);
      expect(params[3]).toBeNull();
    });

    test('isEnabled:false → параметр false; правило стало выключенным → его pending-очередь гасится («правило выключено»)', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockResolvedValueOnce({ rowCount: 4 });
      const r = await put(5, ok({ isEnabled: false }));
      expect(r.status).toBe(200);
      expect(r.body.cancelledJobs).toBe(4);
      expect(mockClient.query.mock.calls[0][1][3]).toBe(false);
      expectCancelSql(mockClient.query.mock.calls[1][0], 'правило выключено');
      expect(mockClient.query.mock.calls[1][1]).toEqual([5, 1]);
      expect(mockWithTx).toHaveBeenCalledTimes(1);               // UPDATE правила и гашение — одна транзакция
    });

    test('isEnabled:true → параметр true, очередь не трогается', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: true }));
      const r = await put(5, ok({ isEnabled: true }));
      expect(r.status).toBe(200);
      expect(r.body.cancelledJobs).toBe(0);
      expect(mockClient.query.mock.calls[0][1][3]).toBe(true);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    test('правка включённого правила без isEnabled очередь не трогает', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: true }));
      expect((await put(5, ok())).status).toBe(200);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    test('скоуп по салону: у пользователя салона 7 и правка, и гашение идут с salon_id = 7', async () => {
      mockUser = { salonId: 7, userId: 9, role: 'admin' };
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockResolvedValueOnce({ rowCount: 1 });
      await put(5, ok({ isEnabled: false }));
      expect(mockClient.query.mock.calls[0][1].slice(0, 2)).toEqual([5, 7]);
      expect(mockClient.query.mock.calls[1][1]).toEqual([5, 7]);
    });

    test('isEnabled не булево → 400 без транзакции', async () => {
      expect((await put(5, ok({ isEnabled: 'false' }))).status).toBe(400);
      expect(mockWithTx).not.toHaveBeenCalled();
    });

    test('сбой гашения очереди → 500 без ответа об успехе (боевой withTransaction откатит и UPDATE правила)', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockRejectedValueOnce(new Error('deadlock detected'));
      const r = await put(5, ok({ isEnabled: false }));
      expect(r).toEqual({ status: 500, body: { error: 'Внутренняя ошибка' } });
    });
  });

  describe('POST / и isEnabled', () => {
    test('не передан → правило создаётся ВКЛЮЧЁННЫМ (дефолт живёт только в POST); false → выключенным', async () => {
      mockDb.one.mockResolvedValue({ id: 7 });
      await call('POST', '/', ok());
      expect(mockDb.one.mock.calls[0][1][2]).toBe(true);        // $3 is_enabled
      await call('POST', '/', ok({ isEnabled: false }));
      expect(mockDb.one.mock.calls[1][1][2]).toBe(false);
      await call('POST', '/', ok({ isEnabled: true }));
      expect(mockDb.one.mock.calls[2][1][2]).toBe(true);
    });

    test('isEnabled не булево → 400, в БД не пишем', async () => {
      expect((await call('POST', '/', ok({ isEnabled: 'nope' }))).status).toBe(400);
      expect(mockDb.one).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/toggle', () => {
    test('включено → выключено: правило переключено и его pending-очередь погашена одной транзакцией, оба запроса со скоупом по салону', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockResolvedValueOnce({ rowCount: 3 });
      const r = await call('POST', '/5/toggle');
      expect(r).toEqual({ status: 200, body: { ok: true, rule: { id: 5, is_enabled: false }, cancelledJobs: 3 } });
      expect(mockWithTx).toHaveBeenCalledTimes(1);
      const [toggleSql, toggleParams] = mockClient.query.mock.calls[0];
      expect(toggleSql).toMatch(/SET is_enabled = NOT is_enabled/);
      expect(toggleSql).toMatch(/WHERE id=\$1 AND salon_id=\$2/);
      expect(toggleParams).toEqual([5, 1]);
      expectCancelSql(mockClient.query.mock.calls[1][0], 'правило выключено');
      expect(mockClient.query.mock.calls[1][1]).toEqual([5, 1]);
      expect(mockClient.query.mock.invocationCallOrder[0]).toBeLessThan(mockClient.query.mock.invocationCallOrder[1]);
    });

    test('выключено → включено: очередь не трогается (погашенное не воскрешается)', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: true }));
      const r = await call('POST', '/5/toggle');
      expect(r).toEqual({ status: 200, body: { ok: true, rule: { id: 5, is_enabled: true }, cancelledJobs: 0 } });
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    test('нет такого правила (или оно чужого салона) → 404, гасить нечего', async () => {
      mockClient.query.mockResolvedValueOnce(txRows(null));
      expect((await call('POST', '/6/toggle')).status).toBe(404);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    test('скоуп по салону: у пользователя салона 7 переключение и гашение идут с salon_id = 7', async () => {
      mockUser = { salonId: 7, userId: 9, role: 'owner' };
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockResolvedValueOnce({ rowCount: 1 });
      await call('POST', '/5/toggle');
      expect(mockClient.query.mock.calls[0][1]).toEqual([5, 7]);
      expect(mockClient.query.mock.calls[1][1]).toEqual([5, 7]);
    });

    test('сбой гашения очереди → 500, а не «правило выключено» (иначе в журнале осталась бы живая очередь выключенного правила)', async () => {
      mockClient.query.mockResolvedValueOnce(txRows({ id: 5, is_enabled: false })).mockRejectedValueOnce(new Error('connection lost'));
      const r = await call('POST', '/5/toggle');
      expect(r).toEqual({ status: 500, body: { error: 'Внутренняя ошибка' } });
    });
  });

  describe('DELETE /:id', () => {
    // Одна транзакция: блокировка строки правила (параллельная постановка job'а с FK на правило ждёт нас и
    // после коммита получает отказ FK, а не «осиротевший» pending) → гашение pending (после удаления rule_id
    // станет NULL по ON DELETE SET NULL, и найти их по правилу будет нельзя) → удаление.
    test('SELECT … FOR UPDATE → гашение pending («правило удалено») → DELETE, всё в одной транзакции; файл вложения убирается ПОСЛЕ неё', async () => {
      const file = 'notify_1_909091_1760000000001.jpg';
      fs.writeFileSync(path.join(uploadsDir, file), JPEG);
      try {
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ attachment_url: `/uploads/${file}` }], rowCount: 1 })
          .mockResolvedValueOnce({ rowCount: 2 })
          .mockResolvedValueOnce({ rowCount: 1 });
        const r = await call('DELETE', '/909091');
        expect(r).toEqual({ status: 200, body: { ok: true } });
        expect(mockWithTx).toHaveBeenCalledTimes(1);

        const q = mockClient.query.mock.calls;
        expect(q).toHaveLength(3);
        expect(q[0][0]).toMatch(/SELECT attachment_url FROM notification_rules WHERE id=\$1 AND salon_id=\$2 FOR UPDATE/);
        expect(q[0][1]).toEqual([909091, 1]);
        expectCancelSql(q[1][0], 'правило удалено');
        expect(q[1][1]).toEqual([909091, 1]);
        expect(q[2][0]).toMatch(/DELETE FROM notification_rules WHERE id=\$1 AND salon_id=\$2/);
        expect(q[2][1]).toEqual([909091, 1]);
        expect(mockDb.query).not.toHaveBeenCalled();             // вне транзакции ничего не пишется

        expect(await waitUntilGone(path.join(uploadsDir, file))).toBe(true);
      } finally { rmQuiet(path.join(uploadsDir, file)); }
    });

    test('чужое/несуществующее правило → 404: один SELECT, ни гашения, ни удаления', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      expect((await call('DELETE', '/909092')).status).toBe(404);
      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    test('сбой DELETE → 500 и файл вложения НЕ удалён (правило осталось, транзакция откатится)', async () => {
      const file = 'notify_1_909093_1760000000002.jpg';
      fs.writeFileSync(path.join(uploadsDir, file), JPEG);
      try {
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ attachment_url: `/uploads/${file}` }], rowCount: 1 })
          .mockResolvedValueOnce({ rowCount: 1 })
          .mockRejectedValueOnce(new Error('update or delete violates foreign key'));
        const r = await call('DELETE', '/909093');
        expect(r).toEqual({ status: 500, body: { error: 'Внутренняя ошибка' } });
        await new Promise((res) => setTimeout(res, 150));
        expect(fs.existsSync(path.join(uploadsDir, file))).toBe(true);
      } finally { rmQuiet(path.join(uploadsDir, file)); }
    });

    // Файл правила убирается только когда транзакция реально зафиксирована: упавший COMMIT откатывает DELETE,
    // правило остаётся и должно сохранить свою картинку (unlink необратим).
    test('сбой КОММИТА после успешного DELETE → 500, файл вложения НЕ удалён', async () => {
      const file = 'notify_1_909094_1760000000003.jpg';
      fs.writeFileSync(path.join(uploadsDir, file), JPEG);
      try {
        mockClient.query
          .mockResolvedValueOnce({ rows: [{ attachment_url: `/uploads/${file}` }], rowCount: 1 })
          .mockResolvedValue({ rowCount: 1 });
        mockWithTx.mockImplementationOnce(async (fn) => { await fn(mockClient); throw new Error('could not serialize access'); });
        const r = await call('DELETE', '/909094');
        expect(r).toEqual({ status: 500, body: { error: 'Внутренняя ошибка' } });
        expect(mockClient.query).toHaveBeenCalledTimes(3);       // все три запроса выполнены, упал именно коммит
        await new Promise((res) => setTimeout(res, 150));
        expect(fs.existsSync(path.join(uploadsDir, file))).toBe(true);
      } finally { rmQuiet(path.join(uploadsDir, file)); }
    });

    test('скоуп по салону: у пользователя салона 7 все три запроса идут с salon_id = 7', async () => {
      mockUser = { salonId: 7, userId: 9, role: 'owner' };
      mockClient.query.mockResolvedValueOnce({ rows: [{ attachment_url: null }], rowCount: 1 }).mockResolvedValue({ rowCount: 0 });
      await call('DELETE', '/5');
      expect(mockClient.query.mock.calls.map((c) => c[1])).toEqual([[5, 7], [5, 7], [5, 7]]);
    });
  });

  test('GET /:id/jobs: журнал одного правила, скоуп по салону, лимит ограничен', async () => {
    mockDb.any.mockResolvedValue([{ id: 1 }]);
    expect((await call('GET', '/5/jobs?limit=9999')).body).toEqual({ items: [{ id: 1 }] });
    expect(mockDb.any.mock.calls[0][1]).toEqual([5, 1, 200]);
    await call('GET', '/5/jobs?limit=abc');
    expect(mockDb.any.mock.calls[1][1]).toEqual([5, 1, 50]);
    const sql = mockDb.any.mock.calls[0][0];
    expect(sql).toMatch(/j\.rule_id = \$1 AND j\.salon_id = \$2/);
    for (const c of ['trigger_type', 'scheduled_at', 'decision_reason', 'confirmed_at']) expect(sql).toContain(c);
  });
});

describe('справочники', () => {
  test('GET /dictionaries: специалисты из БД, категории/услуги из YClients', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce({ id: 1, yclients_company_id: 77 });
    mockDb.any.mockResolvedValueOnce([{ id: 5, name: 'Юлия', specialization: 'косметолог' }]);
    mockYcGet.mockImplementation(async (salon, p) => (p.startsWith('/service_categories')
      ? [{ id: 1, title: 'Лазер', extra: 'x' }] : [{ id: 9, title: 'Эпиляция', category_id: 1, extra: 'y' }]));
    const r = await call('GET', '/dictionaries');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      staff: [{ id: 5, name: 'Юлия', specialization: 'косметолог' }],
      categories: [{ id: 1, title: 'Лазер' }],
      services: [{ id: 9, title: 'Эпиляция', category_id: 1 }],
    });
    expect(Array.isArray(r.body.channels)).toBe(true);
    expect(mockDb.oneOrNone.mock.calls[0][1]).toEqual([1]);
    expect(mockDb.any.mock.calls[0][1]).toEqual([1]);
  });

  test('GET /dictionaries: нет салона → 404', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce(null);
    expect((await call('GET', '/dictionaries')).status).toBe(404);
  });
});

describe('журнал job\'ов', () => {
  test('GET /jobs: фильтры валидируются, мусор игнорируется, запрос скоупится салоном', async () => {
    mockDb.any.mockResolvedValue([{ id: 1 }]);
    const r = await call('GET', '/jobs?type=visit_review&status=shadow&date=2026-10-14&page=2');
    expect(r.body).toEqual({ items: [{ id: 1 }], page: 2 });
    const [sql, params] = mockDb.any.mock.calls[0];
    expect(params).toEqual([1, 'visit_review', 'shadow', '2026-10-14', 200]);
    expect(sql).toMatch(/j\.salon_id = \$1/);

    await call('GET', '/jobs?type=birthday&status=zzz&date=14.10.2026&page=-5');
    expect(mockDb.any.mock.calls[1][1]).toEqual([1, null, null, null, 0]);
  });

  // Регэксп YYYY-MM-DD пропускает '2026-02-31', а `$4::date` в PG на нём падает → раньше был 500.
  // Несуществующая дата, как и неверный формат, просто не включает фильтр.
  test.each(['2026-02-31', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32', '0000-01-01', '0050-01-01'])(
    'GET /jobs?date=%s — несуществующая календарная дата: фильтр не включается, ответ 200 (не 500)', async (date) => {
      mockDb.any.mockResolvedValue([]);
      const r = await call('GET', `/jobs?date=${date}`);
      expect(r.status).toBe(200);
      expect(mockDb.any.mock.calls[0][1][3]).toBeNull();
    });

  test.each(['2026-02-28', '2024-02-29', '2026-12-31', '2026-01-01'])('GET /jobs?date=%s — настоящая дата проходит в запрос как есть', async (date) => {
    mockDb.any.mockResolvedValue([]);
    expect((await call('GET', `/jobs?date=${date}`)).status).toBe(200);
    expect(mockDb.any.mock.calls[0][1][3]).toBe(date);
  });

  test('POST /jobs/:id/cancel: гасит только pending своего салона', async () => {
    mockDb.query.mockResolvedValueOnce({ rowCount: 1 });
    expect((await call('POST', '/jobs/12/cancel')).body).toEqual({ ok: true });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(params).toEqual([12, 1]);
    expect(sql).toMatch(/status\s*=\s*'cancelled'/);
    expect(sql).toMatch(/salon_id=\$2 AND status='pending'/);

    mockDb.query.mockResolvedValueOnce({ rowCount: 0 });
    expect((await call('POST', '/jobs/13/cancel')).body).toEqual({ ok: false });
    expect((await call('POST', '/jobs/abc/cancel')).status).toBe(400);
  });
});

describe('оценки и паритет', () => {
  test('GET /ratings: список и сводка за 30 дней, оба запроса по салону', async () => {
    mockDb.any.mockResolvedValueOnce([{ id: 1, rating: 5 }]);
    mockDb.oneOrNone.mockResolvedValueOnce({ n: 1, avg: 5, high: 1, low: 0 });
    const r = await call('GET', '/ratings');
    expect(r.body).toEqual({ items: [{ id: 1, rating: 5 }], stats: { n: 1, avg: 5, high: 1, low: 0 } });
    expect(mockDb.any.mock.calls[0][1]).toEqual([1]);
    expect(mockDb.oneOrNone.mock.calls[0][1]).toEqual([1]);
  });

  test('GET /parity: семь типов по порядку, пропущенные — нули; тестовые отправки в «наших» не считаются', async () => {
    mockDb.any.mockResolvedValueOnce([{ trigger_type: 'visit_review', planned: 4, skipped: 1, cancelled: 2 }]);
    mockDb.oneOrNone.mockResolvedValueOnce({ record_created: 9, visit_review: 5 });
    const r = await call('GET', '/parity?days=3');
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(3);
    expect(r.body.items.map((i) => i.triggerType)).toEqual(TRIGGER_TYPES);
    expect(r.body.items.find((i) => i.triggerType === 'visit_review')).toEqual({ triggerType: 'visit_review', ours: { planned: 4, skipped: 1, cancelled: 2 }, chatpush: 5 });
    expect(r.body.items.find((i) => i.triggerType === 'record_created')).toEqual({ triggerType: 'record_created', ours: { planned: 0, skipped: 0, cancelled: 0 }, chatpush: 9 });
    expect(r.body.items.find((i) => i.triggerType === 'first_visit').chatpush).toBe(0);

    const [oursSql, oursParams] = mockDb.any.mock.calls[0];
    expect(oursParams).toEqual([1, 3]);
    expect(oursSql).toMatch(/meta->>'test'/);
    const [theirsSql, theirsParams] = mockDb.oneOrNone.mock.calls[0];
    expect(theirsParams).toEqual([1, 3, ...TRIGGER_TYPES.map((t) => PARITY_PATTERNS[t])]);
    expect(theirsSql).toMatch(/authored_by = 'system'/);
    // Фильтра по provider нет: уведомления YClients в Telegram приходят эхом через наш шлюз (provider = gateway/NULL).
    expect(theirsSql).not.toMatch(/provider/);
  });

  test('GET /parity: days ограничен 1..60, по умолчанию 7', async () => {
    mockDb.any.mockResolvedValue([]);
    mockDb.oneOrNone.mockResolvedValue(null);
    expect((await call('GET', '/parity?days=1000')).body.days).toBe(60);
    expect((await call('GET', '/parity?days=-3')).body.days).toBe(1);
    expect((await call('GET', '/parity?days=abc')).body.days).toBe(7);
    expect((await call('GET', '/parity')).body.days).toBe(7);
  });
});

// Тело 500 видит владелец салона (и любой, кто украл его токен): строка подключения, имя таблицы, текст
// драйвера в ответе не нужны. Общий текст наружу, подробность — в лог (как routes/reminders.js, routes/care.js).
describe('500 без внутренностей: общий текст в ответе, подробность — в лог', () => {
  const LEAK = 'SECRET postgres://user:pass@10.0.0.5/loyalpro password authentication failed';
  const boom = () => new Error(LEAK);
  const rejected = (fn) => () => fn().mockRejectedValue(boom());
  const cases = [
    ['GET /settings', 'GET', '/settings', undefined, rejected(() => mockSettings.getSettings)],
    ['GET /jobs', 'GET', '/jobs', undefined, rejected(() => mockDb.any)],
    ['POST /jobs/:id/cancel', 'POST', '/jobs/5/cancel', undefined, rejected(() => mockDb.query)],
    ['GET /ratings', 'GET', '/ratings', undefined, rejected(() => mockDb.any)],
    ['GET /parity', 'GET', '/parity', undefined, rejected(() => mockDb.any)],
    ['GET /dictionaries', 'GET', '/dictionaries', undefined, rejected(() => mockDb.oneOrNone)],
    ['GET /', 'GET', '/', undefined, rejected(() => mockDb.any)],
    ['POST /', 'POST', '/', { title: 'r', messageTemplate: 'x' }, rejected(() => mockDb.one)],
    ['PUT /:id', 'PUT', '/5', { title: 'r', messageTemplate: 'x' }, () => mockWithTx.mockRejectedValueOnce(boom())],
    ['POST /:id/toggle', 'POST', '/5/toggle', undefined, () => mockWithTx.mockRejectedValueOnce(boom())],
    ['DELETE /:id', 'DELETE', '/5', undefined, () => mockWithTx.mockRejectedValueOnce(boom())],
    ['GET /:id/jobs', 'GET', '/5/jobs', undefined, rejected(() => mockDb.any)],
    ['DELETE /:id/attachment', 'DELETE', '/5/attachment', undefined, rejected(() => mockDb.oneOrNone)],
    ['POST /:id/test', 'POST', '/5/test', { phone: '79200255591' }, rejected(() => mockDb.oneOrNone)],
  ];

  test.each(cases)('%s', async (_name, method, p, body, arrange) => {
    arrange();
    const r = await call(method, p, body);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Внутренняя ошибка' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('SECRET'));      // подробность осталась в логе
  });

  test('POST /:id/attachment', async () => {
    mockDb.oneOrNone.mockRejectedValue(boom());
    const r = await upload(5, JPEG, 'a.jpg', 'image/jpeg');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Внутренняя ошибка' });
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('SECRET'));
  });
});

describe('POST /:id/test', () => {
  const RULE = { id: 5, title: 'Напоминание', trigger_type: 'visit_reminder', message_template: 'Напоминаем о записи {date} в {time}', attachment_url: null };

  // Всё, что оставляет после себя прошлая попытка тестовой отправки того же правила, должно быть сброшено.
  const RESET_COLS = ['status', 'scheduled_at', 'phone', 'rendered_text', 'attachment_url', 'attempts', 'error', 'sent_at',
    'channel_used', 'delivery_id', 'account_id', 'check_at', 'confirmed_at', 'cascade_pos', 'routing', 'cascade_log',
    'decision_reason', 'last_attempt_at'];

  test('ON CONFLICT по индексу (rule_id, record, visit) и DO UPDATE сбрасывает ВСЕ поля прошлой попытки', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce(RULE);
    mockSettings.getSettings.mockResolvedValue({ mode: 'shadow' });
    mockDb.one.mockResolvedValueOnce({ id: 99 });
    const r = await call('POST', '/5/test', { phone: '8 (920) 025-55-91' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, jobId: 99, mode: 'shadow' });

    const [sql, params] = mockDb.one.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(rule_id, yclients_record_id, COALESCE\(visit_datetime, 'epoch'::timestamptz\)\) DO UPDATE SET/);
    const setPart = sql.slice(sql.indexOf('DO UPDATE SET'));
    for (const col of RESET_COLS) expect({ col, reset: new RegExp(`\\b${col}\\s*=`).test(setPart) }).toEqual({ col, reset: true });
    expect(setPart).toMatch(/\bstatus\s*=\s*'pending'/);
    expect(setPart).toMatch(/\battempts\s*=\s*0\b/);
    expect(setPart).toMatch(/\bcascade_pos\s*=\s*0\b/);
    expect(setPart).toMatch(/\bcascade_log\s*=\s*'\[\]'::jsonb/);
    expect(setPart).toMatch(/\bscheduled_at\s*=\s*NOW\(\)/);
    expect(setPart).toMatch(/\bdecision_reason\s*=\s*'тестовая отправка'/);
    // Правило могли переименовать/перевести на другой тип со времени прошлого теста.
    for (const col of ['rule_title', 'trigger_type', 'meta']) expect(setPart).toMatch(new RegExp(`\\b${col}\\s*=`));

    expect(params[0]).toBe(1);                      // salon_id
    expect(params).toContain(5);                    // rule_id
    expect(params).toContain('79200255591');        // номер нормализован: 8→7, только цифры
    const text = params.find((p) => typeof p === 'string' && p.startsWith('Напоминаем'));
    expect(text).toBe('Напоминаем о записи 31.12.2026 в 12:00');   // плейсхолдеры подставлены
  });

  test('вложение правила уходит в тестовый job', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce({ ...RULE, attachment_url: '/uploads/notify_1_5_1760000000000.jpg' });
    mockSettings.getSettings.mockResolvedValue({ mode: 'live' });
    mockDb.one.mockResolvedValueOnce({ id: 100 });
    await call('POST', '/5/test', { phone: '79200255591' });
    expect(mockDb.one.mock.calls[0][1]).toContain('/uploads/notify_1_5_1760000000000.jpg');
  });

  test('ответ прямо говорит, что произойдёт в shadow и в live', async () => {
    const note = async (mode) => {
      mockDb.oneOrNone.mockResolvedValueOnce(RULE);
      mockSettings.getSettings.mockResolvedValueOnce({ mode });
      mockDb.one.mockResolvedValueOnce({ id: 1 });
      const r = await call('POST', '/5/test', { phone: '79200255591' });
      expect(r.status).toBe(200);
      return r.body.note;
    };
    expect(await note('live')).toMatch(/10 с/);
    expect(await note('shadow')).toMatch(/без отправки/);
  });

  test('shadow + номер в pilot_phones → ответ говорит, что тест РЕАЛЬНО уйдёт', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce(RULE);
    mockSettings.getSettings.mockResolvedValueOnce({ mode: 'shadow', pilot_phones: ['79200255591'] });
    mockDb.one.mockResolvedValueOnce({ id: 1 });
    const r = await call('POST', '/5/test', { phone: '8 920 025-55-91' });
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/пилот/);
    expect(r.body.note).toMatch(/10 с/);
    expect(r.body.note).not.toMatch(/без отправки/);
  });

  // Воркер не арендует строки салонов в off: тест висел бы pending, а у meta.test нет проверки давности
  // «по записи» — он ушёл бы при включении боевого режима сколько угодно позже. Поэтому строки нет вовсе.
  test.each(['off', 'weird', '', null, undefined, 'constructor', 'toString'])('режим %p → 409 с понятным текстом, строка НЕ создаётся', async (mode) => {
    mockDb.oneOrNone.mockResolvedValueOnce(RULE);
    mockSettings.getSettings.mockResolvedValueOnce({ mode });
    const r = await call('POST', '/5/test', { phone: '79200255591' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Модуль выключен: тестовая отправка не уйдёт. Переключите режим в «тень» (текст попадёт в журнал) или «боевой»');
    expect(mockDb.one).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('409 не мешает 400/404: плохой номер и чужое правило отвечают как раньше, режим не читается', async () => {
    expect((await call('POST', '/5/test', { phone: '123' })).status).toBe(400);
    mockDb.oneOrNone.mockResolvedValueOnce(null);
    expect((await call('POST', '/5/test', { phone: '79200255591' })).status).toBe(404);
    expect(mockSettings.getSettings).not.toHaveBeenCalled();
  });

  test('номер не 11 цифр с 7 → 400, правило не ищется; чужое правило → 404, job не создаётся', async () => {
    for (const phone of ['', '123', '89200255591 доб. 5', '+1 650 253 0000', undefined]) {
      const r = await call('POST', '/5/test', { phone });
      expect({ phone, status: r.status }).toEqual({ phone, status: 400 });
    }
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();

    mockDb.oneOrNone.mockResolvedValueOnce(null);
    expect((await call('POST', '/6/test', { phone: '79200255591' })).status).toBe(404);
    expect(mockDb.one).not.toHaveBeenCalled();
    expect(mockDb.oneOrNone.mock.calls[0][1]).toEqual([6, 1]);
  });
});

// ───────────────────────── вложение ─────────────────────────

const RULE_ID = 909090;     // заведомо не существующее на деве правило: тесты пишут в настоящий frontend/uploads

function rmQuiet(f) { try { fs.unlinkSync(f); } catch (_) { /* уже нет */ } }
function mine() { return fs.readdirSync(uploadsDir).filter((f) => f.startsWith(`notify_1_${RULE_ID}_`)); }
async function waitUntilGone(filePath, timeoutMs = 1500) {
  const start = Date.now();
  while (fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}
async function upload(id, buffer, filename, mime, field = 'file') {
  const fd = new FormData();
  fd.append(field, new Blob([buffer], { type: mime }), filename);
  const r = await fetch(`${baseUrl}/${id}/attachment`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('POST /:id/attachment', () => {
  afterEach(() => { for (const f of mine()) rmQuiet(path.join(uploadsDir, f)); });

  test('JPEG: имя notify_<салон>_<правило>_<ts>.jpg, файл на диске, правило обновлено, pending-job\'ы перенацелены', async () => {
    const oldName = `notify_1_${RULE_ID}_1.jpg`;
    fs.writeFileSync(path.join(uploadsDir, oldName), JPEG);
    mockDb.oneOrNone.mockResolvedValueOnce({ attachment_url: `/uploads/${oldName}` });
    mockDb.query.mockResolvedValue({ rowCount: 1 });

    // Кириллица в имени — отображаемая подпись, на имя файла на диске влиять не должна.
    const r = await upload(RULE_ID, JPEG, 'Ботулинотерапия.jpg', 'image/jpeg');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.attachmentUrl).toMatch(new RegExp(`^/uploads/notify_1_${RULE_ID}_\\d+\\.jpg$`));

    const abs = path.join(uploadsDir, path.basename(r.body.attachmentUrl));
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs).equals(JPEG)).toBe(true);

    const [updSql, updParams] = mockDb.query.mock.calls[0];
    expect(updSql).toMatch(/UPDATE notification_rules SET attachment_url=\$3, attachment_name=\$4/);
    expect(updSql).toMatch(/WHERE id=\$1 AND salon_id=\$2/);
    expect(updParams).toEqual([RULE_ID, 1, r.body.attachmentUrl, 'Ботулинотерапия.jpg']);

    // pending-job'ы с прежним файлом получают новый, иначе воркер упал бы на «файл вложения не найден»
    const [jobSql, jobParams] = mockDb.query.mock.calls[1];
    expect(jobSql).toMatch(/UPDATE notification_jobs SET attachment_url=\$3/);
    expect(jobSql).toMatch(/status\s*=\s*'pending'/);
    expect(jobParams).toEqual([RULE_ID, 1, r.body.attachmentUrl, `/uploads/${oldName}`]);

    expect(await waitUntilGone(path.join(uploadsDir, oldName))).toBe(true);   // старый файл убран
  });

  test('расширение берётся из СИГНАТУРЫ, а не из имени клиента: «photo.jpeg» с JPEG внутри → .jpg; PNG → .png; WebP → .webp', async () => {
    mockDb.oneOrNone.mockResolvedValue({ attachment_url: null });
    mockDb.query.mockResolvedValue({ rowCount: 1 });
    const jpeg = await upload(RULE_ID, JPEG, 'photo.JPEG', 'image/jpeg');
    expect(jpeg.body.attachmentUrl).toMatch(/\.jpg$/);
    await new Promise((r) => setTimeout(r, 5));       // другой ts в имени
    const png = await upload(RULE_ID, PNG, 'a.png', 'image/png');
    expect(png.body.attachmentUrl).toMatch(/\.png$/);
    await new Promise((r) => setTimeout(r, 5));
    const webp = await upload(RULE_ID, WEBP, 'a.webp', 'image/webp');
    expect(webp.body.attachmentUrl).toMatch(/\.webp$/);
  });

  test('GIF → 400 (воркер не знает его MIME), файл не пишется, БД не трогается', async () => {
    const r = await upload(RULE_ID, GIF, 'a.gif', 'image/gif');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/JPEG|PNG|WEBP/);
    expect(mine()).toEqual([]);
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('содержимое не картинка / не совпадает с расширением / не тот mime → 400', async () => {
    expect((await upload(RULE_ID, Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', 'image/jpeg')).status).toBe(400);
    expect((await upload(RULE_ID, PNG, 'x.jpg', 'image/jpeg')).status).toBe(400);          // PNG под видом jpg
    expect((await upload(RULE_ID, JPEG, 'x.html', 'image/jpeg')).status).toBe(400);        // расширение
    expect((await upload(RULE_ID, JPEG, 'x.jpg', 'text/html')).status).toBe(400);          // mimetype
    expect(mine()).toEqual([]);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('больше 5 МБ → 400 с понятным текстом', async () => {
    const big = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(5 * 1024 * 1024 + 10, 1)]);
    const r = await upload(RULE_ID, big, 'big.jpg', 'image/jpeg');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/5 МБ/);
    expect(mine()).toEqual([]);
  });

  test('нет файла в поле file → 400', async () => {
    const r = await upload(RULE_ID, JPEG, 'a.jpg', 'image/jpeg', 'other');
    expect(r.status).toBe(400);
    expect(mine()).toEqual([]);
  });

  test('id правила — только целое: мусор → 400 ДО разбора файла и обращения к БД; чужое правило → 404 без файла', async () => {
    for (const bad of ['abc', '0', '1.5', '99999999999', '1e3', '-4']) {
      const r = await upload(bad, JPEG, 'a.jpg', 'image/jpeg');
      expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
    }
    expect(mockDb.oneOrNone).not.toHaveBeenCalled();

    mockDb.oneOrNone.mockResolvedValueOnce(null);
    const r = await upload(RULE_ID, JPEG, 'a.jpg', 'image/jpeg');
    expect(r.status).toBe(404);
    expect(mockDb.oneOrNone.mock.calls[0][1]).toEqual([RULE_ID, 1]);
    expect(mine()).toEqual([]);
  });

  test('сбой UPDATE правила → 500, новый файл убран, старый НЕ тронут', async () => {
    const oldName = `notify_1_${RULE_ID}_2.jpg`;
    fs.writeFileSync(path.join(uploadsDir, oldName), JPEG);
    mockDb.oneOrNone.mockResolvedValueOnce({ attachment_url: `/uploads/${oldName}` });
    mockDb.query.mockRejectedValueOnce(new Error('db down'));
    const r = await upload(RULE_ID, PNG, 'a.png', 'image/png');
    expect(r.status).toBe(500);
    await new Promise((res) => setTimeout(res, 100));
    expect(mine()).toEqual([oldName]);         // остался только прежний
  });

  test('сбой перенацеливания pending-job\'ов: старый файл остаётся (job\'ы на него ещё ссылаются), ответ 200', async () => {
    const oldName = `notify_1_${RULE_ID}_3.jpg`;
    fs.writeFileSync(path.join(uploadsDir, oldName), JPEG);
    mockDb.oneOrNone.mockResolvedValueOnce({ attachment_url: `/uploads/${oldName}` });
    mockDb.query.mockResolvedValueOnce({ rowCount: 1 }).mockRejectedValueOnce(new Error('db hiccup'));
    const r = await upload(RULE_ID, PNG, 'a.png', 'image/png');
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    expect(mine()).toContain(oldName);
    expect(mine().length).toBe(2);
  });
});

describe('DELETE /:id/attachment', () => {
  afterEach(() => { for (const f of mine()) rmQuiet(path.join(uploadsDir, f)); });

  test('чистит ссылку в правиле, у pending-job\'ов и удаляет СВОЙ файл', async () => {
    const name = `notify_1_${RULE_ID}_4.png`;
    fs.writeFileSync(path.join(uploadsDir, name), PNG);
    mockDb.oneOrNone.mockResolvedValueOnce({ attachment_url: `/uploads/${name}` });
    mockDb.query.mockResolvedValue({ rowCount: 1 });
    const r = await call('DELETE', `/${RULE_ID}/attachment`);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/attachment_url=NULL, attachment_name=NULL/);
    expect(params).toEqual([RULE_ID, 1]);
    const [jobSql, jobParams] = mockDb.query.mock.calls[1];
    expect(jobSql).toMatch(/UPDATE notification_jobs SET attachment_url=\$3/);
    expect(jobSql).toMatch(/status\s*=\s*'pending'/);
    expect(jobParams).toEqual([RULE_ID, 1, null, `/uploads/${name}`]);     // вложения больше нет → job уйдёт текстом
    expect(await waitUntilGone(path.join(uploadsDir, name))).toBe(true);
  });

  test('чужой файл (не notify_…) по ссылке из БД НЕ удаляется', async () => {
    const keep = `kb_keep_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, keep), JPEG);
    try {
      mockDb.oneOrNone.mockResolvedValueOnce({ attachment_url: `/uploads/${keep}` });
      mockDb.query.mockResolvedValue({ rowCount: 1 });
      const r = await call('DELETE', `/${RULE_ID}/attachment`);
      expect(r.status).toBe(200);
      await new Promise((res) => setTimeout(res, 150));
      expect(fs.existsSync(path.join(uploadsDir, keep))).toBe(true);
    } finally { rmQuiet(path.join(uploadsDir, keep)); }
  });

  test('нет такого правила → 404; мусорный id → 400', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce(null);
    expect((await call('DELETE', `/${RULE_ID}/attachment`)).status).toBe(404);
    expect((await call('DELETE', '/abc/attachment')).status).toBe(400);
  });
});
