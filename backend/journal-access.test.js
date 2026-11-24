'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./services/journal', () => ({ day: jest.fn(), week: jest.fn(), detail: jest.fn(), slots: jest.fn(), mutate: jest.fn(), pending: jest.fn(), review: jest.fn() }));
jest.mock('./services/journal/payments', () => ({ options: jest.fn(), pay: jest.fn(), review: jest.fn(), parse: jest.fn(v => v) }));
jest.mock('./services/journal/payments-local', () => ({ localPaymentOptions: jest.fn() }));
jest.mock('./services/journal/sessions', () => ({ enqueue: jest.fn(), validate: jest.fn(), parseSession: jest.fn(v => v), retry: jest.fn(), dismiss: jest.fn() }));
jest.mock('./services/journal/dispatch', () => ({ summary: jest.fn(), preview: jest.fn(), progress: jest.fn(), release: jest.fn() }));
jest.mock('./services/journal/staff-schedule', () => ({ enqueue: jest.fn(), changes: jest.fn(), recover: jest.fn(), parse: jest.fn(v => v) }));
jest.mock('./services/journal/month', () => ({ month: jest.fn() }));
jest.mock('./services/journal/day-summary', () => ({ load: jest.fn() }));
jest.mock('./services/journal/history', () => ({ load: jest.fn() }));
jest.mock('./services/journal/client-summary', () => ({ summary: jest.fn() }));
jest.mock('./services/journal/visit-history', () => ({ load: jest.fn() }));
jest.mock('./services/journal/client-loyalty', () => ({ load: jest.fn() }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => req.__user ? (req.user = req.__user, next()) : res.status(401).json({}),
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({}),
}));
const access = require('./services/journal/access');
const router = require('./routes/journal');
const service = require('./services/journal');
const sessions = require('./services/journal/sessions');
const payments = require('./services/journal/payments');
function call(method, url, { role = 'specialist', query = {}, body = {}, user } = {}) {
  return new Promise(resolve => {
    const res = { statusCode: 200, set() { return this; }, status(n) { this.statusCode = n; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); } };
    const request = { method, url, path: url.split('?')[0], query, body, headers: {}, __user: user === undefined ? { role, salonId: 3, userId: 4 } : user };
    router.handle(request, res, () => resolve({ status: 404 }));
  });
}
const dto = () => ({
  date: '2030-04-01', records: [{ id: 81, clientId: 42, datetime: '2030-04-01T10:00:00+03:00',
    client: { id: 42, name: 'Синтетический пациент', phone: '70000000001', mobile: '+7 (000) 000-00-02', telephone: '80000000003' },
    raw_payload: { client_phone: '70000000001', nested: [{ phoneNumber: '70000000001', contactPhone: '70000000001', tel: '70000000001' }] },
    comment: 'Связаться: +7 (000) 000-00-01 или 8 000 000 00 02',
    _sync: { errorText: 'Ответ содержит 70000000001', status: 'failed' }, services: [{ id: 9, title: 'Услуга' }],
  }], history: [{ before: { phone: '70000000001' }, after: { comment: 'Телефон 70000000001' } }],
});
beforeEach(() => jest.clearAllMocks());

test.each(['owner', 'admin', 'admin_cashier'])('%s may edit and see phones', role => {
  expect(access.canEdit(role)).toBe(true);
  expect(access.canViewPhones(role)).toBe(true);
  expect(access.allowed(role, 'GET', '/day')).toBe(true);
  expect(access.allowed(role, 'POST', '/sessions')).toBe(true);
  expect(JSON.stringify(access.present(dto(), role))).toContain('70000000001');
});
test.each(['specialist', 'unknown', undefined])('%s cannot edit or see phones', role => {
  expect(access.canEdit(role)).toBe(false);
  expect(access.canViewPhones(role)).toBe(false);
  expect(access.allowed(role, 'POST', '/sessions')).toBe(false);
});
test.each(['/day', '/week', '/month', '/day-summary', '/records/81', '/records/-7', '/records/81/history', '/records/-7/history'])('specialist can read %s', path => {
  expect(access.allowed('specialist', 'GET', path)).toBe(true);
});
test.each(['/clients/summary', '/clients/visits', '/clients/loyalty', '/slots', '/payments/81', '/operations/pending', '/dispatch/summary', '/dispatch/preview', '/staff-schedule/changes', '/records/81/history/export', '/day/extra'])('specialist cannot read shortcut %s', path => {
  expect(access.allowed('specialist', 'GET', path)).toBe(false);
});
test('unknown role has no journal route access', () => {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) expect(access.allowed('unknown', method, '/day')).toBe(false);
});
test('specialist DTO removes phone keys and masks phones in nested free text without mutating source', () => {
  const source = dto(), before = JSON.stringify(source);
  const result = access.present(source, 'specialist');
  const output = JSON.stringify(result);
  expect(output).not.toMatch(/70000000001|80000000003|000\) 000|000 000 00/);
  expect(output).toContain('[телефон скрыт]');
  const record = result.records[0];
  expect(record.client).not.toHaveProperty('phone');
  expect(record.client).not.toHaveProperty('mobile');
  expect(record.client).not.toHaveProperty('telephone');
  expect(record.raw_payload).not.toHaveProperty('client_phone');
  expect(record.raw_payload.nested[0]).toEqual({});
  expect(record.services).toEqual([{ id: 9, title: 'Услуга' }]);
  expect(record.id).toBe(81);
  expect(record.datetime).toBe('2030-04-01T10:00:00+03:00');
  expect(JSON.stringify(source)).toBe(before);
});
test('specialist receives redacted day data, server salon and capabilities despite spoofed role', async () => {
  service.day.mockResolvedValue(dto());
  const result = await call('GET', '/day', { query: { date: '2030-04-01', role: 'owner', salonId: 999 }, body: { role: 'owner' } });
  expect(result.status).toBe(200);
  expect(service.day).toHaveBeenCalledWith(3, '2030-04-01');
  expect(JSON.stringify(result.body)).not.toContain('70000000001');
  expect(result.body.capabilities).toMatchObject({ canEdit: false, canViewPhones: false });
});
test.each(['/sessions', '/create', '/cancel', '/confirm', '/payments', '/dispatch', '/sessions/81/retry'])('specialist write %s is denied before service even with spoofed role', async path => {
  const result = await call('POST', path, { query: { role: 'owner' }, body: { role: 'owner', user: { role: 'owner' }, salonId: 999 } });
  expect(result.status).toBe(403);
  for (const fn of [service.mutate, sessions.enqueue, sessions.retry, payments.pay]) expect(fn).not.toHaveBeenCalled();
});
test('cashier can save journal session, with server tenant and author', async () => {
  sessions.enqueue.mockResolvedValue({ outboxId: 9 });
  expect((await call('POST', '/sessions', { role: 'admin_cashier', body: { role: 'owner', salonId: 999, userId: 999 } })).status).toBe(200);
  expect(sessions.enqueue.mock.calls[0].slice(0, 2)).toEqual([3, 4]);
});
test.each(['specialist', 'admin_cashier', 'admin'])('owner-only operations stay forbidden to %s', async role => {
  expect((await call('POST', '/operations/review', { role, body: { checkedInYclients: true, role: 'owner' } })).status).toBe(403);
  expect(service.review).not.toHaveBeenCalled();
});
test('specialist validation error is redacted too', async () => {
  const { JournalError } = require('./services/journal/model');
  service.day.mockRejectedValue(new JournalError(400, 'Связаться +7 (000) 000-00-01', 'synthetic'));
  const result = await call('GET', '/day', { query: { date: '2030-04-01' } });
  expect(result.status).toBe(400);
  expect(JSON.stringify(result.body)).not.toContain('000) 000');
  expect(JSON.stringify(result.body)).toContain('[телефон скрыт]');
});
test('cashier cannot bypass staff schedule management restriction', async () => {
  const schedule = require('./services/journal/staff-schedule');
  expect((await call('POST', '/staff-schedule', { role: 'admin_cashier', body: { role: 'owner' } })).status).toBe(403);
  expect(schedule.enqueue).not.toHaveBeenCalled();
});
test.each(['owner', 'admin', 'admin_cashier', 'specialist'])('capability response accurately describes %s', role => {
  const privileged = role !== 'specialist';
  expect(access.present({}, role).capabilities).toEqual({
    canEdit: privileged, canViewPhones: privileged, canUseClientTools: privileged,
    canManageSchedule: ['owner', 'admin'].includes(role),
  });
});
test('unknown staff cannot read journal even if query advertises owner role', async () => {
  expect((await call('GET', '/day', { role: 'unknown', query: { role: 'owner', date: '2030-04-01' } })).status).toBe(403);
  expect(service.day).not.toHaveBeenCalled();
});
test('phone concatenated with a patient name or messenger label stays private', () => {
  const result = access.present({ clientName: 'Пациент70000000001', comment: 'WhatsApp70000000002' }, 'specialist');
  expect(JSON.stringify(result)).not.toMatch(/7000000000[12]/);
});
test('alternate mobile and tel field spellings are removed recursively', () => {
  const result = access.present({ nested: { mobile_number: '70000000001', contactMobile: '70000000002', telNumber: '70000000003' } }, 'specialist');
  expect(result.nested).toEqual({});
});
test.each([['GET', '/staff-schedule/changes'], ['POST', '/staff-schedule/81/retry'], ['POST', '/staff-schedule/81/dismiss']])('cashier cannot manage schedule through %s %s', async (method, path) => {
  const schedule = require('./services/journal/staff-schedule');
  expect((await call(method, path, { role: 'admin_cashier', query: { role: 'owner' }, body: { role: 'owner' } })).status).toBe(403);
  expect(schedule.changes).not.toHaveBeenCalled();
  expect(schedule.recover).not.toHaveBeenCalled();
});
