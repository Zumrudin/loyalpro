'use strict';

const mockQuery = jest.fn();
const mockExecutor = { query: mockQuery };
const mockDb = { query: mockQuery };

jest.mock('./config', () => ({
  MOBILE_AUTH: {
    salonId: 41,
    otpHashKey: 'h'.repeat(32),
    requestLimit: 5,
    requestWindowMinutes: 15,
  },
}));
jest.mock('./db', () => ({
  db: mockDb,
  withTransaction: jest.fn(async callback => callback(mockExecutor)),
}));

const {
  normalizePhone,
  findClientByPhone,
  issueOtp,
  consumeOtp,
} = require('./services/mobile-otp');
const { MOBILE_AUTH_DDL } = require('./migrations');

const syntheticPhone = '7'.repeat(11);

beforeEach(() => {
  mockQuery.mockReset();
});

test('phone normalization is strict and tenant lookup never uses an unscoped LIMIT 1', async () => {
  expect(normalizePhone('123')).toBeNull();
  expect(normalizePhone('6'.repeat(11))).toBeNull();
  expect(normalizePhone(`8${'1'.repeat(10)}`)).toBe(`7${'1'.repeat(10)}`);
  mockQuery.mockResolvedValue({ rows: [] });
  await findClientByPhone(syntheticPhone, 41);
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('FROM clients WHERE salon_id=$1');
  expect(sql).toContain('LIMIT 2');
  expect(sql).not.toContain('LIKE');
  expect(params).toEqual([41, syntheticPhone]);
});

test('issueOtp stores only HMAC with server-derived salon and client identity', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('mobile_otp_request_limits')) return { rows: [{ request_count: 1 }] };
    if (sql.includes('FROM clients WHERE salon_id=$1')) return { rows: [{ id: 91, phone: syntheticPhone }] };
    if (sql.includes('INSERT INTO mobile_otp_sessions')) return { rows: [{ client_id: 91 }] };
    throw new Error('Unexpected query');
  });
  const result = await issueOtp({ phone: syntheticPhone, salonId: 41 });
  expect(result.issued).toBe(true);
  expect(mockQuery).toHaveBeenCalledTimes(3);
  const insert = mockQuery.mock.calls[2];
  expect(insert[0]).toContain('otp=NULL');
  expect(insert[0]).toContain('ON CONFLICT (phone)');
  expect(insert[1]).toEqual([syntheticPhone, 41, 91, expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(result.otp);
});

test('client ambiguity and the shared salon+phone allowance do not issue a code', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('mobile_otp_request_limits')) return { rows: [{ request_count: 1 }] };
    if (sql.includes('FROM clients WHERE salon_id=$1')) return { rows: [{ id: 91 }, { id: 92 }] };
    throw new Error('Unexpected query');
  });
  await expect(issueOtp({ phone: syntheticPhone, salonId: 41 })).resolves.toEqual({ issued: false, reason: 'ambiguous' });
  expect(mockQuery).toHaveBeenCalledTimes(2);

  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ request_count: 6 }] });
  await expect(issueOtp({ phone: syntheticPhone, salonId: 41 })).resolves.toEqual({ issued: false, reason: 'rate_limited' });
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

test('a process cannot substitute another tenant for the configured mobile salon', async () => {
  await expect(issueOtp({ phone: syntheticPhone, salonId: 42 })).rejects.toMatchObject({ code: 'MOBILE_SALON_MISMATCH' });
  expect(mockQuery).not.toHaveBeenCalled();
});

function atomicOtpStore(expectedHash) {
  const row = { attempts: 0, consumed: false };
  return {
    row,
    query: async (sql, params) => {
      expect(sql).toContain('UPDATE mobile_otp_sessions');
      expect(sql).toContain('attempts<$4');
      expect(sql).toContain('consumed_at IS NULL');
      if (row.consumed || row.attempts >= 5) return { rows: [] };
      row.attempts += 1;
      if (params[1] === expectedHash) row.consumed = true;
      return { rows: [{ client_id: 91, consumed_at: row.consumed ? new Date() : null }] };
    },
  };
}

test('20 parallel wrong checks cannot exceed five attempts', async () => {
  let issuedHash;
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('mobile_otp_request_limits')) return { rows: [{ request_count: 1 }] };
    if (sql.includes('FROM clients WHERE salon_id=$1')) return { rows: [{ id: 91 }] };
    if (sql.includes('INSERT INTO mobile_otp_sessions')) return { rows: [{ client_id: 91 }] };
    throw new Error('Unexpected query');
  });
  const issued = await issueOtp({ phone: syntheticPhone, salonId: 41 });
  issuedHash = mockQuery.mock.calls[2][1][3];
  const wrongOtp = issued.otp === '000000' ? '000001' : '000000';
  const store = atomicOtpStore(issuedHash);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    consumeOtp({ phone: syntheticPhone, otp: wrongOtp, salonId: 41 }, store)
  ));
  expect(results.every(value => value === null)).toBe(true);
  expect(store.row.attempts).toBe(5);
  await expect(consumeOtp({ phone: syntheticPhone, otp: issued.otp, salonId: 41 }, store)).resolves.toBeNull();
});

test('parallel valid checks produce only one consumed identity', async () => {
  mockQuery.mockImplementation(async sql => {
    if (sql.includes('mobile_otp_request_limits')) return { rows: [{ request_count: 1 }] };
    if (sql.includes('FROM clients WHERE salon_id=$1')) return { rows: [{ id: 91 }] };
    if (sql.includes('INSERT INTO mobile_otp_sessions')) return { rows: [{ client_id: 91 }] };
    throw new Error('Unexpected query');
  });
  const issued = await issueOtp({ phone: syntheticPhone, salonId: 41 });
  const issuedHash = mockQuery.mock.calls[2][1][3];
  const store = atomicOtpStore(issuedHash);
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    consumeOtp({ phone: syntheticPhone, otp: issued.otp, salonId: 41 }, store)
  ));
  expect(results.filter(value => value === 91)).toHaveLength(1);
  expect(store.row.consumed).toBe(true);
});

test('mobile auth DDL is additive and never backfills verified identity or plaintext OTP', () => {
  expect(MOBILE_AUTH_DDL).toContain('ADD COLUMN IF NOT EXISTS telegram_user_id');
  expect(MOBILE_AUTH_DDL).toContain('ADD COLUMN IF NOT EXISTS otp_hash');
  expect(MOBILE_AUTH_DDL).toContain('ADD COLUMN IF NOT EXISTS salon_id');
  expect(MOBILE_AUTH_DDL).toContain('CREATE TABLE IF NOT EXISTS mobile_otp_request_limits');
  expect(MOBILE_AUTH_DDL).not.toMatch(/UPDATE\s+mobile_(telegram_links|otp_sessions)/i);
  expect(MOBILE_AUTH_DDL).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
});
