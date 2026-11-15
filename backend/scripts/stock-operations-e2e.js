'use strict';
// Real SQL and router, synthetic TEMP data only; outer transaction rolls back.
const assert = require('assert/strict');
const { withEnvironment } = require('./stock-e2e');
const { pool } = require('../db');
const { enrichOperations } = require('../services/stock/operation-values');

async function acceptance({ q, request, base, token }) {
  const query = async (sql, p) => (await q(sql, p)).rows;
  const { STOCK_HISTORY_DDL } = require('../migrations');
  // Function lookup deliberately excludes pg_temp unless qualified. Rewrite
  // only these isolated DDL names, never install a function in public.
  for (let pass = 0; pass < 2; pass++) for (const sql of STOCK_HISTORY_DDL) {
    await q(sql.replace(/(FUNCTION )(?=stock_audit_)/g, '$1pg_temp.'));
  }
  const put = async ({ id, kind = 'receipt', source = 'loyalpro', at, recorded = at, qty,
    cost = null, storage = 1, status = 'posted', deleted = null, good = 1, salon = 1, comment = null }) => {
    await q(`INSERT INTO stock_documents(id,salon_id,kind,origin,status,storage_id,doc_date,total_cost,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`,
    [id, salon, kind, source === 'loyalpro' ? 'loyalpro' : 'yclients', status, storage, at, cost]);
    await q(`INSERT INTO stock_movements(id,salon_id,document_id,good_row_id,storage_id,
      qty,unit_type,qty_base,cost,source,occurred_at,recorded_at,deleted_at,comment)
      VALUES($1,$2,$1,$3,$4,abs($5::numeric),2,$5,$6,$7,$8,$9,$10,$11)`,
    [id, salon, good, storage, qty, cost, source, at, recorded, deleted, comment]);
  };
  const val = async id => (await enrichOperations(1, [{ id }], query))[0];
  await q("INSERT INTO stock_openings(salon_id,good_row_id,storage_id,qty_base,taken_at) VALUES(1,1,1,100,'2026-11-10T00:00:00Z')");
  await put({ id: 10, source: 'backfill', at: '2026-11-01T00:00:00Z', qty: 200, cost: 1000 });
  await put({ id: 11, at: '2026-11-02T00:00:00Z', qty: 10, cost: 20 });
  await put({ id: 12, kind: 'consumable', source: 'webhook', at: '2026-11-03T00:00:00Z', recorded: '2026-11-11T00:00:00Z', qty: -4, cost: 8 });
  await put({ id: 13, at: '2026-11-11T00:00:00Z', qty: 20, cost: 40 });
  await put({ id: 14, kind: 'sale', at: '2026-11-12T00:00:00Z', qty: -2, cost: 100 });
  await put({ id: 15, at: '2026-11-13T00:00:00Z', qty: 10, cost: 100 });
  assert.equal((await val(10)).balance_after, null, 'before snapshot not reconstructed');
  assert.equal((await val(11)).balance_after, null, 'local before snapshot still has no historical baseline');
  assert.equal(Number((await val(13)).balance_after), 126, 'opening + all local + late webhook, no backfill');
  assert.equal(Number((await val(14)).balance_after), 124);
  assert.equal(Number((await val(14)).cost_basis), 4, 'sale uses previous receipt not sale price or future receipt');
  await put({ id: 16, kind: 'consumable', at: '2026-11-10T12:00:00Z', recorded: '2026-11-15T00:00:00Z', qty: -1, cost: 2 });
  assert.equal(Number((await val(14)).balance_after), 123, 'backdated local movement counted outside filter/page');
  await put({ id: 17, kind: 'sale', at: '2026-11-12T00:00:00Z', qty: -2, cost: 100, status: 'cancelled', deleted: '2026-11-14T00:00:00Z' });
  assert.equal((await val(17)).balance_after, null);
  assert.equal(Number((await val(14)).balance_after), 123, 'cancelled row does not affect earlier balances');
  await put({ id: 18, kind: 'writeoff', at: '2026-11-12T00:00:00Z', qty: -0.0001, cost: 0 });
  assert.equal(Number((await val(18)).balance_after), 122.9999, 'same timestamp stable movement id and fractions');
  assert.equal(Number((await val(18)).cost_basis), 0, 'zero distinct from unknown');
  await put({ id: 19, kind: 'move', at: '2026-11-12T01:00:00Z', qty: -3, cost: 6 });
  await put({ id: 20, kind: 'move', at: '2026-11-12T01:00:00Z', qty: 3, cost: 6, storage: 2 });
  assert.equal(Number((await val(19)).balance_after), 119.9999);
  assert.equal(Number((await val(20)).balance_after), 3, 'other storage has independent zero baseline');
  await put({ id: 21, kind: 'sale', at: '2026-10-01T00:00:00Z', qty: -1, cost: 15 });
  assert.equal((await val(21)).cost_basis, null, 'no historical receipt remains unknown');
  await put({ id: 22, at: '2026-11-12T02:00:00Z', qty: 1000, cost: 1000, salon: 2, good: 2, storage: 3 });
  assert.equal((await val(22)).balance_after, null, 'cross-salon id never resolved');
  await put({ id: 23, at: '2026-11-14T00:00:00Z', qty: 1, cost: 0, comment: 'unit_unknown' });
  assert.equal((await val(23)).balance_after, null, 'unknown units cannot claim known balance');
  assert.equal((await val(23)).cost_basis, null);

  await request('GET', '/operations', undefined, { noAuth: true, status: 401 });
  await request('GET', '/operations', undefined, { role: 'specialist', status: 403 });
  const page = await request('GET', '/operations?from=2026-11-12&to=2026-11-12&limit=2');
  assert.equal(page.operations.length, 2);
  assert.ok(page.total > 2, 'total counts rows, not page');
  assert.ok(page.operations.every(row => Number(row.id) !== 22), 'tenant isolation');
  const beyond = await request('GET', '/operations?from=2026-11-12&to=2026-11-12&limit=2&page=999');
  assert.equal(beyond.total, page.total, 'total survives empty page');
  assert.equal(beyond.operations.length, 0);
  const sales = await request('GET', '/operations?kind=sale&status=posted&document_number=14');
  assert.equal(sales.operations.length, 1);
  assert.equal(Number(sales.operations[0].cost_basis), 4);
  const foreign = await request('GET', '/operations', undefined, { salonId: 2 });
  assert.equal(foreign.total, 1);
  assert.equal(Number(foreign.operations[0].id), 22);
  const unknownUnits = (await request('GET', '/operations?document_number=23')).operations[0];
  assert.equal(unknownUnits.qty_base, null, 'unknown historical unit conversion is not presented as a known quantity');
  assert.equal(unknownUnits.qty_pack, null);
  await q("UPDATE stock_documents SET client_id=1,yclients_document_id=70014 WHERE id=14");
  const byLocal = await request('GET', '/operations?document_number=14&kind=sale&status=posted');
  assert.equal(byLocal.operations.length, 1, 'local document id remains searchable for mirrored document numbers');
  const combined = await request('GET', '/operations?document_number=70014&search=cream&counterparty=Synthetic&client_search=Synthetic&payment_status=unpaid');
  assert.equal(combined.operations.length, 1, 'combined filters');
  assert.equal((await request('GET', '/operations?search=%25')).total, 0, 'literal percent does not wildcard all products');
  await q('UPDATE stock_movements SET service_yc_id=20,record_id=90 WHERE id=12');
  assert.equal((await request('GET', '/operations?service=20')).operations.length, 1);
  assert.equal((await request('GET', '/operations/services')).services.length, 1);
  await put({ id: 30, at: '2026-11-14T20:59:59Z', qty: 1, cost: 1 });
  await put({ id: 31, at: '2026-11-14T21:00:00Z', qty: 1, cost: 1 });
  const moscowDay = await request('GET', '/operations?from=2026-11-15&to=2026-11-15');
  assert.ok(moscowDay.operations.some(row => Number(row.id) === 31), 'Moscow midnight included');
  assert.ok(!moscowDay.operations.some(row => Number(row.id) === 30), 'previous Moscow date excluded');
  const historyBefore = await request('GET', '/documents/14/history');
  assert.ok(historyBefore.events.some(e => e.action === 'document_created'));
  assert.ok(historyBefore.events.some(e => e.action === 'movement_created'));
  await q('UPDATE stock_movements SET qty_base=qty_base WHERE id=14');
  assert.equal((await request('GET', '/documents/14/history')).events.length, historyBefore.events.length, 'repeated payload is not an audit change');
  await q('SAVEPOINT audit_rollback');
  await q('UPDATE stock_movements SET qty_base=-3 WHERE id=14');
  assert.equal((await request('GET', '/documents/14/history')).events.length, historyBefore.events.length + 1);
  await q('ROLLBACK TO SAVEPOINT audit_rollback');
  assert.equal((await request('GET', '/documents/14/history')).events.length, historyBefore.events.length, 'audit rolled back with business write');
  await q("UPDATE stock_documents SET comment='Synthetic private comment' WHERE id=14");
  const commentHistory = await request('GET', '/documents/14/history');
  assert.ok(commentHistory.events.some(e => e.changes.comment_changed === true));
  assert.ok(!JSON.stringify(commentHistory.events).includes('Synthetic private comment'), 'audit stores no free-text content');
  await request('GET', '/documents/14/history', undefined, { salonId: 2, status: 404 });
  await q(`INSERT INTO stock_documents(id,salon_id,kind,origin,status,storage_id,doc_date,total_cost)
    VALUES(100,1,'receipt','loyalpro','posted',1,'2026-11-15T10:00:00Z',101)`);
  await q(`INSERT INTO stock_movements(salon_id,document_id,good_row_id,storage_id,qty,unit_type,qty_base,cost,source,occurred_at)
    SELECT 1,100,1,1,1,2,1,1,'loyalpro','2026-11-15T10:00:00Z'::timestamptz FROM generate_series(1,101)`);
  const multiple = await request('GET', '/operations?document_number=100&limit=25');
  assert.equal(multiple.total, 101, 'one document has 101 movement rows');
  assert.equal(multiple.operations.length, 25);
  // The fixture already holds a transaction with a fixed snapshot. Map the
  // export's BEGIN to the harness savepoint; never commit the outer fixture.
  const connect = pool.connect;
  pool.connect = async () => {
    const client = await connect();
    return { ...client, query: (sql, p) => client.query(sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ? 'BEGIN' : sql, p) };
  };
  try {
    const response = await fetch(base + '/api/stock/operations/export?document_number=100&limit=25&page=3', {
      headers: { Authorization: 'Bearer ' + token() },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /spreadsheetml/);
    const book = new (require('exceljs').Workbook)();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.equal(book.worksheets[0].rowCount, 102, 'real export includes all matching rows irrespective of selected page');
    assert.equal(book.worksheets[0].getCell('B102').value, '100');
  } finally { pool.connect = connect; }
  console.log('PASS operations PostgreSQL TEMP: balances, historical receipt costs, fractions, backdating, cancellation, storage/tenant separation, API roles/filter/pagination.');
}

if (require.main === module) withEnvironment(acceptance)
  .catch(error => { console.error('FAIL operations TEMP acceptance:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
module.exports = { acceptance };
