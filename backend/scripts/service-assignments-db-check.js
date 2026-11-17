'use strict';
// Synthetic, connection-local tables only. Never runs application migrations.
const assert=require('node:assert/strict');
const {pool}=require('../db');
const {SERVICE_CATALOG_DDL,SERVICE_STAFF_ASSIGNMENTS_DDL}=require('../migrations');
async function main(){
 const c=await pool.connect();let checks=0;
 try{
  assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name,'loyalpro_test');
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='3s'");await c.query("SET LOCAL statement_timeout='15s'");
  await c.query('CREATE TEMP TABLE salons(id INTEGER PRIMARY KEY,yclients_company_id TEXT) ON COMMIT DROP');
  await c.query('CREATE TEMP TABLE staff_members(id INTEGER PRIMARY KEY,salon_id INTEGER,yclients_staff_id INTEGER,is_active BOOLEAN,name TEXT) ON COMMIT DROP');
  await c.query('SET LOCAL search_path=pg_temp');
  await c.query(SERVICE_CATALOG_DDL);await c.query(SERVICE_STAFF_ASSIGNMENTS_DDL);
  await c.query(SERVICE_CATALOG_DDL);await c.query(SERVICE_STAFF_ASSIGNMENTS_DDL);checks++;
  await c.query("INSERT INTO salons VALUES(1,'1000'),(2,'2000')");await c.query("INSERT INTO staff_members VALUES(10,1,100,true,'Synthetic A'),(20,2,200,true,'Synthetic B')");
  await c.query("INSERT INTO service_catalog(id,salon_id,title,duration) VALUES(11,1,'Synthetic A',30),(22,2,'Synthetic B',30)");
  await c.query('INSERT INTO service_staff_assignments(salon_id,service_id,staff_member_id,price_min,duration) VALUES(1,11,10,0,45)');checks++;
  const invalid=async(sql,code)=>{await c.query('SAVEPOINT expected_error');let actual;try{await c.query(sql);}catch(e){actual=e.code;}await c.query('ROLLBACK TO expected_error');assert.equal(actual,code);checks++;};
  await invalid('INSERT INTO service_staff_assignments(salon_id,service_id,staff_member_id) VALUES(1,11,20)','23503');
  await invalid('INSERT INTO service_staff_assignments(salon_id,service_id,staff_member_id) VALUES(2,11,20)','23503');
  await invalid('INSERT INTO service_staff_assignments(salon_id,service_id,staff_member_id) VALUES(1,11,10)','23505');
  await invalid('UPDATE service_staff_assignments SET duration=0','23514');
  await invalid('UPDATE service_staff_assignments SET price_min=-1','23514');
  await invalid('UPDATE service_staff_assignments SET price_min=10,price_max=9','23514');
  await c.query('UPDATE service_staff_assignments SET price_min=NULL,price_max=NULL,duration=NULL');checks++;
  // Exercise real catalog SQL in the same isolated transaction. Map the
  // service's transaction boundaries to savepoints so no fixture can commit.
  const dbModule=require('../db');
  dbModule.pool={connect:async()=>({release(){},query:(sql,args)=>{
   if(sql==='BEGIN')return c.query('SAVEPOINT catalog_save');
   if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT catalog_save');
   if(sql==='ROLLBACK')return c.query('ROLLBACK TO SAVEPOINT catalog_save');
   return c.query(sql,args);
  }})};
  let reads=Promise.resolve();
  dbModule.db.any=(sql,args)=>{const result=reads.then(()=>c.query(sql,args)).then(r=>r.rows);reads=result.catch(()=>{});return result;};
  dbModule.db.oneOrNone=async(sql,args)=>(await dbModule.db.any(sql,args))[0]||null;
  const catalog=require('../services/service-catalog');
  const body={title:'Synthetic edited',duration:30,priceMin:6000,priceMax:6000,active:true,version:0,assignments:[{staffMemberId:10,priceMin:0,priceMax:0,duration:45}]};
  await catalog.saveService(1,11,body);
  let service=(await catalog.list(1)).services[0];
  assert.equal(service.version,1);assert.equal(catalog.journalService(service).staffDetails[0].priceMin,0);assert.equal(catalog.journalService(service).staffDetails[0].duration,45);checks++;
  await assert.rejects(catalog.saveService(1,11,body),/изменена/);checks++;
  await assert.rejects(catalog.saveService(1,11,{...body,version:1,assignments:[{staffMemberId:20}]}),/Специалист/);
  service=(await catalog.list(1)).services[0];assert.equal(service.version,1);assert.equal(service.assignments[0].priceMin,0);checks++;
  await catalog.saveService(1,11,{...body,version:1,assignments:[{staffMemberId:10}]});
  service=(await catalog.list(1)).services[0];assert.equal(catalog.journalService(service).staffDetails[0].priceMin,6000);assert.equal(catalog.journalService(service).staffDetails[0].duration,30);checks++;
  await catalog.saveService(1,11,{...body,version:2,assignments:[]});
  service=(await catalog.list(1)).services[0];assert.deepEqual(catalog.journalService(service).staffIds,[]);checks++;
  // Real reconciliation SQL against connection-local tables; no network.
  const yc=require('../services/journal/yclients'), originalList=yc.list;
  yc.list=async(salon,path)=>{
   assert.equal(Number(salon.id),1);
   if(path==='/staff/1000')return [{id:100,fired:false}];
   assert.equal(path,'/company/1000/services/');
   return [
    {id:700,duration:1800,price_min:100,price_max:100,staff:[{id:100,price:{min:0,max:0},seance_length:2700}]},
    {id:701,duration:3600,price_min:200,price_max:200,staff:[{id:100,price:null,seance_length:3600}]},
   ];
  };
  const reconcile=require('../services/service-catalog-reconcile');
  try{
   await c.query('UPDATE service_catalog SET yclients_id=700,yclients_company_id=1000 WHERE salon_id=1 AND id=11');
   await c.query("INSERT INTO service_catalog(id,salon_id,title,duration,yclients_id,yclients_company_id) VALUES(12,1,'Synthetic reconcile',30,701,1000)");
   const before=(await c.query('SELECT id,version,staff,price_min,duration FROM service_catalog WHERE salon_id=1 ORDER BY id')).rows;
   const preview=await reconcile.preview(1);
   assert.equal(preview.canApply,true);assert.equal(preview.targets.length,2);checks++;
   assert.deepEqual((await c.query('SELECT id,version,staff,price_min,duration FROM service_catalog WHERE salon_id=1 ORDER BY id')).rows,before);checks++;
   await assert.rejects(reconcile.apply(2,preview.runId),/не найдена/);checks++;
   const originalReplace=catalog.replaceAssignments;let replacements=0;
   catalog.replaceAssignments=async(...args)=>{if(++replacements===2)throw new Error('synthetic mid-apply failure');return originalReplace(...args);};
   try{await assert.rejects(reconcile.apply(1,preview.runId),/synthetic mid-apply failure/);}finally{catalog.replaceAssignments=originalReplace;}
   assert.deepEqual((await c.query('SELECT id,version,staff,price_min,duration FROM service_catalog WHERE salon_id=1 ORDER BY id')).rows,before);
   assert.equal((await c.query('SELECT status FROM service_catalog_sync_runs WHERE salon_id=1 AND id=$1',[preview.runId])).rows[0].status,'preview');checks++;
   const applied=await reconcile.apply(1,preview.runId);assert.equal(applied.updatedServices,2);
   service=(await catalog.list(1)).services.find(s=>s.id===11);
   assert.equal(service.price_min,'100.00');assert.equal(service.assignments[0].priceMin,0);assert.equal(service.assignments[0].duration,45);checks++;
   const appliedVersions=(await c.query('SELECT id,version FROM service_catalog WHERE salon_id=1 ORDER BY id')).rows;
   const retry=await reconcile.apply(1,preview.runId);assert.equal(retry.alreadyApplied,true);
   assert.deepEqual((await c.query('SELECT id,version FROM service_catalog WHERE salon_id=1 ORDER BY id')).rows,appliedVersions);checks++;
   const stale=await reconcile.preview(1);
   await c.query('UPDATE staff_members SET is_active=false WHERE salon_id=1 AND id=10');
   await assert.rejects(reconcile.apply(1,stale.runId),/изменились/);checks++;
   await c.query('UPDATE staff_members SET is_active=true WHERE salon_id=1 AND id=10');
   const expired=await reconcile.preview(1);
   await c.query("UPDATE service_catalog_sync_runs SET snapshot=jsonb_set(snapshot,'{capturedAt}',to_jsonb((NOW()-INTERVAL '31 minutes')::text)) WHERE salon_id=1 AND id=$1",[expired.runId]);
   await assert.rejects(reconcile.apply(1,expired.runId),/устарела/);checks++;
   assert.equal((await c.query('SELECT count(*)::int AS n FROM service_staff_assignments WHERE salon_id=2')).rows[0].n,0);checks++;
  }finally{yc.list=originalList;}
  await c.query('ROLLBACK');console.log(JSON.stringify({checks,status:'passed',scope:'temporary synthetic tables; rolled back; no upstream requests'}));
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
}
main().catch(()=>{console.error('Synthetic assignment database check failed');process.exitCode=1;});
