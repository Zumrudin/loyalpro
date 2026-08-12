'use strict';

// Имя, которое create_booking кладёт в карточку YClients.
//
// ЗАЧЕМ ЭТОТ СЬЮТ. POST /records ищет карточку ПО ТЕЛЕФОНУ и ПЕРЕЗАПИСЫВАЕТ у неё
// поле name тем, что мы прислали. Модель знает только личное имя (в переписке к
// пациенту обращаются по givenName), и её client_name затирал ФИО: инцидент
// 2026-08-12 — карточка «Пунина Юлия Владимировна» (id 231299724) после записи
// Милой 06.08 стала «Юлия» с пустыми surname/patronymic, фамилия и отчество
// потеряны безвозвратно. Так же пострадали «Сотникова Софья Сергеевна» и
// «Старкова Нелли Равильевна» (их в клинике потом чинили руками). На проде PERI
// всё ФИО лежит одной строкой в поле name у 3027 карточек из 4313.
jest.mock('./services/agent/booking', () => ({
  createBookingRecord: jest.fn(async () => ({ created: true, record_id: 777 })),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn(async () => null) }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));
jest.mock('./services/agent/identity', () => ({ resolveClient: jest.fn(async () => null) }));

const booking = require('./services/agent/booking');
const identity = require('./services/agent/identity');
const tool = require('./services/agent/tools/create-booking');

beforeEach(() => jest.clearAllMocks());

const NOW = Date.parse('2026-08-12T10:00:00+03:00');
const INPUT = { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-08-16T15:00:00+03:00' };
const CTX = {
  dialogKey: '79165370505', clientPhone: '79165370505',
  clientName: 'Пунина Юлия Владимировна', nowMs: NOW,
};

const sentName = () => booking.createBookingRecord.mock.calls[0][1].clientName;

describe('create_booking: имя в карточку YClients', () => {
  test('основной пациент: ФИО из карточки главнее личного имени от модели', async () => {
    const res = await tool.run(1, { ...INPUT, client_name: 'Юлия' }, CTX);
    expect(res.created).toBe(true);
    expect(sentName()).toBe('Пунина Юлия Владимировна');
  });

  test('основной пациент, явно передан свой же номер — тоже не третье лицо', async () => {
    await tool.run(1, { ...INPUT, client_phone: '89165370505', client_name: 'Юлия' }, CTX);
    expect(sentName()).toBe('Пунина Юлия Владимировна');
  });

  test('карточки нет (новый пациент) — имя от модели единственный источник', async () => {
    await tool.run(1, { ...INPUT, client_name: 'Юлия' }, { ...CTX, clientName: null });
    expect(sentName()).toBe('Юлия');
  });

  test('третье лицо: уходит имя ГОСТЯ, а не ФИО собеседника', async () => {
    await tool.run(1, { ...INPUT, client_phone: '79001112233', client_name: 'Марина' }, CTX);
    expect(sentName()).toBe('Марина');
    expect(identity.resolveClient).not.toHaveBeenCalled();
  });

  test('третье лицо без имени: берём ФИО из карточки САМОГО гостя', async () => {
    identity.resolveClient.mockResolvedValueOnce({ name: 'Иванова Марина Петровна' });
    await tool.run(1, { ...INPUT, client_phone: '79001112233' }, CTX);
    expect(identity.resolveClient).toHaveBeenCalledWith(1, '79001112233');
    expect(sentName()).toBe('Иванова Марина Петровна');
  });

  test('третье лицо без имени и без карточки: ФИО собеседника не подставляется', async () => {
    identity.resolveClient.mockResolvedValueOnce(null);
    await tool.run(1, { ...INPUT, client_phone: '79001112233' }, CTX);
    expect(sentName()).toBeUndefined();
  });

  test('сбой резолва карточки гостя не роняет запись (fail-open, без имени)', async () => {
    identity.resolveClient.mockRejectedValueOnce(new Error('db down'));
    const res = await tool.run(1, { ...INPUT, client_phone: '79001112233' }, CTX);
    expect(res.created).toBe(true);
    expect(sentName()).toBeUndefined();
  });
});
