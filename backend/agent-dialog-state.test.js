'use strict';

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));

const { db } = require('./db');
const state = require('./services/agent/dialog-state');

beforeEach(() => jest.clearAllMocks());

describe('getOrCreate', () => {
  test('апсертит строку диалога и возвращает её', async () => {
    db.one.mockResolvedValue({ id: 1, status: 'bot', watermark_ts: 0, dirty: false });
    const row = await state.getOrCreate(1, '79001112233');
    expect(row.status).toBe('bot');
    const sql = db.one.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO agent_dialogs/i);
    expect(sql).toMatch(/ON CONFLICT \(salon_id, dialog_key\)/i);
    expect(db.one.mock.calls[0][1]).toEqual([1, '79001112233']);
  });
});

describe('setWatermark', () => {
  test('пишет watermark_ts и сбрасывает dirty', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await state.setWatermark(1, 'k', 300);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_dialogs/i);
    expect(sql).toMatch(/watermark_ts\s*=\s*\$3/i);
    expect(sql).toMatch(/dirty\s*=\s*false/i);
    expect(params).toEqual([1, 'k', 300]);
  });
});

describe('setStatus', () => {
  test('меняет статус диалога', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await state.setStatus(1, 'k', 'escalated', 'жалоба');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_dialogs/i);
    expect(sql).toMatch(/status\s*=\s*\$3/i);
    expect(params).toEqual([1, 'k', 'escalated', 'жалоба']);
  });
});

describe('get', () => {
  test('возвращает строку или null', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await state.get(1, 'k')).toBeNull();
  });
});
