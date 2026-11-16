'use strict';
const mockOne = jest.fn();
const mockQuery = jest.fn();
const mockTxQuery = jest.fn();

jest.mock('./config', () => ({
  JWT_SECRET: 's'.repeat(40),
  RESOURCE_LIMITS: {
    registerIp: 5, registerEmail: 3, askUserPerMinute: 10, askSalonPerMinute: 30,
    llmConcurrency: 2, salonDailyCalls: 100, salonMonthlyCalls: 2000, globalDailyCalls: 5000,
  },
}));
jest.mock('./db', () => ({
  db: { one: mockOne, query: mockQuery },
  withTransaction: jest.fn(async fn => fn({ query: mockTxQuery })),
}));

const limits = require('./services/resource-limits');
const { RESOURCE_LIMITS_DDL } = require('./migrations');

beforeEach(() => {
  jest.clearAllMocks();
  mockOne.mockResolvedValue({ count: 1 });
  mockQuery.mockResolvedValue({ rows: [] });
  mockTxQuery.mockImplementation(async sql => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [{ calls: 1 }] };
  });
});

test('shared fixed-window counters use HMAC keys instead of raw IP or email', async () => {
  await limits.register('synthetic-ip', 'synthetic@example.invalid');
  expect(mockOne).toHaveBeenCalledTimes(2);
  for (const [sql, params] of mockOne.mock.calls) {
    expect(sql).toContain('ON CONFLICT (scope,key_hash,window_started_at)');
    expect(params[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(params).not.toContain('synthetic-ip');
    expect(params).not.toContain('synthetic@example.invalid');
  }
  expect(RESOURCE_LIMITS_DDL).toContain('PRIMARY KEY(scope,key_hash,window_started_at)');
});

test('daily/monthly tenant and global budgets are claimed in one transaction', async () => {
  await limits.claimUsage(11);
  const calls = mockTxQuery.mock.calls.filter(([sql]) => sql.includes('llm_usage_counters'));
  expect(calls).toHaveLength(3);
  expect(calls.map(([, params]) => params[0])).toEqual([0, 11, 11]);
  for (const [sql] of calls) expect(sql).toContain('WHERE llm_usage_counters.calls<$3');
});

test('budget exhaustion prevents the provider call and releases the lease', async () => {
  mockTxQuery.mockImplementation(async sql => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('INSERT INTO llm_usage_counters')) return { rows: [] };
    if (sql.includes('UPDATE llm_concurrency_leases')) return { rows: [{ id: 'synthetic' }] };
    return { rows: [] };
  });
  const provider = jest.fn();
  await expect(limits.runLlm(11, 5, async () => { await limits.attempt(); return provider(); })).rejects.toMatchObject({ status: 429, code: 'BUDGET_EXHAUSTED' });
  expect(provider).not.toHaveBeenCalled();
  expect(mockQuery).toHaveBeenCalledWith(
    'DELETE FROM llm_concurrency_leases WHERE id=$1 AND salon_id=$2', [expect.any(String), 11]);
});

test('concurrency cap is serialized per tenant across processes', async () => {
  mockTxQuery.mockImplementation(async sql => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 2 }] };
    return { rows: [] };
  });
  await expect(limits.acquire(11, 5)).rejects.toMatchObject({ code: 'CONCURRENCY' });
  expect(mockTxQuery).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(19381,$1)', [11]);
  expect(mockTxQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO llm_concurrency_leases'))).toBe(false);
});

test('a successful call always releases its lease', async () => {
  const provider = jest.fn(async () => 'synthetic-answer');
  await expect(limits.runLlm(11, 5, async () => { await limits.attempt(); return provider(); })).resolves.toBe('synthetic-answer');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledWith(
    'DELETE FROM llm_concurrency_leases WHERE id=$1 AND salon_id=$2', [expect.any(String), 11]);
});

test('parallel salon contexts account every attempt without leaking tenant context', async () => {
  await Promise.all([11, 22].map(salon => limits.runLlm(salon, 5, async () => {
    await limits.attempt({ paid: true });
    await limits.attempt();
  })));
  const calls=mockTxQuery.mock.calls.filter(([sql])=>sql.includes('INSERT INTO llm_usage_counters'));
  expect(calls.filter(([,p])=>p[0]===11)).toHaveLength(4);
  expect(calls.filter(([,p])=>p[0]===22)).toHaveLength(4);
  expect(calls.filter(([,p])=>p[1]==='paid_day')).toHaveLength(2);
});

test('paid kill switch fails before quota storage or network', async () => {
  const config=require('./config');config.LLM_PAID_ENABLED=false;
  await expect(limits.attempt({paid:true})).rejects.toMatchObject({code:'PAID_DISABLED',status:429});
  expect(mockTxQuery).not.toHaveBeenCalled();delete config.LLM_PAID_ENABLED;
});
