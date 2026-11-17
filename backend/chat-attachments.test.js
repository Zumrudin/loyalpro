'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('./config');

const mockDb = { oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() };
jest.mock('./db', () => ({ db: mockDb, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const router = require('./routes/chat');
const { gatewayAttachmentPath, privateAttachmentUrl } = router._internals;
const route = router.stack.find(layer => layer.route?.path === '/attachments/:messageId').route;
const handler = route.stack.at(-1).handle;

function response() {
  const res = { status: jest.fn(), json: jest.fn(), end: jest.fn(), set: jest.fn(), sendFile: jest.fn() };
  res.status.mockReturnValue(res);
  res.set.mockReturnValue(res);
  return res;
}

let realpathSpy;
beforeEach(() => {
  jest.clearAllMocks();
  realpathSpy = jest.spyOn(fs.promises, 'realpath').mockImplementation(async value => path.resolve(value));
});
afterEach(() => realpathSpy.mockRestore());

test('raw gateway files are denied before express.static', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const deny = source.indexOf('// Gateway media is private');
  const staticMount = source.indexOf('app.use(express.static');
  expect(deny).toBeGreaterThan(-1);
  expect(deny).toBeLessThan(staticMount);
  expect(source.slice(deny, staticMount)).toMatch(/status\(404\)/);
});

test('anonymous attachment request is rejected by route auth', async () => {
  const req = { headers: {}, method: 'GET', path: '/attachments/1', originalUrl: '/api/chat/attachments/1' };
  const res = response();
  await route.stack[0].handle(req, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockDb.oneOrNone).not.toHaveBeenCalled();
});

test('revoked staff session cannot download an attachment', async () => {
  const token = jwt.sign({ userId: 10, salonId: 7, role: 'owner' }, config.JWT_SECRET, { expiresIn: '5m' });
  mockDb.oneOrNone.mockResolvedValue(null);
  const req = { headers: { authorization: 'Bearer ' + token }, method: 'GET', path: '/attachments/1', originalUrl: '/api/chat/attachments/1' };
  const res = response();
  await route.stack[0].handle(req, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json).toHaveBeenCalledWith({ error: 'Session expired or revoked' });
});

test('specialist role cannot download chat attachments', () => {
  const res = response();
  route.stack[1].handle({ user: { salonId: 7, role: 'specialist' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});

test('normal same-salon active gateway message is served privately', async () => {
  mockDb.oneOrNone.mockResolvedValue({
    file_url: '/uploads/gateway/202/1700000000_abcdef0123456789.jpg',
    mime_type: 'image/jpeg', account_id: 202,
  });
  const req = { params: { messageId: '91' }, user: { salonId: 7 } };
  const res = response();
  await handler(req, res);
  expect(mockDb.oneOrNone).toHaveBeenCalledWith(expect.stringMatching(/ma\.salon_id = cm\.salon_id[\s\S]*cm\.salon_id = \$2/), [91, 7]);
  expect(res.sendFile).toHaveBeenCalledWith(
    path.resolve(__dirname, '../frontend/uploads/gateway/202/1700000000_abcdef0123456789.jpg'),
    expect.any(Function)
  );
  expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
    'Cache-Control': 'private, no-store', 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline',
  }));
});

test('untrusted executable MIME is forced to an opaque download', async () => {
  mockDb.oneOrNone.mockResolvedValue({
    file_url: '/uploads/gateway/202/file.bin', mime_type: 'text/html; charset=utf-8', account_id: 202,
  });
  const res = response();
  await handler({ params: { messageId: '92' }, user: { salonId: 7 } }, res);
  expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
    'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment',
  }));
});

test.each([
  ['wrong tenant', null],
  ['removed account', null],
])('%s gets a non-enumerating 404', async (_label, row) => {
  mockDb.oneOrNone.mockResolvedValue(row);
  const res = response();
  await handler({ params: { messageId: '91' }, user: { salonId: 8 } }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.sendFile).not.toHaveBeenCalled();
});

test('path traversal and account-directory mismatch are rejected', async () => {
  for (const file_url of [
    '/uploads/gateway/202/../secret.txt',
    '/uploads/gateway/203/file.jpg',
    '/uploads/gateway/202/nested/file.jpg',
  ]) {
    mockDb.oneOrNone.mockResolvedValueOnce({ file_url, mime_type: 'text/plain', account_id: 202 });
    const res = response();
    await handler({ params: { messageId: '91' }, user: { salonId: 7 } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  }
  expect(gatewayAttachmentPath('/uploads/gateway/202/file.jpg', 202)).toContain('/gateway/202/file.jpg');
});

test('a symlinked file cannot escape its real account directory', async () => {
  mockDb.oneOrNone.mockResolvedValue({
    file_url: '/uploads/gateway/202/file.jpg', mime_type: 'image/jpeg', account_id: 202,
  });
  realpathSpy.mockImplementation(async value => String(value).endsWith('file.jpg')
    ? '/private/outside/file.jpg' : '/real/uploads/gateway/202');
  const res = response();
  await handler({ params: { messageId: '93' }, user: { salonId: 7 } }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.sendFile).not.toHaveBeenCalled();
});

test('history and SSE expose protected URLs only for local gateway media', () => {
  expect(privateAttachmentUrl({ id: 91, file_url: '/uploads/gateway/202/file.jpg' }))
    .toBe('/api/chat/attachments/91');
  expect(privateAttachmentUrl({ id: 92, file_url: 'https://provider.invalid/file.jpg' }))
    .toBe('https://provider.invalid/file.jpg');
});
