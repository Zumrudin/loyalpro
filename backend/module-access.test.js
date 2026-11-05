'use strict';
process.env.JWT_SECRET = 'isolated-module-access-test-secret-20261105';
jest.mock('./db', () => ({ db: { any: jest.fn(), query: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() }, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/economics/store');
jest.mock('./services/economics/report');
jest.mock('./services/economics/sync');
jest.mock('./services/broadcast');
jest.mock('./services/broadcast-messengers/service');
jest.mock('./services/notifications/settings');
const jwt = require('jsonwebtoken');
const config = require('./config');
const store = require('./services/economics/store');
const broadcasts = require('./services/broadcast');
const settings = require('./services/notifications/settings');
const routers = {
  economics: require('./routes/economics'),
  broadcasts: require('./routes/broadcasts'),
  notifications: require('./routes/notification-rules'),
};
function call(router, method, url, role, body) {
  const headers = role ? { authorization: 'Bearer ' + jwt.sign({ role, salonId: 7, userId: 3 }, config.JWT_SECRET) } : {};
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; } };
    router.handle({ method, url, headers, query: { salonId: 999 }, body }, res, e => e ? reject(e) : resolve({ status: 404 }));
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  store.getSettings.mockResolvedValue({}); store.listAccounts.mockResolvedValue([]);
  store.insertPayScheme.mockResolvedValue(42);
  broadcasts.listBroadcasts.mockResolvedValue([]);
  settings.getSettings.mockResolvedValue({ mode: 'off' });
});
test.each(['owner', 'admin'])('%s can read all modules using the authenticated salon', async role => {
  expect((await call(routers.economics, 'GET', '/settings', role)).status).toBe(200);
  expect(store.getSettings).toHaveBeenCalledWith(7);
  expect((await call(routers.broadcasts, 'GET', '/', role)).status).toBe(200);
  expect(broadcasts.listBroadcasts).toHaveBeenCalledWith(7, expect.any(Object));
  expect((await call(routers.notifications, 'GET', '/settings', role)).status).toBe(200);
  expect(settings.getSettings).toHaveBeenCalledWith(7);
  expect((await call(routers.economics, 'POST', '/pay-schemes', role, { title: 'Test', lines: [{ percent: 10, base: 'gross', categories: [], services: [] }] })).status).toBe(200);
  expect(store.insertPayScheme).toHaveBeenCalledWith(7, expect.any(Object));
});
test.each(['specialist', 'admin_cashier', 'unknown', null])('%s cannot read or mutate either module', async role => {
  const expected = role ? 403 : 401;
  for (const [router, method, url] of [
    [routers.economics, 'GET', '/settings'], [routers.economics, 'POST', '/pay-schemes'],
    [routers.economics, 'PUT', '/settings'], [routers.economics, 'POST', '/sync'],
    [routers.broadcasts, 'GET', '/'], [routers.broadcasts, 'POST', '/'],
    [routers.broadcasts, 'POST', '/test'], [routers.broadcasts, 'POST', '/1/resume'],
    [routers.notifications, 'GET', '/settings'], [routers.notifications, 'PUT', '/settings'],
  ]) expect((await call(router, method, url, role, {})).status).toBe(expected);
  expect(store.getSettings).not.toHaveBeenCalled();
  expect(store.insertPayScheme).not.toHaveBeenCalled();
  expect(broadcasts.listBroadcasts).not.toHaveBeenCalled();
  expect(settings.getSettings).not.toHaveBeenCalled();
});
