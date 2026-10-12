'use strict';

jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn() } }));

const { db } = require('./db');
const authorship = require('./services/outgoing-authorship');

beforeEach(() => jest.clearAllMocks());

describe('textKey', () => {
  const { textKey } = authorship;
  test('одинаковый текст → одинаковый ключ', () => {
    expect(textKey('Записала вас на 19:15')).toBe(textKey('Записала вас на 19:15'));
  });
  test('пробелы и перенос строки не считаются различием (Chatpush их нормализует)', () => {
    expect(textKey('Записала вас\nна 19:15')).toBe(textKey('Записала вас на 19:15'));
    expect(textKey('  Записала вас на 19:15  ')).toBe(textKey('Записала вас на 19:15'));
  });
  test('разный текст → разный ключ', () => {
    expect(textKey('Записала вас')).not.toBe(textKey('Записала её'));
  });
  test('пустой текст ключа не даёт (иначе все пустые эхо стали бы «нашими»)', () => {
    expect(textKey('')).toBeNull();
    expect(textKey('   ')).toBeNull();
    expect(textKey(null)).toBeNull();
  });
});

describe('remember', () => {
  test('пишет строку с автором и ключом текста', async () => {
    await authorship.remember(1, '79001112233', 'Записала вас на 19:15', 'agent');
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO outgoing_authored/i);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe('79001112233');
    expect(params[2]).toBe(authorship.textKey('Записала вас на 19:15'));
    expect(params[3]).toBe('agent');
  });

  test('пустой текст не пишем', async () => {
    await authorship.remember(1, 'k', '   ', 'agent');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('сбой БД не бросает наружу (отправка уже состоялась)', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(authorship.remember(1, 'k', 'текст', 'agent')).resolves.toBeUndefined();
  });
});

describe('classify', () => {
  test('текст найден в журнале наших отправок → его автор', async () => {
    db.oneOrNone.mockResolvedValue({ author: 'agent' });
    expect(await authorship.classify(1, 'Записала вас на 19:15')).toBe('agent');
  });

  test('автоуведомление помечается system, а не agent', async () => {
    db.oneOrNone.mockResolvedValue({ author: 'system' });
    expect(await authorship.classify(1, 'Вы записаны на прием 04.08.2026')).toBe('system');
  });

  // Инцидент 2026-08-04: администратор вёл диалог из приложения MAX, его реплики
  // приходили эхом и были неотличимы от реплик Милы.
  test('текста в журнале нет → писал живой человек', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await authorship.classify(1, 'В 19:15 удобно было бы?')).toBe('operator');
  });

  // Инцидент 2026-08-04 (79200255591): после успешной записи YClients сам шлёт
  // клиенту «Вы записаны на прием…» через ТОТ ЖЕ инстанс Chatpush. В нашем журнале
  // такого текста нет — и Мила замолкала на собственном успехе, как будто в диалог
  // вошёл человек. Отличаем по delivery_id: он есть у всего, что ушло через API.
  test('чужой интеграции (есть delivery_id) — system, а не operator', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await authorship.classify(1, 'Вы записаны на прием 05.08.2026 12:00', { viaApi: true })).toBe('system');
  });

  test('живой набор в приложении (delivery_id нет) — по-прежнему operator', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await authorship.classify(1, 'В 19:15 удобно было бы?', { viaApi: false })).toBe('operator');
  });

  test('журнал главнее delivery_id: наш же текст остаётся operator (отправка из админки)', async () => {
    db.oneOrNone.mockResolvedValue({ author: 'operator' });
    expect(await authorship.classify(1, 'на завтра можно', { viaApi: true })).toBe('operator');
  });

  test('пустой текст → null (файлы и стикеры не классифицируем)', async () => {
    expect(await authorship.classify(1, '')).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('БД недоступна → null, а НЕ operator (иначе глушили бы Милу на её же эхо)', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect(await authorship.classify(1, 'любой текст')).toBeNull();
  });
});

describe('classify: эхо своего шлюза без delivery_id (инцидент 2026-10-12)', () => {
  const tpl = 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5';
  // Первый oneOrNone — журнал outgoing_authored, второй — сверка с шаблонами салона.
  const journal = (row) => db.oneOrNone.mockResolvedValueOnce(row);
  const templates = (row) => db.oneOrNone.mockResolvedValueOnce(row);

  test('gateway + текст совпал с шаблоном автоуведомления салона → system (пауза не ставится)', async () => {
    journal(null); templates({ ok: 1 });
    expect(await authorship.classify(1, tpl, { provider: 'gateway' })).toBe('system');
    const [sql, params] = db.oneOrNone.mock.calls[1];
    expect(sql).toMatch(/FROM chatpush_messages/);
    expect(sql).toMatch(/authored_by = 'system'/);
    expect(sql).toMatch(/provider IS DISTINCT FROM 'gateway'/);
    expect(sql).toMatch(/regexp_replace/);
    expect(params).toEqual([1, tpl]);
  });

  test('gateway + шаблон не найден → operator, как раньше', async () => {
    journal(null); templates(null);
    expect(await authorship.classify(1, 'Добрый день! Да, 14:00 свободно', { provider: 'gateway' })).toBe('operator');
  });

  test('chatpush без delivery_id → operator БЕЗ сверки с шаблонами (там признак структурный)', async () => {
    journal(null);
    expect(await authorship.classify(1, tpl, { provider: 'chatpush' })).toBe('operator');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  });

  test('gateway + delivery_id → system без сверки с шаблонами (своя отправка через шлюз)', async () => {
    journal(null);
    expect(await authorship.classify(1, 'любой текст', { provider: 'gateway', viaApi: true })).toBe('system');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  });

  test('журнал главнее шаблонов: наш оператор из админки → operator', async () => {
    journal({ author: 'operator' });
    expect(await authorship.classify(1, tpl, { provider: 'gateway' })).toBe('operator');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  });

  test('сбой БД в сверке шаблонов → operator (fail-closed: лишняя пауза, а не Мила поверх человека)', async () => {
    journal(null); db.oneOrNone.mockRejectedValueOnce(new Error('db down'));
    expect(await authorship.classify(1, tpl, { provider: 'gateway' })).toBe('operator');
  });

  test('без provider поведение прежнее: operator, одна выборка', async () => {
    journal(null);
    expect(await authorship.classify(1, tpl)).toBe('operator');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  });
});
