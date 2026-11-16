'use strict';
const mockTransactionQuery = jest.fn();
const mockMutate = jest.fn();
const mockGetRecord = jest.fn();
const mockStoreLive = jest.fn();
const mockSalonFor = jest.fn();

jest.mock('./config', () => ({ JWT_SECRET: 's'.repeat(32) }));
jest.mock('./db', () => ({
  withTransaction: jest.fn(async fn => fn({ query: mockTransactionQuery })),
}));
jest.mock('./services/journal', () => ({ mutate: mockMutate, salonFor: mockSalonFor }));
jest.mock('./services/journal/yclients', () => ({ getRecord: mockGetRecord }));
jest.mock('./services/journal/mirror', () => ({ storeLive: mockStoreLive }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { reschedule, operationId } = require('./services/mobile-booking');
const model = require('./services/journal/model');

const client = { clientId: 10, salonId: 1, yclientsClientId: 55, sessionToken: 'synthetic-session' };
const booking = {
  id: 100, salon_id: 1, yclients_record_id: 900, status: 'waiting',
  visit_datetime: '2030-04-01T10:00:00+03:00', yclients_client_id: 55,
};
const record = {
  id: 900, staff_id: 70, datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600,
  services: [{ id: 80 }], client: { id: 55 }, attendance: 0, deleted: false,
};
const target = '2030-04-02T12:00:00+03:00';
const key = '12345678-1234-4123-8123-123456789012';
const now = Date.parse('2030-04-01T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockTransactionQuery.mockResolvedValue({ rows: [{ ...booking }] });
  mockSalonFor.mockResolvedValue({ id: 1, yclients_company_id: 2 });
  mockGetRecord.mockResolvedValue({ ...record });
  mockMutate.mockImplementation(async () => {
    mockGetRecord.mockResolvedValue({ ...record, datetime: target });
    return { recordId: 900 };
  });
  mockStoreLive.mockResolvedValue(true);
});

test('confirmed move preserves staff, verifies client and mirrors only after YClients', async () => {
  const result = await reschedule(client, booking.id, target, key, now);
  expect(mockTransactionQuery).toHaveBeenCalledWith(expect.stringContaining('r.client_id=$2 AND r.salon_id=$3'), [booking.id, 10, 1, 55]);
  expect(mockMutate).toHaveBeenCalledWith(1, null, expect.objectContaining({
    operationId: key, recordId: 900, action: 'move', date: '2030-04-02', time: '12:00', staffId: 70,
  }), { expectedClientId: 55 });
  expect(mockStoreLive.mock.invocationCallOrder[0]).toBeGreaterThan(mockMutate.mock.invocationCallOrder[0]);
  expect(result).toMatchObject({ recordId: 100, dateTime: target, duplicate: false });
});

test('a done operation replay never sends another external mutation', async () => {
  mockMutate.mockImplementation(async () => {
    mockGetRecord.mockResolvedValue({ ...record, datetime: target });
    return { recordId: 900, duplicate: true };
  });
  const result = await reschedule(client, booking.id, target, key, now);
  expect(result.duplicate).toBe(true);
  expect(mockMutate).toHaveBeenCalledTimes(1);
  expect(mockStoreLive).toHaveBeenCalledTimes(1);
});

test.each([
  ['foreign local booking', async () => { mockTransactionQuery.mockResolvedValue({ rows: [] }); }, 404],
  ['cancelled local booking', async () => { mockTransactionQuery.mockResolvedValue({ rows: [{ ...booking, status: 'no_show' }] }); }, 409],
  ['past local booking', async () => { mockTransactionQuery.mockResolvedValue({ rows: [{ ...booking, visit_datetime: '2030-03-31T10:00:00+03:00' }] }); }, 409],
])('%s cannot reach YClients', async (_name, setup, status) => {
  await setup();
  await expect(reschedule(client, booking.id, target, key, now)).rejects.toMatchObject({ status });
  expect(mockSalonFor).not.toHaveBeenCalled();
  expect(mockGetRecord).not.toHaveBeenCalled();
  expect(mockMutate).not.toHaveBeenCalled();
  expect(mockStoreLive).not.toHaveBeenCalled();
});

test('foreign YClients owner is rejected before mutation and mirror', async () => {
  mockGetRecord.mockResolvedValue({ ...record, client: { id: 999 } });
  await expect(reschedule(client, booking.id, target, key, now)).rejects.toMatchObject({ status: 404 });
  expect(mockMutate).not.toHaveBeenCalled();
  expect(mockStoreLive).not.toHaveBeenCalled();
});

test.each([
  ['upstream rejection', new model.JournalError(409, 'Время уже занято.', 'slot_taken')],
  ['unknown timeout outcome', new model.JournalError(409, 'Результат не подтверждён.', 'uncertain')],
])('%s leaves local mirror untouched', async (_name, error) => {
  mockMutate.mockRejectedValue(error);
  await expect(reschedule(client, booking.id, target, key, now)).rejects.toBe(error);
  expect(mockStoreLive).not.toHaveBeenCalled();
});

test.each([null, '', 'not-a-date', '2030-04-01T00:00:00+03:00'])('invalid or past target has no effects: %s', async value => {
  await expect(reschedule(client, booking.id, value, key, now)).rejects.toMatchObject({ status: 400 });
  expect(mockTransactionQuery).not.toHaveBeenCalled();
  expect(mockMutate).not.toHaveBeenCalled();
});

test('a stale post-write read cannot report a confirmed move or overwrite the mirror', async () => {
  mockMutate.mockResolvedValue({ recordId: 900 });
  await expect(reschedule(client, booking.id, target, key, now)).rejects.toMatchObject({ status: 409, code: 'uncertain' });
  expect(mockStoreLive).not.toHaveBeenCalled();
});

test('a Moscow naive datetime retains backward-compatible interpretation', async () => {
  await reschedule(client, booking.id, '2030-04-02 12:00', key, now);
  expect(mockMutate.mock.calls[0][2]).toMatchObject({ date: '2030-04-02', time: '12:00' });
});

test('same-time retry is a no-op without a second PUT', async () => {
  mockGetRecord.mockResolvedValue({ ...record, datetime: target });
  await reschedule(client, booking.id, target, key, now);
  expect(mockMutate).not.toHaveBeenCalled();
  expect(mockStoreLive).toHaveBeenCalledTimes(1);
});

test('legacy requests get a stable scoped key, never a raw session token', () => {
  const one = operationId(client.sessionToken, 1, 10, 100, target);
  expect(one).toBe(operationId(client.sessionToken, 1, 10, 100, target));
  expect(one).not.toBe(operationId(client.sessionToken, 2, 10, 100, target));
  expect(one).not.toContain(client.sessionToken);
  expect(() => operationId(client.sessionToken, 1, 10, 100, target, 'bad')).toThrow();
});
