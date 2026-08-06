'use strict';
// Вечерний автосброс пауз «отвечал администратор»: фоновый проход по салону.
// ЗАЧЕМ он вообще: ленивая проверка в диспетчере срабатывает только на ВХОДЯЩЕМ
// сообщении внутри окна расписания, а у PERI окно ночное (22:00–09:30) — за трое
// суток на проде ноль срабатываний, администраторы возвращали диалоги боту руками
// (21 диалог 04.08 и 05.08 в 22:0x). Проход не ждёт сообщения.

jest.mock('./db', () => ({ db: { any: jest.fn(), query: jest.fn() } }));

const sweep = require('./services/agent/operator-pause-sweep');

// Настройки салона по умолчанию: агент включён, ночное окно 22:00–09:30, режим all.
const SETTINGS = {
  enabled: true, mode: 'all',
  scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '09:30',
};

function mkDeps(over = {}) {
  const settings = {
    getSettings: jest.fn(async () => ({ ...SETTINGS, ...(over.settings || {}) })),
    listNumberRules: jest.fn(async () => over.rules || []),
  };
  const state = {
    listStaleOperatorPauses: jest.fn(async () => (over.stale === undefined ? ['79001112233'] : over.stale)),
    resumeOperatorPauses: jest.fn(async (_s, keys) => keys),
  };
  return { settings, state, nowMinutes: over.nowMinutes === undefined ? 23 * 60 : over.nowMinutes };
}

beforeEach(() => jest.clearAllMocks());

describe('sweepSalon', () => {
  test('внутри окна снимает протухшие паузы и передаёт возраст окна', async () => {
    const deps = mkDeps({ nowMinutes: 23 * 60 });   // 23:00, окно открылось в 22:00
    const resumed = await sweep.sweepSalon(1, deps);
    expect(resumed).toEqual(['79001112233']);
    // 60 минут с открытия окна — тот же смысл, что у ленивой проверки диспетчера.
    expect(deps.state.listStaleOperatorPauses).toHaveBeenCalledWith(1, 60);
    expect(deps.state.resumeOperatorPauses).toHaveBeenCalledWith(1, ['79001112233'], 60);
  });

  test('вне окна не трогает ничего', async () => {
    const deps = mkDeps({ nowMinutes: 12 * 60 });   // полдень — окно закрыто
    expect(await sweep.sweepSalon(1, deps)).toEqual([]);
    expect(deps.state.listStaleOperatorPauses).not.toHaveBeenCalled();
    expect(deps.state.resumeOperatorPauses).not.toHaveBeenCalled();
  });

  test('расписание выключено — якоря нет, сброса нет', async () => {
    const deps = mkDeps({ settings: { scheduleEnabled: false } });
    expect(await sweep.sweepSalon(1, deps)).toEqual([]);
    expect(deps.state.listStaleOperatorPauses).not.toHaveBeenCalled();
  });

  test('агент выключен в салоне — красить диалоги в «бот» нельзя, отвечать некому', async () => {
    const deps = mkDeps({ settings: { enabled: false } });
    expect(await sweep.sweepSalon(1, deps)).toEqual([]);
    expect(deps.state.listStaleOperatorPauses).not.toHaveBeenCalled();
  });

  test('нет кандидатов — UPDATE не зовём вовсе', async () => {
    const deps = mkDeps({ stale: [] });
    expect(await sweep.sweepSalon(1, deps)).toEqual([]);
    expect(deps.state.resumeOperatorPauses).not.toHaveBeenCalled();
  });

  test('чёрный список: номер остаётся на человеке (Мила ему всё равно не ответит)', async () => {
    const deps = mkDeps({
      stale: ['79001112233', '79004445566'],
      rules: [{ phone: '79001112233', rule_type: 'block' }],
    });
    expect(await sweep.sweepSalon(1, deps)).toEqual(['79004445566']);
    expect(deps.state.resumeOperatorPauses).toHaveBeenCalledWith(1, ['79004445566'], 60);
  });

  test('режим whitelist: снимаем паузу только у номеров из белого списка', async () => {
    const deps = mkDeps({
      settings: { mode: 'whitelist' },
      stale: ['79001112233', '79004445566'],
      rules: [{ phone: '79004445566', rule_type: 'allow' }],
    });
    expect(await sweep.sweepSalon(1, deps)).toEqual(['79004445566']);
  });

  test('все кандидаты отсеяны гейтом — UPDATE не зовём', async () => {
    const deps = mkDeps({
      stale: ['79001112233'],
      rules: [{ phone: '79001112233', rule_type: 'block' }],
    });
    expect(await sweep.sweepSalon(1, deps)).toEqual([]);
    expect(deps.state.resumeOperatorPauses).not.toHaveBeenCalled();
  });
});

describe('sweepAll', () => {
  test('глобальный kill-switch выключен — прохода нет', async () => {
    const deps = mkDeps();
    deps.config = { CHATPUSH: { agentEnabled: false } };
    deps.listSalonIds = jest.fn(async () => [1]);
    expect(await sweep.sweepAll(deps)).toEqual([]);
    expect(deps.listSalonIds).not.toHaveBeenCalled();
  });

  test('идёт по всем салонам с включённым расписанием, падение одного не роняет остальные', async () => {
    const deps = mkDeps();
    deps.config = { CHATPUSH: { agentEnabled: true } };
    deps.listSalonIds = jest.fn(async () => [1, 2]);
    deps.state.listStaleOperatorPauses = jest.fn(async (salonId) => {
      if (salonId === 1) throw new Error('db down');
      return ['79004445566'];
    });
    const out = await sweep.sweepAll(deps);
    expect(out).toEqual([{ salonId: 2, resumed: ['79004445566'] }]);
  });
});
