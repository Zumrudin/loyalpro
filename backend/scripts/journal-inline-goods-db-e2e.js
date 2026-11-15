'use strict';
// Real PostgreSQL acceptance for inline journal goods. Every object is TEMP and
// the outer transaction always rolls back. No external API is called.
require('dotenv').config({ quiet: true });
const assert = require('assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { pool } = require('../db');
const config = require('../config');
const { APPOINTMENT_GOODS_DDL } = require('../migrations');

const TABLES = ['salons','users','sessions','clients','records','yclients_goods_catalog','stock_storages',
  'stock_documents','stock_movements','stock_openings','finance_operations','journal_reference_cache','journal_outbox'];

async function main() {
  const client = await pool.connect();
  const q = client.query.bind(client);
  const originalQuery = pool.query, originalConnect = pool.connect;
  let server;
  try {
    const database = (await q('SELECT current_database() AS name')).rows[0].name;
    assert.equal(database, 'loyalpro_test', 'Only loyalpro_test is allowed');
    await q('BEGIN');
    for (const table of TABLES) {
      await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`);
      const seqCols = (await q(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_default LIKE 'nextval%'`, [table])).rows;
      for (const { column_name } of seqCols) {
        const seq = `inline_goods_${table}_${column_name}`;
        await q(`CREATE TEMP SEQUENCE ${seq} START 10000`);
        await q(`ALTER TABLE pg_temp.${table} ALTER COLUMN ${column_name} SET DEFAULT nextval('pg_temp.${seq}')`);
      }
    }
    await q('SET LOCAL search_path TO pg_temp');
    // Exercise the additive migration twice: every statement must be idempotent.
    for (let pass=0; pass<2; pass++) for (const ddl of APPOINTMENT_GOODS_DDL) await q(ddl);

    await q("INSERT INTO salons(id,name) VALUES(1,'Inline synthetic'),(2,'Inline other')");
    await q(`INSERT INTO users(id,salon_id,email,password_hash,name,role) VALUES
      (11,1,'inline-owner@example.invalid','unused','Owner','owner'),
      (12,1,'inline-specialist@example.invalid','unused','Specialist','specialist'),
      (21,2,'inline-other@example.invalid','unused','Other','owner')`);
    const token = jwt.sign({ userId:11,salonId:1,role:'owner' }, config.JWT_SECRET, { expiresIn:'10m' });
    const specialistToken = jwt.sign({ userId:12,salonId:1,role:'specialist' }, config.JWT_SECRET, { expiresIn:'10m' });
    const otherToken = jwt.sign({ userId:21,salonId:2,role:'owner' }, config.JWT_SECRET, { expiresIn:'10m' });
    await q("INSERT INTO sessions(user_id,token,expires_at) VALUES(11,$1,NOW()+INTERVAL '10 minutes'),(12,$2,NOW()+INTERVAL '10 minutes'),(21,$3,NOW()+INTERVAL '10 minutes')", [token,specialistToken,otherToken]);
    await q(`INSERT INTO clients(id,salon_id,name,phone,yclients_client_id) VALUES
      (1,1,'Synthetic client','70000000001',111),(2,2,'Other client','70000000002',222)`);
    await q(`INSERT INTO records(id,salon_id,yclients_record_id,client_id,yclients_client_id,visit_date,status,raw_payload)
      VALUES(1,1,90,1,111,CURRENT_DATE,'confirmed','{}')`);
    await q(`INSERT INTO stock_storages(id,salon_id,title,for_sale,is_active) VALUES
      (1,1,'Sale A',true,true),(2,1,'Sale B',true,true),(3,2,'Other',true,true)`);
    await q(`INSERT INTO yclients_goods_catalog(id,salon_id,title,source,unit,service_unit,unit_equals,stock_active,local_sale_price,
      loyalty_certificate_type_id,loyalty_abonement_type_id) VALUES
      (1,1,'Ordinary','loyalpro','pc','pc',1,true,100,NULL,NULL),
      (2,1,'Certificate','loyalpro','pc','pc',1,true,5000,700,NULL),
      (3,1,'Abonement','loyalpro','pc','pc',1,true,9000,NULL,800),
      (4,2,'Other certificate','loyalpro','pc','pc',1,true,5000,701,NULL)`);
    await q("INSERT INTO journal_reference_cache(salon_id,kind,payload) VALUES(1,'staff','[{\"id\":30,\"name\":\"Synthetic\"}]')");

    // Database, rather than app memory, owns global uniqueness across tenants/types.
    const duplicate = 'DUPLICATEGLOBAL';
    await q('SAVEPOINT duplicate_code');
    await q(`INSERT INTO appointment_goods_codes(id,request_id,salon_id,reserved_by,good_row_id,kind,code,normalized_code,status,reserved_until)
      VALUES($1,$2,1,11,2,'certificate',$3,$3,'reserved',NOW()+INTERVAL '100 years')`, [randomUUID(),randomUUID(),duplicate]);
    let duplicateRejected=false;
    try {
      await q(`INSERT INTO appointment_goods_codes(id,request_id,salon_id,reserved_by,good_row_id,kind,code,normalized_code,status,reserved_until)
        VALUES($1,$2,2,21,4,'certificate',$3,$4,'reserved',NOW()+INTERVAL '100 years')`, [randomUUID(),randomUUID(),'duplicate-global',duplicate]);
    } catch (e) { duplicateRejected=e.code==='23505'; await q('ROLLBACK TO SAVEPOINT duplicate_code'); }
    assert.equal(duplicateRejected,true,'global normalized code must be unique');

    pool.query=(...args)=>q(...args);
    pool.connect=async()=>({
      query:(sql,args)=>q(sql==='BEGIN'?'SAVEPOINT inline_goods_op':sql==='COMMIT'?'RELEASE SAVEPOINT inline_goods_op':
        sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT inline_goods_op':sql,args), release() {},
    });
    const app=express(); app.use(express.json()); app.use('/api/stock',require('../routes/stock'));
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const base=`http://127.0.0.1:${server.address().port}/api/stock`;
    async function request(method,path,body,status=200,authToken=token) {
      const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(authToken?{Authorization:`Bearer ${authToken}`}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await r.json();
      assert.equal(r.status,status,`${method} ${path} expected ${status}, got ${r.status}: ${data.code||data.error||''}`);
      return data;
    }
    await request('GET','/records/90/goods',undefined,401,null);
    await request('GET','/records/90/goods',undefined,403,specialistToken);
    await request('GET','/records/90/goods',undefined,404,otherToken);
    await request('PUT','/records/90/goods',{version:0,requestId:randomUUID(),clientId:2,lines:[]},404,otherToken);
    await request('POST','/goods/2/code-reservations',{requestId:randomUUID()},400,otherToken);
    const reserve=await request('POST','/goods/2/code-reservations',{requestId:randomUUID()},201);
    assert.equal(reserve.kind,'certificate');
    const saveId=randomUUID();
    const body={version:0,requestId:saveId,clientId:1,lines:[
      {lineId:randomUUID(),goodRowId:1,storageId:1,qty:2,unitType:1,price:100,total:200,masterStaffYcId:30},
      {lineId:randomUUID(),goodRowId:2,storageId:2,qty:1,unitType:1,price:5000,total:5000,masterStaffYcId:30,codeReservationId:reserve.id},
    ]};
    const saved=await request('PUT','/records/90/goods',body);
    assert.equal(saved.version,1); assert.equal(saved.documents.length,2); assert.equal(saved.total,5200);
    const movements=(await q('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n;
    const replay=await request('PUT','/records/90/goods',body);
    assert.equal(replay.version,1);
    assert.equal((await q('SELECT count(*)::int AS n FROM stock_movements')).rows[0].n,movements,'replay must not move stock');
    await request('PUT','/records/90/goods',{...body,requestId:randomUUID(),version:0},409);
    const reopened=await request('GET','/records/90/goods');
    assert.equal(reopened.lines.length,2); assert.equal(reopened.outstanding,5200);
    const certDoc=reopened.lines.find(x=>x.kind==='certificate').documentId;
    await request('POST',`/sales/${certDoc}/payments`,{paymentId:randomUUID(),method:'card',amount:5000},201);
    assert.equal((await q('SELECT status FROM appointment_goods_codes WHERE id=$1',[reserve.id])).rows[0].status,'active');
    const paidView=await request('GET','/records/90/goods');
    const editableLines=paidView.lines.filter(x=>!x.readOnly).map(x=>({
      lineId:x.lineId,goodRowId:x.goodRowId,storageId:x.storageId,qty:x.qty,unitType:x.unitType,
      price:x.price,discount:x.discount,total:x.total,masterStaffYcId:x.masterStaffYcId,
      ...(x.code?{codeReservationId:x.code.id}:{}),
    }));
    const paidCert=editableLines.find(x=>x.goodRowId===2);
    const added=await request('PUT','/records/90/goods',{version:paidView.version,requestId:randomUUID(),clientId:1,
      lines:[...editableLines,{lineId:randomUUID(),goodRowId:1,storageId:2,qty:1,unitType:1,price:150,total:150,masterStaffYcId:30}]});
    assert.equal(added.lines.filter(x=>x.kind==='certificate').length,1,'paid certificate must remain unchanged');
    assert.equal(added.lines.filter(x=>x.kind==='good').length,2,'new ordinary line must be added');
    await request('PUT','/records/90/goods',{version:added.version,requestId:randomUUID(),clientId:1,
      lines:added.lines.filter(x=>!x.readOnly).map(x=>({lineId:x.lineId,goodRowId:x.goodRowId,storageId:x.storageId,
        qty:x.qty,unitType:x.unitType,price:x.goodRowId===2?x.price+1:x.price,discount:x.discount,total:x.goodRowId===2?x.total+1:x.total,
        masterStaffYcId:x.masterStaffYcId,...(x.code?{codeReservationId:x.code.id}:{})}))},409);
    await q(`INSERT INTO records(id,salon_id,yclients_record_id,client_id,yclients_client_id,visit_date,status,raw_payload)
      VALUES(3,1,92,1,111,CURRENT_DATE,'confirmed','{}')`);
    await request('PUT','/records/92/goods',{version:0,requestId:randomUUID(),clientId:1,lines:[{
      lineId:randomUUID(),goodRowId:2,storageId:2,qty:1,unitType:1,price:5000,total:5000,masterStaffYcId:30,codeReservationId:paidCert.codeReservationId,
    }]},409);
    await request('POST',`/documents/${certDoc}/cancel`,{reason:'Synthetic cancellation'});
    assert.equal((await q('SELECT status FROM appointment_goods_codes WHERE id=$1',[reserve.id])).rows[0].status,'cancelled');

    // A local negative record keeps one set and remaps documents/movements when YC id appears.
    await q(`INSERT INTO journal_outbox(id,salon_id,session_id,user_id,request_hash,status,steps,overlay)
      VALUES(500,1,$1,11,'hash','queued','[]',$2)`, [randomUUID(),JSON.stringify({kind:'create',client:{id:111,phone:'70000000001'}})]);
    const localLine={lineId:randomUUID(),goodRowId:1,storageId:1,qty:1,unitType:1,price:100,total:100};
    const local=await request('PUT','/records/-500/goods',{version:0,requestId:randomUUID(),clientId:1,lines:[localLine]});
    await q(`INSERT INTO records(id,salon_id,yclients_record_id,client_id,yclients_client_id,visit_date,status,raw_payload)
      VALUES(2,1,91,1,111,CURRENT_DATE,'confirmed','{}')`);
    await q('UPDATE journal_outbox SET yclients_record_id=91 WHERE salon_id=1 AND id=500');
    const remapped=await request('PUT','/records/91/goods',{version:local.version,requestId:randomUUID(),clientId:1,lines:[localLine]});
    assert.equal(remapped.version,2);
    assert.equal((await q(`SELECT count(*)::int AS n FROM appointment_goods_sets WHERE salon_id=1
      AND local_outbox_id=500 AND yclients_record_id=91`)).rows[0].n,1);
    assert.equal((await q("SELECT count(*)::int AS n FROM stock_documents WHERE salon_id=1 AND record_id=-500")).rows[0].n,0);
    assert.equal((await q("SELECT count(*)::int AS n FROM stock_movements WHERE salon_id=1 AND record_id=-500")).rows[0].n,0);
    console.log('journal inline goods DB E2E: OK');
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    pool.query=originalQuery; pool.connect=originalConnect;
    await q('ROLLBACK').catch(()=>{}); client.release(); await pool.end();
  }
}
main().catch(e=>{console.error(`journal inline goods DB E2E failed: ${e.message}`);process.exitCode=1;});
