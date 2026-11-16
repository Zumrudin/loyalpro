'use strict';

const mockQuery = jest.fn();
const mockExecutor = { query: mockQuery };
const mockInvalidateOtp = jest.fn();

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('./config', () => ({ TELEGRAM_API_BASE: 'https://telegram.invalid' }));
jest.mock('./db', () => ({
  db: {
    query: mockQuery,
    oneOrNone: jest.fn(async (...args) => {
      const result = await mockQuery(...args);
      return result.rows[0] || null;
    }),
  },
  withTransaction: jest.fn(async callback => callback(mockExecutor)),
}));
jest.mock('./services/mobile-otp', () => ({ invalidateOtp: mockInvalidateOtp }));
jest.mock('./logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

const {
  getChatIdByPhone,
  linkVerifiedContact,
} = require('./services/telegram-otp');

const phone = '7'.repeat(11);

beforeEach(() => {
  jest.clearAllMocks();
});

test('legacy unverified Telegram links cannot receive a newly issued OTP', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('telegram_user_id IS NOT NULL') && sql.includes('verified_at IS NOT NULL')) {
      return { rows: [] };
    }
    return { rows: [{ chat_id: 101 }] };
  });
  await expect(getChatIdByPhone(phone, 17)).resolves.toBeNull();
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('salon_id=$2');
  expect(params).toEqual([phone, 17]);
});

test('changing a verified Telegram user revokes linked sessions and pending OTP before rebind', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM mobile_telegram_links')) {
      return { rows: [{ salon_id: 17, client_id: 55, chat_id: 101, telegram_user_id: 101, verified_at: new Date() }] };
    }
    return { rows: [] };
  });
  const result = await linkVerifiedContact({
    salonId: 17, clientId: 55, phone, chatId: 202, telegramUserId: 202,
  });
  expect(result).toEqual({ status: 'changed' });
  const deleteSession = mockQuery.mock.calls.find(call => call[0].includes('DELETE FROM mobile_sessions'));
  expect(deleteSession[1]).toEqual([17, [55]]);
  expect(mockInvalidateOtp).toHaveBeenCalledWith(mockExecutor, 17, phone);
  const insertLink = mockQuery.mock.calls.find(call => call[0].includes('INSERT INTO mobile_telegram_links'));
  expect(insertLink[1]).toEqual([phone, 17, 55, 202, 202]);
  expect(mockInvalidateOtp.mock.invocationCallOrder[0]).toBeLessThan(mockQuery.mock.invocationCallOrder[mockQuery.mock.calls.indexOf(insertLink)]);
});

test('identical verified contact does not invalidate sessions or reset OTP', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM mobile_telegram_links')) {
      return { rows: [{ salon_id: 17, client_id: 55, chat_id: 101, telegram_user_id: 101, verified_at: new Date() }] };
    }
    throw new Error('No write expected');
  });
  await expect(linkVerifiedContact({
    salonId: 17, clientId: 55, phone, chatId: 101, telegramUserId: 101,
  })).resolves.toEqual({ status: 'unchanged' });
  expect(mockInvalidateOtp).not.toHaveBeenCalled();
  expect(mockQuery).toHaveBeenCalledTimes(2);
});

test('a verified link belonging to another tenant cannot be overwritten', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM mobile_telegram_links')) {
      return { rows: [{ salon_id: 18, client_id: 56, chat_id: 101, telegram_user_id: 101, verified_at: new Date() }] };
    }
    throw new Error('No write expected');
  });
  await expect(linkVerifiedContact({
    salonId: 17, clientId: 55, phone, chatId: 101, telegramUserId: 101,
  })).rejects.toMatchObject({ code: 'MOBILE_LINK_TENANT_CONFLICT' });
  expect(mockInvalidateOtp).not.toHaveBeenCalled();
});
