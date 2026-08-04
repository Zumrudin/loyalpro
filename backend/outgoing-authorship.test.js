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

  test('пустой текст → null (файлы и стикеры не классифицируем)', async () => {
    expect(await authorship.classify(1, '')).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('БД недоступна → null, а НЕ operator (иначе глушили бы Милу на её же эхо)', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect(await authorship.classify(1, 'любой текст')).toBeNull();
  });
});
