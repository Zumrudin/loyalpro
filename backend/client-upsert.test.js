'use strict';
// Одно правило разбора карточки клиента YClients для client-вебхука и ночной
// сверки. До 25.09.2026 траты/визиты/уровень/yclients_data писал ТОЛЬКО runSync
// (сломан с 26.06), а client-вебхук, который приходит на каждый оплаченный визит
// и несёт те же поля (spent/paid/visits/surname/patronymic), их выбрасывал.

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() }, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { db } = require('./db');
const { clientFieldsFromYc, upsertClientFromYc } = require('./services/client-upsert');

const LEVELS = [
  { key: 'bronze', minSpent: 0, cashback: 5 },
  { key: 'silver', minSpent: 100000, cashback: 7 },
];

// Реальная форма client-вебхука с прода (25.09.2026), PII заменена.
const YC = {
  id: 352092609, name: 'Андрюшова Елена Валерьевна', surname: '', patronymic: '',
  display_name: 'Андрюшова Елена Валерьевна', phone: '+79160000000', email: '',
  birth_date: '1975-06-26', spent: 1373824, paid: 1373824, visits: 55, balance: -81560,
};

describe('clientFieldsFromYc', () => {
  test('берёт spent, визиты, уровень по тратам и весь объект в ycData', () => {
    const f = clientFieldsFromYc(YC, LEVELS);
    expect(f).toMatchObject({
      name: 'Андрюшова Елена Валерьевна', phone: '+79160000000', email: null,
      birthday: '1975-06-26', totalSpent: 1373824, visitsCount: 55, level: 'silver',
    });
    expect(f.ycData).toBe(YC);
  });

  test('spent пустой → paid; оба пустые → 0; visits пустой → 0', () => {
    expect(clientFieldsFromYc({ ...YC, spent: undefined, paid: 500 }, LEVELS).totalSpent).toBe(500);
    expect(clientFieldsFromYc({ ...YC, spent: null, paid: null, visits: null }, LEVELS))
      .toMatchObject({ totalSpent: 0, visitsCount: 0, level: 'bronze' });
  });

  test('без уровней салона уровень не считается (null — не затирать существующий)', () => {
    expect(clientFieldsFromYc(YC, null).level).toBeNull();
    expect(clientFieldsFromYc(YC, []).level).toBeNull();
  });

  test('ФИО собирается из раздельных полей, когда они заполнены', () => {
    const f = clientFieldsFromYc({ ...YC, name: 'Елена', surname: 'Андрюшова', patronymic: 'Валерьевна' }, LEVELS);
    expect(f.name).toBe('Андрюшова Елена Валерьевна');
  });
});

describe('upsertClientFromYc', () => {
  beforeEach(() => { jest.clearAllMocks(); db.one.mockResolvedValue({ id: 3777 }); });

  test('один INSERT … ON CONFLICT DO UPDATE со всеми полями; карту и bonus_balance не трогает', async () => {
    const row = await upsertClientFromYc(1, YC, { levels: LEVELS });
    expect(row).toEqual({ id: 3777 });
    expect(db.one).toHaveBeenCalledTimes(1);
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO clients/);
    expect(sql).toMatch(/ON CONFLICT \(salon_id,\s*yclients_client_id\)\s*DO UPDATE/);
    expect(sql).toMatch(/total_spent/);
    expect(sql).toMatch(/visits_count/);
    expect(sql).toMatch(/yclients_data/);
    expect(sql).toMatch(/loyalty_level\s*=\s*COALESCE/);
    expect(sql).not.toMatch(/bonus_balance/);
    expect(sql).not.toMatch(/yclients_card_id/);
    expect(params).toEqual([1, 352092609, 'Андрюшова Елена Валерьевна', '+79160000000', null,
      '1975-06-26', 1373824, 55, 'silver', JSON.stringify(YC)]);
  });

  test('без id клиента ничего не пишет', async () => {
    expect(await upsertClientFromYc(1, { name: 'x' }, { levels: LEVELS })).toBeNull();
    expect(db.one).not.toHaveBeenCalled();
  });
});
