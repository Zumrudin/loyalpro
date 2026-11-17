'use strict';

const { ReadableStream } = require('stream/web');
const { remoteAttachmentUrl, openRemoteAttachment } = require('./services/gateway-attachment-source');
const { spawnSync } = require('child_process');

test('backend startup rejects any non-canonical remote files origin', () => {
  const run = spawnSync(process.execPath, ['-e', "require('./config')"], {
    cwd: __dirname,
    env: {
      ...process.env,
      JWT_SECRET: 'isolated-test-key-000000000000000000000000',
      GATEWAY_FILES_ORIGIN: 'http://localhost:3103',
    },
    encoding: 'utf8',
  });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('GATEWAY_FILES_ORIGIN must be exactly');
});

test('remote URL accepts only the fixed loopback origin and flat gateway-generated name', () => {
  expect(remoteAttachmentUrl('http://127.0.0.1:3103', '/uploads/gateway/202/1700_abcd.jpg', 202))
    .toBe('http://127.0.0.1:3103/uploads/gateway/202/1700_abcd.jpg');
  for (const [origin, url, account] of [
    ['http://localhost:3103', '/uploads/gateway/202/a.jpg', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/203/a.jpg', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/202/../a.jpg', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/202/%2e%2e', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg?x=1', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg#x', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/202/a\\b.jpg', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/0202/a.jpg', 202],
    ['http://127.0.0.1:3103', '/uploads/gateway/-202/a.jpg', -202],
  ]) expect(remoteAttachmentUrl(origin, url, account)).toBeNull();
});

test('remote fetch disables redirects and keeps its abort active until streaming closes', async () => {
  let request;
  const fetchImpl = jest.fn(async (url, options) => {
    request = { url, options };
    return {
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('ok')); controller.close(); } }),
    };
  });
  const result = await openRemoteAttachment(
    'http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg', 202, { fetchImpl, timeoutMs: 1000 });
  expect(result.status).toBe('ok');
  expect(request.url).toBe('http://127.0.0.1:3103/uploads/gateway/202/a.jpg');
  expect(request.options).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(request.options.signal.aborted).toBe(false);
  result.close();
  expect(request.options.signal.aborted).toBe(true);
});

test('upstream redirects and server failures are unavailable; only a real 404 is missing', async () => {
  const result = await openRemoteAttachment(
    'http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg', 202,
    { fetchImpl: async () => ({ status: 302, body: null }) });
  expect(result).toEqual({ status: 'unavailable' });
  await expect(openRemoteAttachment(
    'http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg', 202,
    { fetchImpl: async () => ({ status: 500, body: null }) }))
    .resolves.toEqual({ status: 'unavailable' });
  await expect(openRemoteAttachment(
    'http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg', 202,
    { fetchImpl: async () => ({ status: 404, body: null }) }))
    .resolves.toEqual({ status: 'missing' });
});

test('the total transfer is aborted at the configured deadline', async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const pending = openRemoteAttachment(
    'http://127.0.0.1:3103', '/uploads/gateway/202/a.jpg', 202, { fetchImpl, timeoutMs: 25 });
  await jest.advanceTimersByTimeAsync(25);
  await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
  jest.useRealTimers();
});
