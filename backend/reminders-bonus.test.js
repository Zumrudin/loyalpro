'use strict';
// Чтение баланса карты и начисление. Внешние вызовы YClients инжектируются.
// Главный инвариант: любой сбой YClients деградирует в 'no_bonus' и НЕ мешает
// напоминанию уйти — утверждено при обсуждении («слать без бонусов»).
//
// Карта выбирается СТРОГО по типу, настроенному в салоне (yclients_card_type_id) —
// ровно как в services/loyalty.js и routes/clients.js. У клиента может быть
// несколько карт разных программ (например samosale), и «максимальный баланс»
// без фильтра по типу означал бы (1) назвать клиенту баланс чужой программы и
// (2) необратимо начислить деньги на карту, которую никто не считает бонусной.
const bonus = require('./services/reminders/bonus');

const TIERS = [
  { up_to: 500,  action: 'accrue',  amount: 300, text: 'начислили {бонусы}' },
  { up_to: null, action: 'mention', amount: 0,   text: 'у вас {баланс}' },
];
const SALON = { id: 1, yclients_company_id: 100, yclients_card_type_id: 7 };

const deps = (over = {}) => ({
  getCards: jest.fn(async () => [{ id: 900, balance: 120, number: '1', type: { id: 7, title: 'samosale' } }]),
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
  const d = deps({ getCards: jest.fn(async () => [{ id: 900, balance: 1500, type: { id: 7 } }]) });
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

test('несколько карт нужного типа — берётся та, где больше баланс', async () => {
  const d = deps({ getCards: jest.fn(async () => [
    { id: 1, balance: 50, type: { id: 7 } }, { id: 2, balance: 900, type: { id: 7 } },
  ]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out.balanceBefore).toBe(900);
});

// Карта чужой программы (например предоплаченного пакета) с большим балансом
// не должна перебивать бонусную карту салона — ни в тексте, ни в начислении.
test('карта чужого типа с большим балансом не выбирается', async () => {
  const d = deps({ getCards: jest.fn(async () => [
    { id: 1, balance: 5000, type: { id: 99 } },
    { id: 2, balance: 120,  type: { id: 7 } },
  ]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out.balanceBefore).toBe(120);
  expect(d.accrue).toHaveBeenCalledWith(SALON, 2, 300, expect.stringContaining('Эпиляция'));
});

test('тип карты не настроен в салоне → no_bonus, начисления нет даже при наличии карт', async () => {
  const salonNoType = { id: 1, yclients_company_id: 100 };
  const d = deps();
  const out = await bonus.applyBonus(salonNoType, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus', accrued: 0 });
  expect(d.accrue).not.toHaveBeenCalled();
  expect(d.log.warn).toHaveBeenCalled();
});

test('карт нужного типа нет вовсе → no_bonus, начисления нет', async () => {
  const d = deps({ getCards: jest.fn(async () => [{ id: 1, balance: 120, type: { id: 99 } }]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus', accrued: 0 });
  expect(d.accrue).not.toHaveBeenCalled();
});

// Тип из YClients иногда приходит строкой, а yclients_card_type_id в салоне —
// числом (или наоборот): сравнение обязано пройти через String(), как в loyalty.js.
test('тип карты строкой при числовом типе салона всё равно опознаётся', async () => {
  const d = deps({ getCards: jest.fn(async () => [
    { id: 999, balance: 5000, type: { id: 42 } },  // чужой тип с бОльшим балансом
    { id: 900, balance: 120,  type: { id: '7' } }, // нужный тип, id строкой
  ]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true });
  expect(d.accrue).toHaveBeenCalledWith(SALON, 900, 300, expect.stringContaining('Эпиляция'));
});
