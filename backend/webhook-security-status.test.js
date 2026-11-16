'use strict';
const mockLog = { info: jest.fn(), warn: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const status = require('./services/webhook-security-status');

test('startup reports only counts and booleans, missing credentials remain fail-closed', async () => {
  const db = { one: jest.fn().mockResolvedValue({ active: 2, missing: 1 }) };
  const result = await status.validateStartup(db, { CHATPUSH: { webhookSecret: 'private-marker' } });
  expect(result).toEqual({ yclientsActive: 2, yclientsMissing: 1, chatpushConfigured: true, gatewayConfigured: false });
  expect(JSON.stringify(mockLog.info.mock.calls)).not.toContain('private-marker');
  expect(mockLog.warn).toHaveBeenCalledWith('Unconfigured webhook endpoints remain fail-closed');
});

test('reject counters have bounded labels and logarithmic warning volume', () => {
  mockLog.warn.mockClear();
  for (let i = 0; i < 100; i++) status.record('gateway', 'invalid_key');
  expect(mockLog.warn).toHaveBeenCalledTimes(7);
  expect(mockLog.warn.mock.calls.at(-1)[0]).toContain('process_total=64');
  status.record('private-marker', 'invalid_key');
  status.record('gateway', 'private-marker');
  expect(mockLog.warn).toHaveBeenCalledTimes(7);
});
