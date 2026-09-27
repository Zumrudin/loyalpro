'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-signing-secret' }));
jest.mock('./services/agent/model-routing', () => ({ getStore: jest.fn() }));
const { getStore } = require('./services/agent/model-routing');
const router = require('./routes/agent-model');
let server, url, store;
beforeEach(async () => {
  store = { status: jest.fn(async () => ({ active: 'gpt' })), manual: jest.fn(), acknowledge: jest.fn() };
  getStore.mockReturnValue(store);
  const app = express(); app.use(express.json()); app.use('/api/agent/model', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}/api/agent/model`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
function request(role = 'admin', body, method = 'GET', path = '') {
  const headers = { 'content-type': 'application/json' };
  if (role) headers.authorization = 'Bearer ' + jwt.sign({ role, salonId: 17, userId: 4 }, 'synthetic-test-signing-secret');
  return fetch(url + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
test.each([null, 'specialist', 'admin_cashier'])('rejects role %s on read/write/ack', async role => {
  for (const [method, path] of [['GET', ''], ['PUT', ''], ['POST', '/acknowledge']]) {
    const res = await request(role, method === 'GET' ? null : {}, method, path);
    expect(res.status).toBe(role ? 403 : 401); await res.text();
  }
  expect(store.status).not.toHaveBeenCalled(); expect(store.manual).not.toHaveBeenCalled();
});
test.each(['owner', 'admin'])('%s reads and changes own salon, ignores forged tenant/user', async role => {
  const get = await request(role); expect(get.status).toBe(200);
  expect(get.headers.get('cache-control')).toBe('no-store'); await get.text();
  expect(store.status).toHaveBeenCalledWith(17, 4);
  const put = await request(role, { active: 'claude', revision: '3', salonId: 99, userId: 99 }, 'PUT');
  expect(put.status).toBe(200); await put.text();
  expect(store.manual).toHaveBeenCalledWith(17, 'claude', '3');
  const ack = await request(role, { revision: '3', salonId: 99, userId: 99 }, 'POST', '/acknowledge');
  expect(ack.status).toBe(200); await ack.text();
  expect(store.acknowledge).toHaveBeenCalledWith(17, 4, '3');
});
test.each([['BAD_SELECTION', 400], ['CONFLICT', 409], ['DB_DOWN', 500]])('sanitizes %s', async (code, status) => {
  store.manual.mockRejectedValue(Object.assign(new Error('synthetic-private-detail'), { code }));
  const res = await request('admin', { active: 'gpt', revision: '1' }, 'PUT');
  expect(res.status).toBe(status); expect(await res.text()).not.toContain('synthetic-private-detail');
});
