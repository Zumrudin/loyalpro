'use strict';
// Подбор бонусной ступени по балансу карты. Ступени задаёт салон в правиле;
// баланс попадает в ПЕРВУЮ ступень, для которой balance < up_to.
const { pickTier, normalizeTiers } = require('./services/reminders/tiers');

// Утверждённая салоном схема из спеки: мало бонусов — начисляем, средняя
// полоса — молчим про бонусы, много — напоминаем о накопленном.
const TIERS = [
  { up_to: 500,  action: 'accrue',  amount: 300, text: 'начислили {бонусы}' },
  { up_to: 1000, action: 'none',    amount: 0,   text: '' },
  { up_to: null, action: 'mention', amount: 0,   text: 'у вас {баланс}' },
];

describe('pickTier', () => {
  test('баланс ниже первого порога → начисление', () => {
    expect(pickTier(0, TIERS)).toMatchObject({ action: 'accrue', amount: 300 });
    expect(pickTier(499, TIERS)).toMatchObject({ action: 'accrue', amount: 300 });
  });

  test('граница порога исключающая: ровно 500 уже средняя полоса', () => {
    expect(pickTier(500, TIERS)).toMatchObject({ action: 'none' });
    expect(pickTier(999, TIERS)).toMatchObject({ action: 'none' });
  });

  test('ступень up_to:null принимает любой остаток', () => {
    expect(pickTier(1000, TIERS)).toMatchObject({ action: 'mention' });
    expect(pickTier(999999, TIERS)).toMatchObject({ action: 'mention' });
  });

  // Баланс неизвестен — нет карты или YClients не ответил. Утверждённое
  // поведение: напоминание уходит, но про бонусы в нём ни слова.
  test('неизвестный баланс → no_bonus', () => {
    expect(pickTier(null, TIERS).action).toBe('no_bonus');
    expect(pickTier(undefined, TIERS).action).toBe('no_bonus');
    expect(pickTier(NaN, TIERS).action).toBe('no_bonus');
    expect(pickTier('много', TIERS).action).toBe('no_bonus');
  });

  test('пустой список ступеней → no_bonus', () => {
    expect(pickTier(100, []).action).toBe('no_bonus');
    expect(pickTier(100, null).action).toBe('no_bonus');
  });

  // Без бесконечной ступени высокий баланс не покрыт ничем — молчим про
  // бонусы, а не проваливаемся в последнюю конечную ступень.
  test('все ступени конечные, баланс выше последней → no_bonus', () => {
    expect(pickTier(5000, [{ up_to: 500, action: 'accrue', amount: 300 }]).action).toBe('no_bonus');
  });
});

describe('normalizeTiers', () => {
  test('сортирует по возрастанию порога независимо от порядка в JSON', () => {
    const out = normalizeTiers([
      { up_to: 1000, action: 'none' },
      { up_to: 500,  action: 'accrue', amount: 300 },
    ]);
    expect(out.map(t => t.upTo)).toEqual([500, 1000]);
  });

  test('бесконечная ступень всегда последняя', () => {
    const out = normalizeTiers([
      { up_to: null, action: 'mention' },
      { up_to: 500,  action: 'accrue', amount: 300 },
    ]);
    expect(out[out.length - 1].upTo).toBeNull();
  });

  test('мусорные ступени отбрасываются, суммы приводятся к целым', () => {
    const out = normalizeTiers([
      { up_to: 500, action: 'магия', amount: 300 },
      { up_to: 'ой', action: 'accrue', amount: 10 },
      { up_to: 700, action: 'accrue', amount: '250.7' },
      null,
    ]);
    expect(out).toEqual([{ upTo: 700, action: 'accrue', amount: 251, text: '' }]);
  });
});
