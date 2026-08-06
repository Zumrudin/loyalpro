'use strict';

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() } }));
jest.mock('./services/chat-events', () => ({ emitAgentStatus: jest.fn() }));

const { db } = require('./db');
const chatEvents = require('./services/chat-events');
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

describe('listStaleOperatorPauses', () => {
  test('берёт только паузы администратора старше открытия окна', async () => {
    db.any.mockResolvedValue([{ dialog_key: 'a' }, { dialog_key: 'b' }]);
    expect(await state.listStaleOperatorPauses(1, 90)).toEqual(['a', 'b']);
    const [sql, params] = db.any.mock.calls[0];
    expect(sql).toMatch(/status\s*=\s*'escalated'/i);
    expect(sql).toMatch(/escalated_reason\s*=\s*'operator_reply'/i);
    expect(sql).toMatch(/updated_at\s*<\s*now\(\)/i);
    expect(params).toEqual([1, '90']);
  });

  test('без салона или без возраста окна — пустой список, в БД не ходим', async () => {
    expect(await state.listStaleOperatorPauses(null, 90)).toEqual([]);
    expect(await state.listStaleOperatorPauses(1, null)).toEqual([]);
    expect(db.any).not.toHaveBeenCalled();
  });
});

describe('resumeOperatorPauses', () => {
  test('снимает паузу пачкой, гасит причину и шлёт SSE по каждому снятому', async () => {
    db.query.mockResolvedValue({ rows: [{ dialog_key: 'a' }] });
    const out = await state.resumeOperatorPauses(1, ['a', 'b'], 90);
    expect(out).toEqual(['a']);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_dialogs/i);
    expect(sql).toMatch(/status\s*=\s*'bot'/i);
    expect(sql).toMatch(/escalated_reason\s*=\s*NULL/i);
    expect(sql).toMatch(/dialog_key\s*=\s*ANY\(\$2\)/i);
    // Возраст перепроверяется В САМОМ UPDATE: между выборкой кандидатов и записью
    // администратор мог ответить снова — тогда паузу снимать нельзя.
    expect(sql).toMatch(/updated_at\s*<\s*now\(\)/i);
    expect(params).toEqual([1, ['a', 'b'], '90']);
    // SSE только по реально снятым — 'b' в RETURNING не вернулся.
    expect(chatEvents.emitAgentStatus).toHaveBeenCalledTimes(1);
    expect(chatEvents.emitAgentStatus).toHaveBeenCalledWith(1, 'a', 'bot', null);
  });

  test('пустой список ключей — в БД не ходим', async () => {
    expect(await state.resumeOperatorPauses(1, [], 90)).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('resumeOperatorPauseIfWindowReopened', () => {
  test('делегирует пачечной операции — правило снятия паузы одно на всех', async () => {
    db.query.mockResolvedValue({ rows: [{ dialog_key: 'k' }] });
    expect(await state.resumeOperatorPauseIfWindowReopened(1, 'k', 90)).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual([1, ['k'], '90']);
  });

  test('ничего не сняли → false', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await state.resumeOperatorPauseIfWindowReopened(1, 'k', 90)).toBe(false);
  });

  test('битые аргументы — в БД не ходим', async () => {
    expect(await state.resumeOperatorPauseIfWindowReopened(1, 'k', null)).toBe(false);
    expect(await state.resumeOperatorPauseIfWindowReopened(null, 'k', 90)).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});
