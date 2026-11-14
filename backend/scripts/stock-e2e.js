'use strict';
// Real PostgreSQL/API acceptance. TEMP tables and sequences; cleanup always ROLLBACK.
require('dotenv').config({ quiet: true });
const assert = require('assert/strict'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const { pool } = require('../db'),
  config = require('../config');
const TABLES = [
  'clients',
  'records',
  'yclients_goods_catalog',
  'stock_storages',
  'stock_units',
  'stock_suppliers',
  'stock_documents',
  'stock_movements',
  'stock_openings',
  'stock_inventory_lines',
  'stock_ingest_pending',
  'stock_settings',
  'goods_transactions',
  'finance_operations',
  'goods_price_overrides',
  'service_tech_cards',
  'tech_cards',
  'service_catalog',
  'journal_reference_cache',
  'journal_outbox',
];
async function withEnvironment(fn) {
  const client = await pool.connect(),
    q = client.query.bind(client);
  let server;
  const originalQuery = pool.query,
    originalConnect = pool.connect;
  const yc = require('../services/yclients'),
    originals = {};
  try {
    assert.equal(
      (await q('SELECT current_database() AS name')).rows[0].name,
      'loyalpro_test',
      'Only loyalpro_test is allowed',
    );
    await q('BEGIN');
    for (const table of TABLES) {
      await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`);
      const columns = (
        await q(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_default LIKE 'nextval%'",
          [table],
        )
      ).rows;
      for (const { column_name: col } of columns) {
        const seq = 'e2e_' + table + '_' + col;
        await q(`CREATE TEMP SEQUENCE ${seq} START 1000`);
        await q(`ALTER TABLE pg_temp.${table} ALTER COLUMN ${col} SET DEFAULT nextval('pg_temp.${seq}')`);
      }
    }
    await q('SET LOCAL search_path TO pg_temp');
    pool.query = (...args) => q(...args);
    pool.connect = async () => ({
      query: (sql, params) =>
        q(
          sql === 'BEGIN'
            ? 'SAVEPOINT stock_operation'
            : sql === 'COMMIT'
              ? 'RELEASE SAVEPOINT stock_operation'
              : sql === 'ROLLBACK'
                ? 'ROLLBACK TO SAVEPOINT stock_operation'
                : sql,
          params,
        ),
      release() {},
    });
    for (const [k, v] of Object.entries(yc))
      if (typeof v === 'function') {
        originals[k] = v;
        yc[k] = () => {
          throw new Error('External calls disabled in stock E2E');
        };
      }
    await q(
      "INSERT INTO stock_storages(id,salon_id,title,for_sale,for_service) VALUES(1,1,'Synthetic sales',true,true),(2,1,'Synthetic second',true,true),(3,2,'Other tenant',true,true)",
    );
    await q("INSERT INTO stock_units(id,salon_id,title,short_title) VALUES(1,1,'Piece','pc')");
    await q(
      "INSERT INTO yclients_goods_catalog(id,salon_id,yclients_good_id,title,source,unit,service_unit,unit_equals,unit_id,service_unit_id,local_sale_price,unit_actual_cost) VALUES(1,1,101,'Synthetic <cream>','loyalpro','pc','pc',1,1,1,10,2),(2,2,202,'Other tenant','loyalpro','pc','pc',1,1,1,10,2)",
    );
    await q(
      'INSERT INTO stock_settings(salon_id,enabled,default_sale_storage_id,default_service_storage_id) VALUES(1,true,1,1),(2,true,3,3)',
    );
    await q(
      "INSERT INTO clients(id,salon_id,name,yclients_client_id) VALUES(1,1,'Synthetic client',111),(2,1,'Synthetic other client',112)",
    );
    await q(
      'INSERT INTO records(id,salon_id,yclients_record_id,client_id,yclients_client_id,visit_date,raw_payload) VALUES(1,1,90,1,111,CURRENT_DATE,$1)',
      [JSON.stringify({ staff_id: 30, services: [{ id: 20, title: 'Synthetic service', amount: 2 }] })],
    );
    await q("INSERT INTO tech_cards(id,salon_id,title,items,source) VALUES(1,1,'Synthetic card',$1,'manual')", [
      JSON.stringify([{ good_id: 101, amount: 2 }]),
    ]);
    await q("INSERT INTO service_tech_cards(salon_id,service_yc_id,tech_card_id,source) VALUES(1,20,1,'manual')");
    await q("INSERT INTO journal_reference_cache(salon_id,kind,payload) VALUES(1,'staff',$1)", [
      JSON.stringify([{ id: 30, name: 'Synthetic staff' }]),
    ]);
    const app = express();
    app.use(express.json());
    app.use('/api/stock', require('../routes/stock'));
    app.use(express.static(require('path').join(__dirname, '../../frontend')));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const token = (role = 'owner', salonId = 1) =>
      jwt.sign({ userId: 1, salonId, role }, config.JWT_SECRET, { expiresIn: '10m' });
    const request = async (method, path, body, { role = 'owner', salonId = 1, status = 200, noAuth = false } = {}) => {
      const r = await fetch(base + '/api/stock' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(!noAuth ? { Authorization: 'Bearer ' + token(role, salonId) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await r.json();
      assert.equal(
        r.status,
        status,
        `${method} ${path.split('?')[0]} expected ${status}, got ${r.status}: ${data.code || data.error || ''}`,
      );
      return data;
    };
    await fn({ request, q, app, base, token });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery;
    pool.connect = originalConnect;
    Object.assign(yc, originals);
    await q('ROLLBACK').catch(() => {});
    client.release();
  }
}
async function acceptance({ request, q }) {
  const post = (p, b, opts = {}) => request('POST', p, b, { status: 201, ...opts });
  const line = { goodRowId: 1, qty: 10, unitType: 1, costPerUnit: 2 };
  const doc = { kind: 'receipt', storageId: 1, docDate: new Date().toISOString(), lines: [line] };
  await request('GET', '/goods', undefined, { noAuth: true, status: 401 });
  await request('GET', '/goods', undefined, { role: 'specialist', status: 403 });
  await request('PUT', '/settings', { defaultSaleStorageId: 1 }, { role: 'admin', status: 403 });
  await request('GET', '/goods/1', undefined, { salonId: 2, status: 404 });
  await post('/documents', { ...doc, storageId: 3 }, { status: 400 });
  await post('/documents', { ...doc, lines: [{ ...line, goodRowId: 2 }] }, { status: 400 });
  await post(
    '/sales',
    { storageId: 1, clientId: 1, masterStaffYcId: 999, lines: [line], payments: [{ method: 'cash', amount: 20 }] },
    { status: 400 },
  );
  await post(
    '/sales',
    { storageId: 1, clientId: 2, recordId: 90, lines: [line], payments: [{ method: 'cash', amount: 20 }] },
    { status: 400 },
  );
  await post('/sales', { storageId: 1, clientId: 1, gift: true, lines: [line], payments: [] }, { status: 400 });
  const receipt = await post('/documents', doc);
  assert.equal(Number((await request('GET', '/balances'))[0].qty_base), 10);
  const docsBefore = (await q('SELECT count(*) AS n FROM stock_documents')).rows[0].n;
  await q('ALTER TABLE pg_temp.finance_operations ADD CONSTRAINT synthetic_payment_failure CHECK (amount < 5)');
  await post(
    '/sales',
    {
      storageId: 1,
      clientId: 1,
      lines: [{ ...line, qty: 1, costPerUnit: 10 }],
      payments: [{ method: 'cash', amount: 10 }],
    },
    { status: 502 },
  );
  assert.equal((await q('SELECT count(*) AS n FROM stock_documents')).rows[0].n, docsBefore);
  assert.equal((await q('SELECT count(*) AS n FROM finance_operations')).rows[0].n, '0');
  await q('ALTER TABLE pg_temp.finance_operations DROP CONSTRAINT synthetic_payment_failure');
  const sale = (
    await post('/sales', {
      storageId: 1,
      clientId: 1,
      recordId: 90,
      lines: [{ ...line, qty: 2, costPerUnit: 10 }],
      payments: [
        { method: 'cash', amount: 7 },
        { method: 'card', amount: 13 },
      ],
    })
  ).document;
  assert.equal((await request('GET', '/documents/' + sale.id)).payments.length, 2);
  await post(
    '/sales',
    {
      storageId: 1,
      clientId: 1,
      lines: [{ ...line, qty: 1, costPerUnit: 10 }],
      payments: [{ method: 'cash', amount: 9 }],
    },
    { status: 400 },
  );
  assert.equal((await request('GET', '/clients/1/purchases')).length, 1);
  await request('POST', '/documents/' + sale.id + '/cancel', { reason: 'Synthetic cleanup' });
  assert.equal((await q("SELECT count(*) AS n FROM finance_operations WHERE status<>'cancelled'")).rows[0].n, '0');
  const move = await post('/documents', { ...doc, kind: 'move', toStorageId: 2, lines: [{ ...line, qty: 3 }] });
  assert.equal(
    (await request('GET', '/balances')).reduce((sum, r) => sum + Number(r.qty_base), 0),
    10,
  );
  await request('POST', '/documents/' + move.id + '/cancel', { reason: 'Synthetic cleanup' });
  assert.equal((await request('GET', '/records/90/consumables')).summary.expected, 8);
  await request('PUT', '/records/90/consumables/20', { lines: [{ goodRowId: 1, qtyBase: 4 }] });
  assert.equal(
    (await request('PUT', '/records/90/consumables/20', { lines: [{ goodRowId: 1, qtyBase: 4 }] })).unchanged,
    true,
  );
  assert.equal((await request('GET', '/records/90/consumables')).summary.actual, 8);
  await request('PUT', '/records/90/consumables/20', { lines: [] });
  const inv = await post('/inventories', { storageId: 1 });
  await request('PUT', '/inventories/' + inv.id + '/lines', {
    lines: [{ goodRowId: 1, counted: 10, countedUnitType: 1 }],
  });
  await request('POST', '/inventories/' + inv.id + '/post', {});
  assert.equal((await q('SELECT count(*) AS n FROM stock_movements WHERE document_id=$1', [inv.id])).rows[0].n, '0');
  assert.equal((await request('GET', '/goods/1')).unitPrice.price, 2);
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const report = await request('GET', '/reports/turnover?from=' + day + '&to=' + day);
  assert.equal(Number(report.rows.find((r) => Number(r.storage_id) === 1).end_qty), 10);
  await request('POST', '/documents/' + receipt.id + '/cancel', { reason: 'Synthetic cleanup' });
  assert.equal(
    (await request('GET', '/balances')).reduce((s, r) => s + Number(r.qty_base), 0),
    0,
  );
  console.log(
    'PASS PostgreSQL/API: tenant/role checks, receipt, mixed-payment sale/cancel, transfer, inventory zero delta, consumable corrections/no-op, receipt prices, turnover; rollback cleanup.',
  );
}
if (require.main === module)
  withEnvironment(acceptance)
    .catch((e) => {
      console.error('FAIL', e.code || e.name, e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
module.exports = { withEnvironment, acceptance };
