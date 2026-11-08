'use strict';

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
const { execFileSync } = require('child_process');
const { assertWorkerStopped } = require('./scripts/notifications-e2e-worker-guard');
const proc = (status) => ({ name: 'loyalpro', pm2_env: { status } });

beforeEach(() => jest.resetAllMocks());

test.each(['stopped', 'errored'])('permits a confirmed inactive worker: %s', (status) => {
  execFileSync.mockReturnValue(JSON.stringify([proc(status)]));
  expect(() => assertWorkerStopped('loyalpro')).not.toThrow();
});

test.each(['online', 'launching', 'stopping', 'waiting restart', undefined])('rejects active or uncertain worker: %s', (status) => {
  execFileSync.mockReturnValue(JSON.stringify([proc(status)]));
  expect(() => assertWorkerStopped('loyalpro')).toThrow('ОТКАЗ');
});

test.each(['[]', '{}', 'not JSON', JSON.stringify([proc('stopped'), proc('online')])])('rejects missing, malformed or partially active process lists: %s', (output) => {
  execFileSync.mockReturnValue(output);
  expect(() => assertWorkerStopped('loyalpro')).toThrow('ОТКАЗ');
});

test('PM2 execution failure stops the harness without exposing subprocess output', () => {
  execFileSync.mockImplementation(() => { throw new Error('private subprocess output'); });
  expect(() => assertWorkerStopped('loyalpro')).toThrow('ОТКАЗ: не удалось проверить PM2; E2E не запущен.');
});
