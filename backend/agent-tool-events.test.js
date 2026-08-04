'use strict';

jest.mock('./db', () => ({ db: { query: jest.fn(), any: jest.fn(), oneOrNone: jest.fn() } }));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLogger }));

const { db } = require('./db');
const toolEvents = require('./services/agent/tool-events');

beforeEach(() => jest.clearAllMocks());

describe('createBuffer / flush', () => {
  test('флаш пишет одним INSERT все события попытки с общим turn_id', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const buf = toolEvents.createBuffer(7, '79001112233');
    buf.push('get_available_slots', { date: '2026-08-05' }, { slots: [{ time: '10:00' }] }, false);
    buf.push('create_booking', { datetime: 'x' }, { error: 'занято' }, true);
    await buf.flush(null);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_tool_events/i);
    expect(sql).toMatch(/salon_id, dialog_key, turn_id, tool, input, result, is_error, delivered/i);
    // 2 строки × 8 колонок
    expect(params).toHaveLength(16);
    expect(params[0]).toBe(7);
    expect(params[1]).toBe('79001112233');
    expect(params[2]).toBe(buf.turnId);
    expect(params[3]).toBe('get_available_slots');
    expect(JSON.parse(params[4])).toEqual({ date: '2026-08-05' });
    expect(params[6]).toBe(false);          // is_error первой строки
    expect(params[7]).toBeNull();           // delivered = null (вердикт позже)
    expect(params[14]).toBe(true);          // is_error второй строки
  });

  test('flush(false): выброшенная попытка помечается delivered=false во всех строках', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const buf = toolEvents.createBuffer(1, 'k');
    buf.push('t', {}, {}, false);
    await buf.flush(false);
    const [, params] = db.query.mock.calls[0];
    expect(params[7]).toBe(false);
  });

  test('flush идемпотентен: второй вызов не пишет', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const buf = toolEvents.createBuffer(1, 'k');
    buf.push('t', {}, {}, false);
    await buf.flush(null);
    await buf.flush(false);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('пустой буфер не пишет вовсе', async () => {
    const buf = toolEvents.createBuffer(1, 'k');
    await buf.flush(null);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('best-effort: сбой БД проглатывается с warn, не бросает', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    const buf = toolEvents.createBuffer(1, 'k');
    buf.push('t', {}, {}, false);
    await expect(buf.flush(null)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test('гигантский result обрезается до truncated+preview', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const buf = toolEvents.createBuffer(1, 'k');
    buf.push('t', {}, { big: 'x'.repeat(70 * 1024) }, false);
    await buf.flush(null);
    const stored = JSON.parse(db.query.mock.calls[0][1][5]);
    expect(stored.truncated).toBe(true);
    expect(stored.preview.length).toBeLessThanOrEqual(2000);
  });

  test('turnId у каждого буфера уникален', () => {
    const a = toolEvents.createBuffer(1, 'k');
    const b = toolEvents.createBuffer(1, 'k');
    expect(a.turnId).not.toBe(b.turnId);
    expect(a.turnId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('markDelivered', () => {
  test('UPDATE только строк без вердикта (delivered IS NULL)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await toolEvents.markDelivered('turn-1', true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_tool_events/i);
    expect(sql).toMatch(/delivered IS NULL/i);
    expect(params).toEqual(['turn-1', true]);
  });

  test('best-effort: сбой БД проглатывается', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(toolEvents.markDelivered('t', true)).resolves.toBeUndefined();
  });

  test('пустой turnId → no-op', async () => {
    await toolEvents.markDelivered(null, true);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('loadRecent', () => {
  test('возраст считается в SQL (age_ms), окно в часах, порядок хронологический', async () => {
    db.any.mockResolvedValue([{ tool: 'b', age_ms: 100 }, { tool: 'a', age_ms: 200 }]);
    const rows = await toolEvents.loadRecent(1, 'k');
    const [sql, params] = db.any.mock.calls[0];
    expect(sql).toMatch(/EXTRACT\(EPOCH FROM \(NOW\(\) - created_at\)\)/i);
    expect(sql).toMatch(/'\s*hours'/i);
    expect(sql).toMatch(/ORDER BY id DESC/i);
    expect(params).toEqual([1, 'k', 48, 120]);
    expect(rows.map(r => r.tool)).toEqual(['a', 'b']);   // reverse → хронология
  });
});

describe('cleanup', () => {
  test('удаляет строки старше KEEP_DAYS, сбой проглатывает', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await toolEvents.cleanup();
    expect(db.query.mock.calls[0][0]).toMatch(/DELETE FROM agent_tool_events[\s\S]*30 days/i);
    db.query.mockRejectedValue(new Error('x'));
    await expect(toolEvents.cleanup()).resolves.toBeUndefined();
  });
});
