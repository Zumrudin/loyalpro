'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./services/journal/payments', () => ({options:jest.fn(),pay:jest.fn(),review:jest.fn(),parse:jest.fn(v=>v)}));
jest.mock('./services/journal/payments-local', () => ({localPaymentOptions:jest.fn()}));
jest.mock('./services/journal', () => ({ day: jest.fn(), week: jest.fn(), detail: jest.fn(), slots: jest.fn(), mutate: jest.fn(), pending: jest.fn(), review: jest.fn() }));
jest.mock('./services/journal/staff-schedule', () => ({ ...jest.requireActual('./services/journal/staff-schedule'), enqueue: jest.fn(), changes: jest.fn(), recover: jest.fn() }));
jest.mock('./services/journal/month', () => ({ month: jest.fn() }));
jest.mock('./services/journal/day-summary', () => ({ load: jest.fn() }));
jest.mock('./services/journal/history', () => ({ load: jest.fn() }));
jest.mock('./services/journal/client-summary', () => ({ summary: jest.fn() }));
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
test('day summary scopes by JWT, validates date, restricts role, and sanitizes errors', async () => {
  const summary = require('./services/journal/day-summary');
  summary.load.mockResolvedValue({date:'2030-04-02',total:0,clientCount:0});
  const query = {date:'2030-04-02',salonId:99};
  const result = await call('GET','/day-summary',{query});
  expect(result.status).toBe(200);
  expect(result.headers['Cache-Control']).toBe('no-store');
  expect(summary.load).toHaveBeenCalledWith(3,'2030-04-02');
  summary.load.mockClear();
  expect((await call('GET','/day-summary',{query:{date:'2030-02-30'}})).status).toBe(400);
  expect((await call('GET','/day-summary',{query,user:null})).status).toBe(401);
  expect((await call('GET','/day-summary',{query,user:{role:'specialist',salonId:3}})).status).toBe(403);
  expect(summary.load).not.toHaveBeenCalled();
  summary.load.mockRejectedValue(new Error('synthetic-private-error'));
  const failed = await call('GET','/day-summary',{query});
  expect(failed.status).toBe(502);
  expect(JSON.stringify(failed)).not.toContain('synthetic-private-error');
});
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

test('week and month: validated input, tenant from JWT', async () => {
  const month = require('./services/journal/month');
  service.week.mockResolvedValue({ days: [] }); month.month.mockResolvedValue({ days: [] });
  expect((await call('GET', '/week', { query: { date: '2030-04-01', staffId: '5', salonId: 99 } })).status).toBe(200);
  expect(service.week).toHaveBeenCalledWith(3, '2030-04-01', 5);
  expect((await call('GET', '/week', { query: { date: '2030-04-01' } })).status).toBe(200);
  expect(service.week).toHaveBeenLastCalledWith(3, '2030-04-01', null);
  expect((await call('GET', '/week', { query: { date: 'x' } })).status).toBe(400);
  expect((await call('GET', '/month', { query: { month: '2030-04' } })).status).toBe(200);
  expect(month.month).toHaveBeenCalledWith(3, '2030-04');
  expect((await call('GET', '/week', { user: { role: 'specialist' }, query: { date: '2030-04-01' } })).status).toBe(403);
});

test('record history: id validated, tenant from JWT', async () => {
  const history = require('./services/journal/history');
  history.load.mockResolvedValue({ recordId: 8, events: [] });
  expect((await call('GET', '/records/8/history')).status).toBe(200);
  expect(history.load).toHaveBeenCalledWith(3, 8);
  expect((await call('GET', '/records/-4/history')).status).toBe(200);
  expect(history.load).toHaveBeenLastCalledWith(3, -4);
  expect((await call('GET', '/records/abc/history')).status).toBe(400);
});

test('client summary: tenant from JWT, query passed as is (validated in the module)', async () => {
  const cs = require('./services/journal/client-summary');
  cs.summary.mockResolvedValue({ name: 'A' });
  const res = await call('GET', '/clients/summary', { query: { phone: '79200255591', salonId: 99 } });
  expect(res.status).toBe(200); expect(res.headers['Cache-Control']).toBe('no-store');
  expect(cs.summary).toHaveBeenCalledWith(3, expect.objectContaining({ phone: '79200255591' }));
  expect((await call('GET', '/clients/summary', { user: { role: 'admin_cashier' }, query: { phone: '79200255591' } })).status).toBe(403);
});

const schedule = require('./services/journal/staff-schedule');
test('split shift validates breaks at the route and keeps the authenticated tenant', async () => {
  const body = {sessionId:'12345678-1234-4123-8123-123456789012',staffId:5,date:'2030-04-02',action:'add',
    start:'10:00',end:'22:00',breaks:[{start:'13:00',end:'14:00'}],salonId:99,userId:99};
  expect((await call('POST','/staff-schedule',{body})).status).toBe(200);
  expect(schedule.enqueue).toHaveBeenCalledWith(3,4,expect.objectContaining({breaks:[{start:'13:00',end:'14:00'}]}));
  expect(schedule.enqueue.mock.calls[0][2]).not.toHaveProperty('salonId');
  schedule.enqueue.mockClear();
  expect((await call('POST','/staff-schedule',{body:{...body,breaks:[{start:'09:00',end:'14:00'}]}})).status).toBe(400);
  expect(schedule.enqueue).not.toHaveBeenCalled();
});
test('schedule mutations and recovery derive tenant/user from auth', async () => {
  const body = { sessionId:'12345678-1234-4123-8123-123456789012', staffId:5, date:'2030-04-01', action:'remove', salonId:99, userId:99 };
  expect((await call('POST','/staff-schedule',{body})).status).toBe(200);
  expect(schedule.enqueue).toHaveBeenCalledWith(3,4,expect.not.objectContaining({salonId:99}));
  await call('GET','/staff-schedule/changes',{query:{salonId:99}});
  expect(schedule.changes).toHaveBeenCalledWith(3);
  await call('POST','/staff-schedule/21/dismiss',{body:{salonId:99}});
  expect(schedule.recover).toHaveBeenCalledWith(3,21,'dismiss');
});
test('schedule endpoints reject missing auth, other roles, invalid dates and IDs', async () => {
  for (const [method,url] of [['POST','/staff-schedule'],['GET','/staff-schedule/changes'],['POST','/staff-schedule/21/retry']]) {
    expect((await call(method,url,{user:null})).status).toBe(401);
    expect((await call(method,url,{user:{role:'specialist'}})).status).toBe(403);
  }
  expect((await call('POST','/staff-schedule',{body:{sessionId:'12345678-1234-4123-8123-123456789012',staffId:5,date:'2030-02-30',action:'remove'}})).status).toBe(400);
  expect((await call('POST','/staff-schedule/invalid/dismiss')).status).toBe(400);
  expect(schedule.enqueue).not.toHaveBeenCalled(); expect(schedule.recover).not.toHaveBeenCalled();
});
