'use strict';
// Гейт допуска agentSettings.isAllowed — ветка ignoreSchedule.
// БД замокана; чистое решение проверяется в agent-gate.test.js.
//
// Окно задано НУЛЕВОЙ длины ('10:00'-'10:00'): isWithinWindow для такого окна
// всегда false (см. agent-gate.js), поэтому «мы вне окна» верно в любой момент
// суток — тест не зависит от реального времени прогона.

jest.mock('./db', () => ({
  db: { oneOrNone: jest.fn(), any: jest.fn(), one: jest.fn(), query: jest.fn() },
}));

const { db } = require('./db');
const agentSettings = require('./services/agent-settings');

const OUTSIDE_WINDOW = {
  enabled: true, mode: 'all',
  schedule_enabled: true, schedule_start: '10:00', schedule_end: '10:00',
};

function mockDb({ settings = OUTSIDE_WINDOW, rules = [] } = {}) {
  db.oneOrNone.mockReset().mockResolvedValue(settings);
  db.any.mockReset().mockResolvedValue(rules);
}

describe('isAllowed: окно расписания', () => {
  test('вне окна незнакомый номер отсекается (поведение для ВХОДЯЩИХ не менялось)', async () => {
    mockDb();
    const r = await agentSettings.isAllowed(5, '79200255591');
    expect(r).toMatchObject({ allow: false, reason: 'outside-schedule' });
  });

  // Собственно фикс: плановое касание «Заботы» уходит в назначенное салоном
  // время независимо от окна. До этого при постоянном окне (ночное 22:00–09:30
  // на проде) дневное касание откладывалось на сутки КАЖДЫЙ раз — то есть не
  // уходило никогда.
  test('ignoreSchedule → окно не сужает допуск', async () => {
    mockDb();
    const r = await agentSettings.isAllowed(5, '79200255591', { ignoreSchedule: true });
    expect(r).toMatchObject({ allow: true, reason: 'ok' });
  });

  test('ignoreSchedule НЕ отменяет чёрный список', async () => {
    mockDb({ rules: [{ phone: '79200255591', rule_type: 'block' }] });
    const r = await agentSettings.isAllowed(5, '89200255591', { ignoreSchedule: true });
    expect(r).toMatchObject({ allow: false, reason: 'blacklisted' });
  });

  test('ignoreSchedule НЕ отменяет режим whitelist', async () => {
    mockDb({ settings: { ...OUTSIDE_WINDOW, mode: 'whitelist' } });
    const r = await agentSettings.isAllowed(5, '79200255591', { ignoreSchedule: true });
    expect(r).toMatchObject({ allow: false, reason: 'not-whitelisted' });
  });

  test('ignoreSchedule НЕ отменяет выключенный тумблер агента', async () => {
    mockDb({ settings: { ...OUTSIDE_WINDOW, enabled: false } });
    const r = await agentSettings.isAllowed(5, '79200255591', { ignoreSchedule: true });
    expect(r).toMatchObject({ allow: false, reason: 'disabled' });
  });
});
