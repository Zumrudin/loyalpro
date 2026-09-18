'use strict';

// Канал без номера (Telegram/MAX со скрытым номером): create_booking без
// client_phone обязан вернуть needs_phone — оркестратор на нём сам спрашивает
// номер у пациента, а не переводит диалог на администратора (инцидент 2026-09-18).

jest.mock('./services/agent/booking', () => ({
  createBookingRecord: jest.fn(async () => ({ created: true, record_id: 777 })),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));

const booking = require('./services/agent/booking');
const tool = require('./services/agent/tools/create-booking');
const { NEEDS_PHONE_ERROR } = require('./services/agent/phone-request');

beforeEach(() => jest.clearAllMocks());

const INPUT = { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-09-18T17:30:00+03:00' };

test('нет ни client_phone, ни ctx.clientPhone → needs_phone:true, YClients не зовётся', async () => {
  const res = await tool.run(1, INPUT, { dialogKey: '5245186003', channel: 'tdlib' });
  expect(res.needs_phone).toBe(true);
  expect(res.invalid_args).toBe(true);           // прежний контракт сохранён
  expect(res.error).toBe(NEEDS_PHONE_ERROR);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});

test('пустая строка / пробелы в client_phone — тоже «номера нет»', async () => {
  const res = await tool.run(1, { ...INPUT, client_phone: '   ' }, { dialogKey: 'k' });
  expect(res.needs_phone).toBe(true);
});

test('номер известен из вебхука → флага нет, запись идёт', async () => {
  const { run: listServices } = require('./services/agent/tools/list-services');
  listServices.mockResolvedValue({ services: [
    { yc_id: 10, title: 'Прокол ушей', category_path: ['Косметология'], staff: [{ yc_id: 5, name: 'Юлия' }] },
  ] });
  const res = await tool.run(1, INPUT, { dialogKey: 'k', clientPhone: '79001112233',
    nowMs: Date.parse('2026-09-10T10:00:00+03:00') });
  expect(res.needs_phone).toBeUndefined();
  expect(res.created).toBe(true);
});
