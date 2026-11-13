'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() } }));
jest.mock('./services/journal/reference-cache', () => ({ getReference: jest.fn(async () => [{ id: 1355177, title: 'Основная касса' }]) }));
jest.mock('./middleware/auth', () => {
  const guard = (req, res, next) => req.__user ? (req.user = req.__user, next()) : res.status(401).json({});
  return { auth: guard, authOrQuery: guard, requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({}) };
});
jest.mock('./services/bonus-ledger', () => ({ isPrimary: jest.fn(() => false), discrepancies: jest.fn(async () => []) }));
const bonusLedger = require('./services/bonus-ledger');
const { db } = require('./db');
const router = require('./routes/finance');
const { parseFilters, buildWhere, toCsv, csvCell } = router._test;

function call(method, url, { user = { role: 'owner', salonId: 3, userId: 4 }, query = {} } = {}) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(n) { this.statusCode = n; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); },
      send(body) { resolve({ status: this.statusCode, text: body, headers: this.headers }); },
    };
    router.handle({ method, url, query, headers: {}, __user: user }, res, () => resolve({ status: 404 }));
  });
}
const SUMMARY = { income: '27000', expense: '300', bonus_redeemed: '6500', bonus_accrued: '120.5', queued: 2, total: 2 };
const ROW = { id: '9', occurred_at: new Date('2026-11-12T06:42:00Z'), op_date: '2026-11-12', kind: 'bonus_redemption', method: 'bonus', amount: '-6500.00',
  status: 'queued', origin: 'journal', account_id: null, account_title: null, client_id: 3, client_name: 'Иванова <b>А.</b>', client_phone: '+79990000000',
  yclients_record_id: '2100', outbox_id: '39', user_id: 4, user_name: 'Админ', title: null, comment: null };
beforeEach(() => {
  jest.clearAllMocks();
  db.oneOrNone.mockResolvedValue(SUMMARY);
  db.any.mockResolvedValue([ROW]);
});

describe('access', () => {
  test('requires auth', async () => expect((await call('GET', '/operations', { user: null })).status).toBe(401));
  test.each(['specialist', 'admin_cashier', 'unknown'])('rejects %s everywhere', async role => {
    for (const url of ['/operations', '/operations/export.csv', '/accounts']) {
      expect((await call('GET', url, { user: { role, salonId: 3 } })).status).toBe(403);
    }
    expect(db.any).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });
  test.each(['owner', 'admin'])('allows %s', async role => {
    expect((await call('GET', '/operations', { user: { role, salonId: 3 } })).status).toBe(200);
  });
  test('responses are not cacheable', async () => {
    expect((await call('GET', '/operations')).headers['Cache-Control']).toBe('no-store');
  });
});

describe('salon scoping', () => {
  test('salon comes from the JWT, never from the query', async () => {
    await call('GET', '/operations', { query: { from: '2026-11-01', to: '2026-11-12', salonId: '99', salon_id: '99' } });
    for (const c of [...db.any.mock.calls, ...db.oneOrNone.mock.calls]) {
      expect(c[1][0]).toBe(3);
      expect(c[0]).toMatch(/f\.salon_id=\$1/);
      expect(c[1]).not.toContain('99');
    }
    expect(db.any.mock.calls[0][0]).toMatch(/c\.salon_id=f\.salon_id/);
  });
  test('export is scoped the same way', async () => {
    await call('GET', '/operations/export.csv', { user: { role: 'admin', salonId: 8 }, query: { from: '2026-11-01', to: '2026-11-12' } });
    expect(db.any.mock.calls[0][1][0]).toBe(8);
  });
  test('accounts list reads only this salon', async () => {
    db.any.mockResolvedValue([{ account_id: 1355178, account_title: 'Расчетный счет' }]);
    const res = await call('GET', '/accounts', { user: { role: 'owner', salonId: 5 } });
    expect(db.any.mock.calls[0][1]).toEqual([5]);
    expect(res.body.accounts).toEqual(expect.arrayContaining([{ id: 1355178, title: 'Расчетный счет' }, { id: 1355177, title: 'Основная касса' }]));
  });
});

describe('response shape', () => {
  test('rows, total and summary', async () => {
    const res = await call('GET', '/operations', { query: { from: '2026-11-01', to: '2026-11-12' } });
    expect(res.body.total).toBe(2);
    expect(res.body.summary).toEqual({ income: 27000, expense: 300, bonusRedeemed: 6500, bonusAccrued: 120.5, queued: 2 });
    expect(res.body.rows[0]).toMatchObject({ id: 9, kind: 'bonus_redemption', amount: -6500, status: 'queued', origin: 'journal', clientId: 3,
      clientName: 'Иванова <b>А.</b>', yclientsRecordId: 2100, outboxId: 39, date: '2026-11-12', userName: 'Админ' });
  });
  test('defaults to the current month and 50 rows', async () => {
    await call('GET', '/operations');
    const sql = db.any.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY f\.occurred_at DESC, f\.id DESC LIMIT 50 OFFSET 0/);
    const p = db.any.mock.calls[0][1];
    expect(p[1].endsWith('-01')).toBe(true);
  });
  test('limit is capped at 500', async () => {
    await call('GET', '/operations', { query: { limit: '100000' } });
    expect(db.any.mock.calls[0][0]).toMatch(/LIMIT 500 OFFSET/);
  });
});

describe('validation', () => {
  const bad = async query => {
    const res = await call('GET', '/operations', { query });
    expect(res.status).toBe(400);
    expect(db.any).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  };
  test('dates', async () => {
    await bad({ from: '2026-02-30', to: '2026-03-01' });
    await bad({ from: '12.11.2026', to: '2026-11-12' });
    await bad({ from: '2026-11-12', to: '2026-11-01' });
  });
  test('period over 366 days', async () => {
    await bad({ from: '2025-01-01', to: '2026-11-12' });
    const ok = await call('GET', '/operations', { query: { from: '2025-11-12', to: '2026-11-12' } });   // ровно 366 дней
    expect(ok.status).toBe(200);
  });
  test('enums, ids, paging and text', async () => {
    await bad({ kind: 'bogus' });
    await bad({ kind: ['visit_payment', 'deposit'] });
    await bad({ method: 'gold' });
    await bad({ status: 'done' });
    await bad({ clientId: 'abc' });
    await bad({ clientId: '0' });
    await bad({ limit: 'x' });
    await bad({ limit: '0' });
    await bad({ offset: '-1' });
    await bad({ q: 'x'.repeat(101) });
  });
  test('comma lists of valid values are accepted and passed as arrays', async () => {
    const res = await call('GET', '/operations', { query: { kind: 'visit_payment,deposit', status: 'queued,sending', clientId: '12' } });
    expect(res.status).toBe(200);
    const p = db.any.mock.calls[0][1];
    expect(p).toEqual(expect.arrayContaining([['visit_payment', 'deposit'], ['queued', 'sending'], 12]));
  });
  test('csv export validates like the list', async () => {
    expect((await call('GET', '/operations/export.csv', { query: { from: 'x', to: 'y' } })).status).toBe(400);
  });
});

describe('where builder', () => {
  test('user input only reaches SQL through parameters', () => {
    const f = parseFilters({ from: '2026-11-01', to: '2026-11-12', q: "x'; DROP TABLE clients;--", account: "a' OR 1=1" });
    const { where, params } = buildWhere(3, f);
    expect(where).not.toMatch(/DROP|1=1/);
    expect(params.some(p => String(p).includes('DROP TABLE'))).toBe(true);
  });
  test('LIKE wildcards in the search text are escaped', () => {
    const { params } = buildWhere(3, parseFilters({ from: '2026-11-01', to: '2026-11-12', q: '50%_' }));
    expect(params).toContain('%50\\%\\_%');
  });
  test('numeric account filters by id, text by title', () => {
    const a = buildWhere(3, parseFilters({ from: '2026-11-01', to: '2026-11-12', account: '1355177' }));
    expect(a.where).toMatch(/f\.account_id=\$4/);
    const b = buildWhere(3, parseFilters({ from: '2026-11-01', to: '2026-11-12', account: 'Касса' }));
    expect(b.where).toMatch(/f\.account_title ILIKE \$4/);
  });
});

describe('csv export', () => {
  test('utf-8 with BOM, ; separator, attachment', async () => {
    const res = await call('GET', '/operations/export.csv', { query: { from: '2026-11-01', to: '2026-11-12' } });
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/csv/);
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="finance-2026-11-01_2026-11-12.csv"');
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('﻿Дата;Время;Тип;Способ;Касса;Клиент;Телефон;Визит YClients;Сумма;Статус;Источник;Кто;Описание');
    expect(lines[1]).toContain('Списание бонусов');
    expect(lines[1]).toContain('-6500');
    expect(lines[1]).toContain('В очереди');
  });
  test('cells cannot start a spreadsheet formula, quotes and separators are escaped', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('+79990000000')).toBe('+79990000000');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell(null)).toBe('');
    expect(toCsv([{ date: '2026-11-12', kind: 'deposit', amount: 5, status: 'confirmed', origin: 'yclients', clientName: '=1+1' }])).toContain("'=1+1");
  });
});

describe('database errors', () => {
  test('missing table (migration not applied) gives 503, other errors a generic 500', async () => {
    db.any.mockRejectedValueOnce(Object.assign(new Error('relation "finance_operations" does not exist'), { code: '42P01' }));
    expect((await call('GET', '/operations', { query: { from: '2026-11-01', to: '2026-11-12' } })).status).toBe(503);
    db.any.mockRejectedValueOnce(new Error('secret connection string'));
    const res = await call('GET', '/operations', { query: { from: '2026-11-01', to: '2026-11-12' } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('bonus-discrepancies', () => {
  test('requires auth and owner/admin', async () => {
    expect((await call('GET', '/bonus-discrepancies', { user: null })).status).toBe(401);
    expect((await call('GET', '/bonus-discrepancies', { user: { role: 'specialist', salonId: 3 } })).status).toBe(403);
    expect(bonusLedger.discrepancies).not.toHaveBeenCalled();
  });
  test('flag off: disabled, no queries', async () => {
    bonusLedger.isPrimary.mockReturnValue(false);
    const r = await call('GET', '/bonus-discrepancies');
    expect(r.body).toEqual({ enabled: false, rows: [] });
    expect(bonusLedger.discrepancies).not.toHaveBeenCalled();
  });
  test('flag on: salon from JWT, limit passed', async () => {
    bonusLedger.isPrimary.mockReturnValue(true);
    bonusLedger.discrepancies.mockResolvedValueOnce([{ clientId: 1, diff: 5 }]);
    const r = await call('GET', '/bonus-discrepancies', { query: { limit: '20', salonId: '99' } });
    expect(r.body).toEqual({ enabled: true, rows: [{ clientId: 1, diff: 5 }] });
    expect(bonusLedger.discrepancies).toHaveBeenCalledWith(3, { limit: 20 });
  });
  test('bad limit -> 400; default 200', async () => {
    bonusLedger.isPrimary.mockReturnValue(true);
    expect((await call('GET', '/bonus-discrepancies', { query: { limit: 'abc' } })).status).toBe(400);
    await call('GET', '/bonus-discrepancies');
    expect(bonusLedger.discrepancies).toHaveBeenLastCalledWith(3, { limit: 200 });
  });
  test('db failure -> 500', async () => {
    bonusLedger.isPrimary.mockReturnValue(true);
    bonusLedger.discrepancies.mockRejectedValueOnce(new Error('boom'));
    expect((await call('GET', '/bonus-discrepancies')).status).toBe(500);
  });
});
