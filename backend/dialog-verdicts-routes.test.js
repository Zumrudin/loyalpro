'use strict';
jest.mock('./services/dialog-verdicts/store', () => ({ listVerdicts: jest.fn(), listUnanalyzed: jest.fn(), listRuns: jest.fn() }));
jest.mock('./services/dialog-verdicts/run', () => ({ runVerdicts: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./config');
const store = require('./services/dialog-verdicts/store');
const { runVerdicts } = require('./services/dialog-verdicts/run');
const router = require('./routes/dialog-verdicts');
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/verdicts', router);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/verdicts`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => jest.clearAllMocks());
async function request(path = '', { role = 'owner', body, noToken = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!noToken) headers.Authorization = 'Bearer ' + jwt.sign({ salonId: 42, userId: 7, role }, config.JWT_SECRET);
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
test.each(['specialist', 'admin_cashier', 'unknown'])('rejects role %s before data access', async role => {
  expect((await request('/runs', { role })).status).toBe(403);
  expect(store.listRuns).not.toHaveBeenCalled();
});
test('missing authentication rejected', async () => expect((await request('/runs', { noToken: true })).status).toBe(401));
test.each(['2026-02-30', '2026-13-01', '2026-10-00', 'bad'])('rejects invalid date %s', async from => {
  expect((await request(`?from=${from}&to=2026-10-03&status=booked`)).status).toBe(400);
  expect(store.listVerdicts).not.toHaveBeenCalled();
});
test('invalid status/channel and excessive period rejected', async () => {
  for (const q of ['from=2020-01-01&to=2026-10-03&status=booked', 'from=2026-10-01&to=2026-10-03&status=bad', 'from=2026-10-01&to=2026-10-03&status=booked&channel=%27']) {
    expect((await request('?' + q)).status).toBe(400);
  }
});
test('tenant comes from verified user, dates normalized', async () => {
  store.listVerdicts.mockResolvedValue({ rows: [], truncated: false });
  expect((await request('?from=2026-10-03&to=2026-10-01&status=booked&salonId=99', { role: 'admin' })).status).toBe(200);
  expect(store.listVerdicts).toHaveBeenCalledWith(42, { from: '2026-10-01', to: '2026-10-03', channel: '', status: 'booked' });
});
test('unanalyzed uses same authenticated tenant', async () => {
  store.listUnanalyzed.mockResolvedValue({ rows: [], truncated: false });
  expect((await request('?from=2026-10-01&to=2026-10-03&status=unanalyzed')).status).toBe(200);
  expect(store.listUnanalyzed.mock.calls[0][0]).toBe(42);
});
test('accepted, conflicting and invalid flag runs', async () => {
  const body = { from: '2026-10-01', to: '2026-10-03', salonId: 99, recompute: true };
  runVerdicts.mockResolvedValue({ runId: 3 });
  expect(await request('/run', { body })).toEqual({ status: 202, data: { runId: 3 } });
  expect(runVerdicts).toHaveBeenCalledWith({ salonId: 42, from: body.from, to: body.to, trigger: 'manual', recompute: true, onlyStale: false });
  runVerdicts.mockRejectedValue(Object.assign(new Error('busy'), { code: 'RUN_IN_PROGRESS' }));
  expect((await request('/run', { body })).status).toBe(409);
  expect((await request('/run', { body: { ...body, recompute: 'false' } })).status).toBe(400);
});
test('internal errors never appear in API response', async () => {
  store.listRuns.mockRejectedValue(new Error('PRIVATE_TEST_PAYLOAD'));
  const res = await request('/runs');
  expect(res.status).toBe(500); expect(JSON.stringify(res)).not.toContain('PRIVATE_TEST_PAYLOAD');
});
