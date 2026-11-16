'use strict';
const mockReschedule = jest.fn();
const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.mock('./middleware/mobile-auth', () => ({ mobileAuth: jest.fn() }));
jest.mock('./services/mobile-booking', () => ({ reschedule: mockReschedule }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetClientCards: jest.fn(), ycGetCardTransactions: jest.fn() }));
jest.mock('./services/yclients-records', () => ({ updateAttendance: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const { db } = require('./db');
const router = require('./routes/mobile-client');

jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), any: jest.fn(), many: jest.fn(), query: jest.fn() },
}));

function handler(path, method) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[String(method).toLowerCase()]);
  if (!layer) throw new Error('Missing route');
  return layer.route.stack.at(-1).handle;
}
async function invoke(path, method = 'GET', extra = {}) {
  const req = {
    params: {}, query: {}, body: {},
    client: { clientId: 10, salonId: 1, yclientsClientId: 55 },
    token: 'synthetic-session', protocol: 'http', get: () => 'test.local', ...extra,
  };
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  await handler(path, method)(req, res);
  return { req, res };
}
function response(res) {
  return { status: res.status.mock.calls[0]?.[0] || 200, body: res.json.mock.calls[0]?.[0] };
}
beforeEach(() => {
  jest.clearAllMocks();
  db.any.mockResolvedValue([]);
  db.many.mockResolvedValue([]);
  db.query.mockResolvedValue({ rows: [] });
});

test('profile uses both client and salon rather than re-deriving tenant by global id', async () => {
  db.one.mockResolvedValueOnce({ id: 10 }).mockResolvedValueOnce({ id: 1 });
  const { res } = await invoke('/profile');
  expect(response(res).status).toBe(200);
  expect(db.one.mock.calls[0][1]).toEqual([10, 1]);
  expect(db.one.mock.calls[0][0]).toContain('WHERE id=$1 AND salon_id=$2');
  expect(db.one.mock.calls[1]).toEqual([expect.stringContaining('FROM salons WHERE id=$1 AND is_active=TRUE'), [1]]);
});

test('booking lists and details are tenant scoped', async () => {
  const { req } = await invoke('/bookings', 'GET', { query: { type: 'upcoming' } });
  expect(db.any.mock.calls[0][1]).toEqual([10, 1]);
  expect(db.any.mock.calls[0][0]).toContain('r.salon_id=$2');
  expect(db.any.mock.calls[0][0]).toContain('salon_id = $2');

  db.oneOrNone.mockResolvedValue(null);
  const detail = await invoke('/bookings/:bookingId', 'GET', { params: { bookingId: '100' } });
  expect(response(detail.res).status).toBe(404);
  expect(db.oneOrNone.mock.calls[0][1]).toEqual(['100', 10, 1]);
});

test('reschedule delegates to idempotent service with server session identity', async () => {
  mockReschedule.mockResolvedValue({ recordId: 100, dateTime: '2030-04-02T12:00:00+03:00' });
  const { res } = await invoke('/bookings/:bookingId/reschedule', 'POST', {
    params: { bookingId: '100' },
    body: { newDateTime: '2030-04-02T12:00:00+03:00', salonId: 2, clientId: 99 },
    get: () => '12345678-1234-4123-8123-123456789012',
  });
  expect(response(res)).toMatchObject({ status: 200, body: { success: true } });
  expect(mockReschedule).toHaveBeenCalledWith({
    clientId: 10, salonId: 1, yclientsClientId: 55, sessionToken: 'synthetic-session',
  }, '100', '2030-04-02T12:00:00+03:00', '12345678-1234-4123-8123-123456789012');
  expect(db.query).not.toHaveBeenCalled();
});

test('reschedule never exposes an upstream error or writes local date on failure', async () => {
  mockReschedule.mockRejectedValue(new Error('synthetic-provider-marker'));
  const { res } = await invoke('/bookings/:bookingId/reschedule', 'POST', {
    params: { bookingId: '100' }, body: { newDateTime: '2030-04-02T12:00:00+03:00' }, get: () => undefined,
  });
  expect(response(res)).toEqual({ status: 502, body: { error: 'Не удалось перенести запись' } });
  expect(db.query).not.toHaveBeenCalled();
  expect(JSON.stringify(mockLog)).not.toContain('synthetic-provider-marker');
});

test('internal mobile failures use a generic response and redacted logs', async () => {
  db.one.mockRejectedValue(new Error('synthetic-private-database-marker'));
  const { res } = await invoke('/profile');
  expect(response(res)).toEqual({ status: 500, body: { error: 'Внутренняя ошибка сервера' } });
  expect(JSON.stringify(mockLog)).not.toContain('synthetic-private-database-marker');
});

test('foreign notification and checklist item cannot be modified', async () => {
  db.one.mockResolvedValue(null);
  db.oneOrNone.mockResolvedValue(null);
  const notification = await invoke('/notifications/:notificationId/read', 'POST', { params: { notificationId: '200' } });
  expect(response(notification.res).status).toBe(404);
  const completion = await invoke('/today-checklist/items/:itemId/complete', 'POST', { params: { itemId: '300' } });
  expect(response(completion.res).status).toBe(404);
  expect(db.query).not.toHaveBeenCalled();
});

test('prescriptions, portfolio and specialists use the session salon', async () => {
  await invoke('/prescriptions');
  expect(db.any.mock.calls[0][1]).toEqual([10, 1]);
  await invoke('/specialists');
  expect(db.any.mock.calls.at(-1)[0]).toContain('salon_id = $1');
  expect(db.any.mock.calls.at(-1)[1]).toEqual([1]);
  await invoke('/portfolio/categories');
  expect(db.any.mock.calls.at(-1)[0]).toContain('c.salon_id = $1');
  expect(db.any.mock.calls.at(-1)[1]).toEqual([1]);

  db.oneOrNone.mockResolvedValue({ id: 400, title: 'Synthetic' });
  await invoke('/portfolio/categories/:id', 'GET', { params: { id: '400' } });
  expect(db.oneOrNone.mock.calls.at(-1)[1]).toEqual([400, 1]);
  expect(db.any.mock.calls.at(-1)[1]).toEqual([1, 400]);
});
