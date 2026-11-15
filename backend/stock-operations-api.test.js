'use strict';

jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/stock/operation-values', () => ({ enrichOperations: jest.fn(async (_salonId, rows) => rows.map(r => ({ ...r, enriched: true }))) }));

const { db } = require('./db');
const values = require('./services/stock/operation-values');
const { StockError } = require('./services/stock/model');
const { parseOperationsQuery } = require('./services/stock/query');
const operations = require('./services/stock/operations');
const history = require('./services/stock/history');
const { STOCK_HISTORY_DDL } = require('./migrations');

beforeEach(() => jest.clearAllMocks());

describe('parseOperationsQuery', () => {
  test('defaults and page cap match the operations screen', () => {
    expect(parseOperationsQuery({})).toMatchObject({ page: 1, limit: 25, search: '', paymentStatus: null });
    expect(parseOperationsQuery({ page: '3', limit: '999' })).toMatchObject({ page: 3, limit: 100 });
  });

  test('parses every server-side filter and bounds free text', () => {
    expect(parseOperationsQuery({ from: '2026-11-01', to: '2026-11-15', kind: 'sale', origin: 'loyalpro',
      status: 'posted', storage: '2', search: ' x ', counterparty: 'clinic', client_search: '7999',
      document_number: '123', service: '44', payment_status: 'partial' })).toMatchObject({
      from: '2026-11-01', to: '2026-11-15', kind: 'sale', origin: 'loyalpro', status: 'posted', storage: 2,
      search: 'x', counterparty: 'clinic', clientSearch: '7999', documentNumber: '123', service: 44,
      paymentStatus: 'partial',
    });
    expect(parseOperationsQuery({ search: 'x'.repeat(300) }).search).toHaveLength(200);
    expect(() => parseOperationsQuery({ from: '2026-11-01' })).toThrow(StockError);
  });
});

describe('operations SQL and loader', () => {
  test('query scopes all tenant joins and keeps stable ordering', () => {
    const { sql, params } = operations.buildOperationsSql({ salonId: 7, search: '10%_off', clientSearch: 'Ann',
      documentNumber: '77', paymentStatus: 'paid', page: 2, limit: 25 });
    for (const table of ['stock_documents d', 'yclients_goods_catalog g', 'stock_storages st', 'clients c', 'records r']) expect(sql).toContain(table);
    expect(sql).toContain('m.salon_id = $1');
    expect(sql).toContain('ORDER BY occurred_at DESC, id DESC');
    expect(sql).toContain("ESCAPE '\\'");
    expect(params[0]).toBe(7);
    expect(params).toContain('%10\\%\\_off%');
    expect(sql).toContain("d.id::text ILIKE");
    expect(sql).toContain("d.yclients_document_id::text");
  });

  test('returns movement rows and enriches them with the same query adapter', async () => {
    db.any.mockResolvedValueOnce([{ id: '9', total: 2, payment_status: 'paid' }]);
    const result = await operations.listOperations(7, { page: 1, limit: 25 });
    expect(result).toEqual({ operations: [{ id: '9', payment_status: 'paid', enriched: true }], total: 2, page: 1, limit: 25 });
    expect(values.enrichOperations).toHaveBeenCalledWith(7, [{ id: '9', payment_status: 'paid' }], expect.any(Function));
  });

  test('out-of-range page runs a count query and preserves total', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 2733 }] });
    await expect(operations.listOperations(7, { page: 999, limit: 25 }, { query }))
      .resolves.toEqual({ operations: [], total: 2733, page: 999, limit: 25 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('COUNT(*)::int AS total');
  });

  test('service choices are tenant scoped', async () => {
    db.any.mockResolvedValue([{ id: '44', title: 'Уход' }]);
    await expect(operations.listOperationServices(3)).resolves.toEqual([{ id: '44', title: 'Уход' }]);
    expect(db.any).toHaveBeenCalledWith(expect.stringContaining('m.salon_id = $1'), [3]);
  });
});

describe('stock document history', () => {
  test('known legacy dates are labeled and no comment/phone is exposed', () => {
    const events = history.mergeKnownEvents({ id: 8, origin: 'loyalpro', kind: 'sale', created_by: 9, created_at: '2026-11-01T10:00:00Z',
      posted_at: '2026-11-01T10:01:00Z', cancelled_at: '2026-11-02T10:00:00Z' }, []);
    expect(events.map(e => e.action)).toEqual(['document_cancelled_known', 'document_posted_known', 'document_created_known']);
    expect(events.every(e => e.known)).toBe(true);
    expect(events.at(-1).actor_name).toBe('Пользователь #9');
    expect(JSON.stringify(events)).not.toMatch(/comment|phone/);
  });

  test('load scopes document and events by salon and reports truncation', async () => {
    db.oneOrNone.mockResolvedValue({ id: 8, origin: 'yclients', kind: 'receipt', created_at: null });
    db.any.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ id: i + 1, occurred_at: new Date(1700000000000 + i * 1000),
      action: 'movement_changed', source: 'webhook', changes: {}, history_since: new Date(1700000000000) })));
    const result = await history.load(4, 8);
    expect(result.events).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.history_since).toBe('2023-11-14T22:13:20.000Z');
    expect(db.oneOrNone).toHaveBeenCalledWith(expect.stringContaining('salon_id = $1 AND id = $2'), [4, 8]);
    expect(db.any).toHaveBeenCalledWith(expect.stringContaining('salon_id = $1 AND document_id = $2'), [4, 8]);
  });

  test('missing foreign-tenant document is 404 before reading events', async () => {
    db.oneOrNone.mockResolvedValue(null);
    await expect(history.load(4, 8)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(db.any).not.toHaveBeenCalled();
  });

  test('migration is additive, transactional and excludes free text PII fields', () => {
    const ddl = STOCK_HISTORY_DDL.join('\n');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS stock_document_events');
    expect(ddl).toContain('AFTER INSERT OR UPDATE ON stock_documents');
    expect(ddl).toContain('AFTER INSERT OR UPDATE ON stock_movements');
    expect(ddl).toContain("IF changes = '{}'::jsonb THEN RETURN NEW");
    expect(ddl).toContain("jsonb_build_object('comment_changed', TRUE)");
    expect(ddl).not.toContain("'comment', jsonb_build_object");
    expect(ddl).not.toMatch(/cancel_reason|phone|email/i);
  });
});
