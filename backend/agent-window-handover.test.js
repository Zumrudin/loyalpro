'use strict';

// Инцидент 2026-09-19 (79651442032): в 09:32 (окно до 09:30) «Удобнее, если
// перезвонит администратор» → gate skip (outside-schedule), ни эскалации, ни
// фразы — администратор нашёл диалог сам через 18 минут.

const wh = require('./services/agent/window-handover');

const HOUR = 60 * 60 * 1000;

describe('decideWindowHandover', () => {
  const base = { dialogStatus: 'bot', lastAgentReplyAgeMs: 3 * 60 * 1000, maxAgeMs: HOUR,
    incomingText: 'Удобнее, если перезвонит администратор. Здесь просто тратить время.' };

  test('боевой случай: бот вёл диалог 3 минуты назад → handover', () => {
    expect(wh.decideWindowHandover(base)).toEqual({ action: 'handover', why: 'live-dialog' });
  });

  test('выключено (maxAgeMs 0) → skip', () => {
    expect(wh.decideWindowHandover({ ...base, maxAgeMs: 0 }).action).toBe('skip');
  });

  test('диалог уже у человека (escalated) → skip', () => {
    expect(wh.decideWindowHandover({ ...base, dialogStatus: 'escalated' }).action).toBe('skip');
  });

  test('строки диалога нет / реплик Милы не было → skip', () => {
    expect(wh.decideWindowHandover({ ...base, dialogStatus: null }).action).toBe('skip');
    expect(wh.decideWindowHandover({ ...base, lastAgentReplyAgeMs: null }).action).toBe('skip');
  });

  test('последняя реплика Милы старше окна → skip (обрывать нечего)', () => {
    expect(wh.decideWindowHandover({ ...base, lastAgentReplyAgeMs: 2 * HOUR })).toEqual({ action: 'skip', why: 'agent-reply-too-old' });
  });

  test('чистая вежливость («Спасибо») → skip', () => {
    expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо' })).toEqual({ action: 'skip', why: 'pure-closing' });
    expect(wh.decideWindowHandover({ ...base, incomingText: 'Спасибо, а 17:00 можно?' }).action).toBe('handover');
  });

  test('текста входящего нет (старый вебхук) — решает только возраст', () => {
    expect(wh.decideWindowHandover({ ...base, incomingText: undefined }).action).toBe('handover');
  });
});

describe('onOutsideSchedule', () => {
  const NOW = Date.parse('2026-09-19T09:32:35+03:00');
  const meta = { phone: '79651442032', channel: 'max', text: 'Удобнее, если перезвонит администратор' };

  function deps(over = {}) {
    return {
      state: { get: jest.fn(async () => ({ status: 'bot' })) },
      history: { lastAgentReplyAt: jest.fn(async () => Date.parse('2026-09-19T09:29:02+03:00')) },
      escalate: jest.fn(async () => ({ escalated: true })),
      send: jest.fn(async () => {}),
      handoverText: () => 'Передаю ваш диалог администратору клиники 🤍',
      maxAgeMs: HOUR, nowMs: NOW,
      logger: { info: jest.fn(), warn: jest.fn() },
      ...over,
    };
  }

  test('живой диалог → эскалация window_closed + фраза перевода', async () => {
    const d = deps();
    expect(await wh.onOutsideSchedule(1, '79651442032', meta, d)).toBe(true);
    expect(d.escalate).toHaveBeenCalledWith(1, '79651442032', 'window_closed');
    expect(d.send).toHaveBeenCalledWith(meta, 'Передаю ваш диалог администратору клиники 🤍');
  });

  test('реплика Милы старая → ничего', async () => {
    const d = deps({ history: { lastAgentReplyAt: jest.fn(async () => NOW - 5 * HOUR) } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.escalate).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  test('уже escalated → ничего', async () => {
    const d = deps({ state: { get: jest.fn(async () => ({ status: 'escalated' })) } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  test('сбой БД → без перевода, только лог', async () => {
    const d = deps({ state: { get: jest.fn(async () => { throw new Error('db down'); }) } });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(false);
    expect(d.logger.warn).toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  test('эскалация упала → фраза пациенту всё равно уходит', async () => {
    const d = deps({ escalate: jest.fn(async () => { throw new Error('x'); }) });
    expect(await wh.onOutsideSchedule(1, 'k', meta, d)).toBe(true);
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});
