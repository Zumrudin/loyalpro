'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./services/journal/payments', () => ({options:jest.fn(),pay:jest.fn(),review:jest.fn(),parse:jest.fn(v=>v)}));
jest.mock('./services/journal/payments-local', () => ({localPaymentOptions:jest.fn()}));
jest.mock('./services/journal', () => ({ day: jest.fn(), detail: jest.fn(), slots: jest.fn(), mutate: jest.fn(), pending: jest.fn(), review: jest.fn() }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => req.__user ? (req.user = req.__user, next()) : res.status(401).json({}),
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({}),
}));
const service = require('./services/journal');
const router = require('./routes/journal');
function call(method, url, { user = { role: 'owner', salonId: 3, userId: 4 }, query = {}, body } = {}) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, set(k,v) { this.headers[k]=v; return this; }, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); } };
    router.handle({ method, url, query, body, headers: {}, __user: user }, res, () => resolve({ status: 404 }));
  });
}
beforeEach(() => jest.clearAllMocks());
test.each(['specialist','admin_cashier','unknown'])('rejects %s on reads and writes', async role => {
  expect((await call('GET', '/day', { user: { role } })).status).toBe(403);
  expect((await call('POST', '/create', { user: { role } })).status).toBe(403);
  expect(service.day).not.toHaveBeenCalled(); expect(service.mutate).not.toHaveBeenCalled();
});
test('requires auth', async () => expect((await call('GET', '/day', { user: null })).status).toBe(401));
test('tenant comes from JWT; responses are not cacheable', async () => {
  service.day.mockResolvedValue({ records: [] });
  const res = await call('GET', '/day', { query: { date: '2030-04-01', salonId: 999 } });
  expect(res.status).toBe(200); expect(res.headers['Cache-Control']).toBe('no-store');
  expect(service.day).toHaveBeenCalledWith(3, '2030-04-01');
});
test('invalid date and identifiers do not call integration', async () => {
  expect((await call('GET', '/day', { query: { date: '2030-02-30' } })).status).toBe(400);
  expect((await call('GET', '/records/nope')).status).toBe(400);
  expect(service.day).not.toHaveBeenCalled(); expect(service.detail).not.toHaveBeenCalled();
});
test('upstream error is sanitized', async () => {
  service.day.mockRejectedValue(new Error('synthetic-sensitive-value'));
  const res = await call('GET', '/day', { query: { date: '2030-04-01' } });
  expect(res.status).toBe(502); expect(JSON.stringify(res)).not.toContain('synthetic-sensitive-value');
});
test('write ignores client tenant and user IDs', async () => {
  service.mutate.mockResolvedValue({ recordId: 8 });
  const body = { operationId: '12345678-1234-4123-8123-123456789012', recordId: 8, version: 'a'.repeat(64), salonId: 99, userId: 99 };
  expect((await call('POST', '/confirm', { body })).status).toBe(200);
  expect(service.mutate.mock.calls[0].slice(0,2)).toEqual([3,4]);
  expect(service.mutate.mock.calls[0][2]).not.toHaveProperty('salonId');
});

test('only owner may review uncertain operations and must explicitly attest', async () => {
  const body = { operationId: '12345678-1234-4123-8123-123456789012', checkedInYclients: true };
  expect((await call('POST', '/operations/review', { user: { role: 'admin', salonId: 3 }, body })).status).toBe(403);
  expect((await call('POST', '/operations/review', { body: { ...body, checkedInYclients: false } })).status).toBe(400);
  service.review.mockResolvedValue({ reviewed: true });
  expect((await call('POST', '/operations/review', { body: { ...body, salonId: 99 } })).status).toBe(200);
  expect(service.review).toHaveBeenCalledWith(3, 4, body.operationId);
});

test('payment endpoints require role and derive tenant/user from authorization', async () => {
 const payments=require('./services/journal/payments');
 expect((await call('GET','/payments/8',{user:{role:'specialist'}})).status).toBe(403);
 expect((await call('POST','/payments/review',{user:{role:'admin'}})).status).toBe(403);
 expect((await call('POST','/payments',{body:{salonId:999,userId:999}})).status).toBe(200);
 expect(payments.pay).toHaveBeenCalledWith(3,4,expect.anything());
 await call('GET','/payments/8');expect(payments.options).toHaveBeenCalledWith(3,8);
});

test('payment form ?local=1 reads the local loader, accepts queued negative ids', async () => {
 const payments=require('./services/journal/payments');
 const local=require('./services/journal/payments-local');
 local.localPaymentOptions.mockResolvedValue({local:true});
 expect((await call('GET','/payments/-7',{query:{local:'1'}})).body).toEqual({local:true});
 expect(local.localPaymentOptions).toHaveBeenCalledWith(3,-7);
 expect(payments.options).not.toHaveBeenCalled();
 expect((await call('GET','/payments/-7')).status).toBe(400);
 expect((await call('GET','/payments/0',{query:{local:'1'}})).status).toBe(400);
});
