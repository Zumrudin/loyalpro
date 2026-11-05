'use strict';
const s = require('./services/broadcast-messengers/scheduler');
const at = (h, m = 0) => new Date(2026, 10, 2, h, m, 0).getTime(); // мск (TZ jest)

describe('inSendWindow', () => {
  test('09:00 включительно, 21:00 исключительно', () => {
    expect(s.inSendWindow(at(8, 59))).toBe(false);
    expect(s.inSendWindow(at(9, 0))).toBe(true);
    expect(s.inSendWindow(at(20, 59))).toBe(true);
    expect(s.inSendWindow(at(21, 0))).toBe(false);
  });
});

describe('channelStates', () => {
  const settings = { whatsapp: { enabled: true, delay_sec: 180, limit: 2 }, tdlib: { enabled: true, delay_sec: 60, limit: null }, max: { enabled: false } };
  test('пауза, лимит, выключен', () => {
    const st = s.channelStates(settings, { whatsapp: { lastSentAt: at(10, 0), sentCount: 1 }, tdlib: { lastSentAt: at(9, 58), sentCount: 5 } }, at(10, 1));
    expect(st.whatsapp).toEqual({ state: 'paused', pausedUntil: at(10, 3), sent: 1, limit: 2 });
    expect(st.tdlib).toEqual({ state: 'free', pausedUntil: null, sent: 5, limit: null });
    expect(st.max.state).toBe('disabled');
  });
  test('лимит исчерпан главнее паузы', () => {
    const st = s.channelStates(settings, { whatsapp: { lastSentAt: at(10, 0), sentCount: 2 } }, at(10, 1));
    expect(st.whatsapp.state).toBe('limit');
  });
});

describe('pickSends', () => {
  test('по одному на свободный мессенджер, первые в очереди', () => {
    const states = { whatsapp: { state: 'free' }, tdlib: { state: 'paused' }, max: { state: 'free' } };
    const heads = { whatsapp: { id: 3 }, tdlib: { id: 1 }, max: null };
    expect(s.pickSends(states, heads)).toEqual([{ id: 3, channel: 'whatsapp' }]);
  });
});

describe('nextStep', () => {
  test('следующий незаблокированный шаг', () => {
    expect(s.nextStep(['whatsapp', 'tdlib', 'max'], 0, new Set(['tdlib']))).toEqual({ step: 2, channel: 'max' });
    expect(s.nextStep(['whatsapp'], 0, new Set())).toBeNull();
  });
});

describe('limitAction', () => {
  test('next_channel → advance или skip, skip → skip', () => {
    const blocked = new Set(['whatsapp']);
    expect(s.limitAction({ cascade: ['whatsapp', 'tdlib'], step: 0 }, 'next_channel', blocked)).toEqual({ action: 'advance', step: 1, channel: 'tdlib' });
    expect(s.limitAction({ cascade: ['whatsapp'], step: 0 }, 'next_channel', blocked)).toEqual({ action: 'skip', reason: 'limit' });
    expect(s.limitAction({ cascade: ['whatsapp', 'tdlib'], step: 0 }, 'skip', blocked)).toEqual({ action: 'skip', reason: 'limit' });
  });
});
