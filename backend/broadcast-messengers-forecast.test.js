'use strict';
const f = require('./services/broadcast-messengers/forecast');
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime();
const set = { whatsapp: { enabled: true, delay_sec: 180, limit: 2 }, tdlib: { enabled: true, delay_sec: 60, limit: null }, max: { enabled: true, delay_sec: 60, limit: null } };

test('распределение с лимитом next_channel', () => {
  const r = f.forecast({ firstSteps: [['whatsapp', 'tdlib'], ['whatsapp', 'tdlib'], ['whatsapp', 'tdlib'], ['whatsapp']].map(c => ({ cascade: c })), settings: set, onLimit: 'next_channel', nowMs: at(2, 10) });
  expect(r.byChannel).toEqual({ whatsapp: 2, tdlib: 1, max: 0, none: 1 });
  expect(r.durationMin).toBe(3);
  expect(r.nextDay).toBe(false);
});
test('переход через ночь', () => {
  const steps = Array.from({ length: 21 }, () => ({ cascade: ['whatsapp'] }));
  const r = f.forecast({ firstSteps: steps, settings: { whatsapp: { enabled: true, delay_sec: 600, limit: null } }, onLimit: 'skip', nowMs: at(2, 20, 0) });
  // 20 пауз × 10 мин = 200 мин: 60 мин сегодня, 140 мин завтра с 09:00 → 11:20
  expect(r.finishAt).toBe(at(3, 11, 20));
  expect(r.nextDay).toBe(true);
});
test('старт ночью — с 09:00', () => {
  const r = f.forecast({ firstSteps: [{ cascade: ['tdlib'] }], settings: set, onLimit: 'skip', nowMs: at(2, 23) });
  expect(r.finishAt).toBe(at(3, 9));
});
test('skip: лимит исчерпан — получатель в none', () => {
  const r = f.forecast({ firstSteps: [['whatsapp'], ['whatsapp'], ['whatsapp']].map(c => ({ cascade: c })), settings: set, onLimit: 'skip', nowMs: at(2, 10) });
  expect(r.byChannel).toEqual({ whatsapp: 2, tdlib: 0, max: 0, none: 1 });
});
