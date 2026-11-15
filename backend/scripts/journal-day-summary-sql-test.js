'use strict';
// Execute the actual summary SQL on synthetic TEMP tables in an isolated test
// cluster. Pass its Unix socket directory, never a working database URL.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { Client } = require('pg');
async function main() {
  const socket = process.argv[2];
  assert(/^\/tmp\/loyalpro-toolbar-pg-[\w-]+$/.test(socket || ''), 'An isolated test socket is required');
  const client = new Client({ host: socket, port: 55439, user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE finance_operations(salon_id integer,op_date date,amount numeric(14,2),method text,status text,kind text);
      CREATE TEMP TABLE records(salon_id integer,visit_date date,yclients_record_id bigint,status text,raw_payload jsonb);
      CREATE TEMP TABLE journal_outbox(id bigint,salon_id integer,status text,updated_at timestamptz,yclients_record_id bigint,overlay jsonb);`);
    await client.query(`INSERT INTO finance_operations VALUES
      (7,'2030-04-02',100,'cash','confirmed','visit_payment'),
      (7,'2030-04-02',20,'cash','confirmed','goods_sale'),
      (7,'2030-04-02',-10,'cash','confirmed','payment_reversal'),
      (7,'2030-04-02',50,'card','confirmed','visit_payment'),
      (7,'2030-04-02',5,'other','confirmed','other_income'),
      (7,'2030-04-02',-30,'bonus','confirmed','bonus_redemption'),
      (7,'2030-04-02',10,'bonus','confirmed','payment_reversal'),
      (7,'2030-04-02',999,'bonus','confirmed','bonus_accrual'),
      (7,'2030-04-02',999,'cash','queued','visit_payment'),
      (7,'2030-04-02',999,'card','sending','visit_payment'),
      (7,'2030-04-02',999,'cash','failed','visit_payment'),
      (7,'2030-04-02',999,'card','cancelled','visit_payment'),
      (7,'2030-04-01',999,'cash','confirmed','visit_payment'),
      (8,'2030-04-02',999,'cash','confirmed','visit_payment')`);
    const raw = {id:101,datetime:'2030-03-01T10:00:00+03:00',attendance:1,client:{id:11},services:[{cost:123.45}]};
    await client.query('INSERT INTO records VALUES ($1,$2,$3,$4,$5)', [7,'2030-03-01',101,'arrived',JSON.stringify(raw)]);
    await client.query('INSERT INTO journal_outbox VALUES ($1,$2,$3,NOW(),$4,$5)', [1,7,'queued',101,JSON.stringify({kind:'patch',patch:{datetime:'2030-04-02T10:00:00+03:00'}})]);
    // Same target ID in a different tenant must not appear in this summary.
    await client.query('INSERT INTO records VALUES ($1,$2,$3,$4,$5)', [8,'2030-04-02',101,'arrived',JSON.stringify({...raw,datetime:'2030-04-02T10:00:00+03:00',services:[{cost:99999}]})]);
    const file = path.resolve(__dirname,'../services/journal/day-summary.js');
    const module = {exports:{}};
    const serviceRequire = createRequire(file);
    const load = vm.runInThisContext(`(function(require,module){${fs.readFileSync(file,'utf8')}\n})`, {filename:file});
    load(name => name === '../../db' ? {db:{oneOrNone:async (sql,params) => (await client.query(sql,params)).rows[0]}} : serviceRequire(name),module);
    const result = await module.exports.load(7,'2030-04-02');
    assert.deepEqual(result, {date:'2030-04-02',clientCount:1,total:165,cash:110,cashless:50,otherAmount:5,
      completedAmount:123.45,bookedAmount:123.45,loyaltyAmount:20,goodsAmount:20,pendingCount:2});
    const empty = await module.exports.load(7,'2030-04-03');
    assert.equal(empty.total,0); assert.equal(empty.clientCount,0); assert.equal(empty.bookedAmount,0);
    console.log('PASS: actual SQL — money, reversals, bonuses, goods, pending/failed/cancelled, tenant isolation, distant move, empty day.');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
