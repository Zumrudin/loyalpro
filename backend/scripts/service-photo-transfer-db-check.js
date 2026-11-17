'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {pool}=require('../db');const {SERVICE_CATALOG_DDL,SERVICE_STAFF_ASSIGNMENTS_DDL,SERVICE_CATEGORY_PHOTOS_DDL}=require('../migrations');
async function main(){const c=await pool.connect();let checks=0;try{
 assert.equal((await c.query('SELECT current_database() n')).rows[0].n,'loyalpro_test');
 await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='15s'");await c.query("SET LOCAL lock_timeout='3s'");
 await c.query('CREATE TEMP TABLE salons(id INT PRIMARY KEY,yclients_company_id TEXT) ON COMMIT DROP');
 await c.query('CREATE TEMP TABLE staff_members(id INT PRIMARY KEY,salon_id INT,yclients_staff_id INT,is_active BOOLEAN,name TEXT) ON COMMIT DROP');await c.query('SET LOCAL search_path=pg_temp');
 await c.query(SERVICE_CATALOG_DDL);await c.query(SERVICE_STAFF_ASSIGNMENTS_DDL);await c.query(SERVICE_CATEGORY_PHOTOS_DDL);await c.query(SERVICE_CATEGORY_PHOTOS_DDL);checks++;
 await c.query('CREATE TEMP TABLE agent_service_subcategories(id INT PRIMARY KEY,salon_id INT,title TEXT,parent_id INT,yc_category_id BIGINT,display_order INT)');
 await c.query('CREATE TEMP TABLE agent_service_placements(salon_id INT,yc_service_id BIGINT,subcategory_id INT)');
 await c.query('CREATE TEMP TABLE agent_price_photos(id INT PRIMARY KEY,salon_id INT,yc_category_id BIGINT,subcategory_id INT,file_url TEXT,file_name TEXT,mime_type TEXT,byte_size INT,display_order INT)');
 await c.query("INSERT INTO salons VALUES(1,'1000'),(2,'2000')");await c.query("INSERT INTO service_categories(salon_id,title,yclients_id,yclients_company_id) VALUES(1,'Synthetic top',90,1000),(2,'Other salon',90,2000)");
 await c.query("INSERT INTO service_catalog(salon_id,title,duration,yclients_id,yclients_company_id,category_id) VALUES(1,'Synthetic service',30,700,1000,1)");
 await c.query("INSERT INTO agent_service_subcategories VALUES(3,1,'Synthetic child',NULL,90,0),(4,1,'Synthetic nested',3,90,1)");await c.query("INSERT INTO agent_service_placements VALUES(1,700,4)");
 await c.query("INSERT INTO agent_price_photos VALUES(1,1,90,NULL,'/uploads/synthetic-transfer.jpg','synthetic-transfer.jpg','image/jpeg',12,0),(2,1,NULL,4,'/uploads/synthetic-transfer.jpg','synthetic-transfer.jpg','image/jpeg',12,1)");
 const invalid=async sql=>{await c.query('SAVEPOINT invalid');let code;try{await c.query(sql);}catch(e){code=e.code}await c.query('ROLLBACK TO invalid');assert.equal(code,'23503');checks++};
 await invalid("INSERT INTO service_category_aliases VALUES(1,'cBad',2)");await invalid("INSERT INTO service_category_price_photos(salon_id,category_id,file_url,file_name,mime_type) VALUES(1,2,'/uploads/x.jpg','x.jpg','image/jpeg')");
 const db=require('../db');db.pool={connect:async()=>({release(){},query(sql,args){if(sql==='BEGIN')return c.query('SAVEPOINT operation');if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT operation');if(sql==='ROLLBACK')return c.query('ROLLBACK TO SAVEPOINT operation');return c.query(sql,args)}})};
 const transfer=require('../services/service-photo-transfer'),realpath=fs.realpathSync,stat=fs.statSync,root=path.resolve(__dirname,'../../frontend/uploads');
 fs.realpathSync=p=>p===root||p===path.join(root,'synthetic-transfer.jpg')?p:realpath(p);fs.statSync=p=>p===path.join(root,'synthetic-transfer.jpg')?{isFile:()=>true}:stat(p);
 try{
  const stale=await transfer.preview(1);assert.equal(stale.canApply,true);assert.equal(stale.newCategories.length,2);assert.equal(stale.photos.length,2);checks++;
  await c.query("UPDATE service_categories SET title='Changed' WHERE salon_id=1");await assert.rejects(transfer.apply(1,stale.runId),/изменились/);checks++;
  const p=await transfer.preview(1);await assert.rejects(transfer.apply(2,p.runId),/не найден/);checks++;
  await c.query('SAVEPOINT fail_apply');await c.query('ALTER TABLE service_category_price_photos ADD CONSTRAINT synthetic_failure CHECK(legacy_photo_id<>2)');
  await assert.rejects(transfer.apply(1,p.runId));assert.equal((await c.query('SELECT COUNT(*) n FROM service_category_price_photos')).rows[0].n,'0');assert.equal((await c.query('SELECT COUNT(*) n FROM service_categories WHERE salon_id=1')).rows[0].n,'1');checks++;
  await c.query('ROLLBACK TO fail_apply');const result=await transfer.apply(1,p.runId);assert.equal(result.photos,2);assert.equal(result.categories,2);checks++;
  const aliases=(await c.query('SELECT legacy_key,category_id FROM service_category_aliases WHERE salon_id=1')).rows;assert.equal(aliases.length,3);const nested=aliases.find(a=>a.legacy_key==='s4').category_id;assert.equal((await c.query('SELECT category_id FROM service_catalog WHERE salon_id=1')).rows[0].category_id,nested);checks++;
  assert.equal((await c.query('SELECT COUNT(*) n FROM agent_price_photos')).rows[0].n,'2');checks++;assert.equal((await transfer.apply(1,p.runId)).alreadyApplied,true);assert.equal((await transfer.preview(1)).alreadyApplied,true);checks++;
  await c.query('DELETE FROM service_category_price_photos WHERE salon_id=1 AND legacy_photo_id=1');assert.equal((await transfer.preview(1)).alreadyApplied,true);assert.equal((await c.query('SELECT COUNT(*) n FROM service_category_price_photos')).rows[0].n,'1');checks++;
 }finally{fs.realpathSync=realpath;fs.statSync=stat;}
 console.log(JSON.stringify({passed:checks,temporaryTablesOnly:true,rollback:true}));
 }finally{await c.query('ROLLBACK');c.release();}}
main().catch(e=>{console.error(JSON.stringify({failed:true,code:e.code||e.name}));process.exitCode=1}).finally(()=>pool.end());
