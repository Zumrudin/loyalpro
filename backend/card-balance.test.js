'use strict';
// Чтение бонусной карты для напоминания Милы о себе. Инвариант тот же, что у
// напоминаний о повторном визите: пациент не должен прочитать про бонусы,
// которых у него нет — любой сбой даёт status:'unavailable', а НЕ «карты нет».
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() } }));
const cb = require('./services/card-balance');

const SALON = { id: 1, yclients_company_id: 100, yclients_card_type_id: 7 };
const PHONE = '79200255591';

const deps = (over = {}) => ({
  findClientId: jest.fn(async () => 555),
  searchClientId: jest.fn(async () => null),
  getCards: jest.fn(async () => [{ id: 900, balance: 3024.6, type: { id: 7 } }]),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ...over,
});

describe('pickSalonCard', () => {
  test('карта строго типа салона, тай-брейк по балансу', () => {
    const cards = [
      { id: 1, balance: 900, type: { id: 8 } },
      { id: 2, balance: 100, type: { id: '7' } },
      { id: 3, balance: 250, type: { id: 7 } },
    ];
    expect(cb.pickSalonCard(cards, 7)).toEqual({ id: 3, balance: 250 });
  });
  test('нет карты нужного типа → null; мусор → null', () => {
    expect(cb.pickSalonCard([{ id: 1, balance: 5, type: { id: 8 } }], 7)).toBe(null);
    expect(cb.pickSalonCard(null, 7)).toBe(null);
    expect(cb.pickSalonCard([{ balance: 5, type: { id: 7 } }], 7)).toBe(null); // без id
  });
});

describe('readCardBalance', () => {
  test('карта есть → ok с целым балансом', async () => {
    const d = deps();
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'ok', balance: 3024, cardId: 900 });
    expect(d.searchClientId).not.toHaveBeenCalled();
  });
  test('тип карты салона не задан → unavailable без единого вызова', async () => {
    const d = deps();
    await expect(cb.readCardBalance({ ...SALON, yclients_card_type_id: null }, PHONE, d))
      .resolves.toEqual({ status: 'unavailable', reason: 'no_card_type' });
    expect(d.findClientId).not.toHaveBeenCalled();
  });
  test('короткий/пустой номер → unavailable', async () => {
    await expect(cb.readCardBalance(SALON, '1234', deps())).resolves.toEqual({ status: 'unavailable', reason: 'no_phone' });
  });
  test('в БД нет → живой поиск нашёл → карты читаются по найденному id', async () => {
    const d = deps({ findClientId: jest.fn(async () => null), searchClientId: jest.fn(async () => 777) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toMatchObject({ status: 'ok', balance: 3024 });
    expect(d.getCards).toHaveBeenCalledWith(SALON, 777);
  });
  test('живой поиск не нашёл клиента → no_client', async () => {
    const d = deps({ findClientId: jest.fn(async () => null) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'no_client' });
    expect(d.getCards).not.toHaveBeenCalled();
  });
  test('живой поиск упал → unavailable', async () => {
    const d = deps({ findClientId: jest.fn(async () => null), searchClientId: jest.fn(async () => { throw new Error('429'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'search_failed' });
  });
  test('клиент есть, карт типа салона нет → no_card', async () => {
    const d = deps({ getCards: jest.fn(async () => [{ id: 1, balance: 500, type: { id: 8 } }]) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'no_card' });
  });
  test('чтение карт БРОСИЛО → unavailable, а не no_card', async () => {
    const d = deps({ getCards: jest.fn(async () => { throw new Error('timeout'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'cards_failed' });
  });
  test('поиск в БД упал → unavailable', async () => {
    const d = deps({ findClientId: jest.fn(async () => { throw new Error('db down'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'db_failed' });
  });
});
