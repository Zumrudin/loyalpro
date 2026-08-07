'use strict';
// Чтение баланса карты и начисление. Внешние вызовы YClients инжектируются.
// Главный инвариант: любой сбой YClients деградирует в 'no_bonus' и НЕ мешает
// напоминанию уйти — утверждено при обсуждении («слать без бонусов»).
const bonus = require('./services/reminders/bonus');

const TIERS = [
  { up_to: 500,  action: 'accrue',  amount: 300, text: 'начислили {бонусы}' },
  { up_to: null, action: 'mention', amount: 0,   text: 'у вас {баланс}' },
];
const SALON = { id: 1, yclients_company_id: 100 };

const deps = (over = {}) => ({
  getCards: jest.fn(async () => [{ id: 900, balance: 120, number: '1', type: { title: 'samosale' } }]),
  accrue: jest.fn(async () => ({ id: 1 })),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ...over,
});

test('низкий баланс → начисление на карту, факт записан', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true });
  expect(d.accrue).toHaveBeenCalledWith(SALON, 900, 300, expect.stringContaining('Эпиляция'));
});

test('высокий баланс → упоминание без начисления', async () => {
  const d = deps({ getCards: jest.fn(async () => [{ id: 900, balance: 1500 }]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 1500, tier: 'mention', accrued: 0 });
  expect(d.accrue).not.toHaveBeenCalled();
});

test('карты нет → no_bonus, начисления нет', async () => {
  const d = deps({ getCards: jest.fn(async () => []) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null });
  expect(d.accrue).not.toHaveBeenCalled();
});

test('сбой чтения карт → no_bonus, исключение наружу не летит', async () => {
  const d = deps({ getCards: jest.fn(async () => { throw new Error('502'); }) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus', accrued: 0 });
});

// Начисление упало — сообщение обязано уйти БЕЗ бонусной части, иначе клиент
// прочтёт про 300 бонусов, которых у него нет.
test('сбой начисления → no_bonus и txnOk=false', async () => {
  const d = deps({ accrue: jest.fn(async () => { throw new Error('YClients 500'); }) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 120, tier: 'no_bonus', accrued: 0, txnOk: false });
});

test('нет клиента в YClients → no_bonus без вызовов', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, null, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus' });
  expect(d.getCards).not.toHaveBeenCalled();
});

// Ступень accrue с нулевой суммой — настроечная ошибка администратора.
// Дёргать YClients на ноль бессмысленно, но и врать про начисление нельзя.
test('accrue с amount=0 не зовёт YClients и даёт no_bonus', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, 777,
    [{ up_to: null, action: 'accrue', amount: 0 }], 'Эпиляция', d);
  expect(d.accrue).not.toHaveBeenCalled();
  expect(out.tier).toBe('no_bonus');
});

test('несколько карт — берётся первая с максимальным балансом', async () => {
  const d = deps({ getCards: jest.fn(async () => [
    { id: 1, balance: 50 }, { id: 2, balance: 900 },
  ]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out.balanceBefore).toBe(900);
});
