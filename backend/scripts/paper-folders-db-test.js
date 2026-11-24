#!/usr/bin/env node
'use strict';
// Fully isolated integration suite. Never loads db.js, config.js or environment DB URLs.
// Run: node backend/scripts/paper-folders-db-test.js [--filter=substring] [--service-source=/absolute/file.js] (PostgreSQL 15 binaries required).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { PAPER_FOLDERS_DDL } = require('../migrations');
const { applyOverlay } = require('../services/journal/overlay');
const period = require('../utils/period');
const BIN = '/usr/lib/postgresql/15/bin';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalpro-paper-folders-'));
const data = path.join(root, 'data');
const port = 56000 + Math.floor(Math.random() * 5000);
const asPostgres = (command, args) => process.getuid?.() === 0
  ? execFileSync('runuser', ['-u', 'postgres', '--', path.join(BIN, command), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  : execFileSync(path.join(BIN, command), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const filter = process.argv.find(arg=>arg.startsWith('--filter='))?.slice(9) || '';
const sourceFile = process.argv.find(arg=>arg.startsWith('--service-source='))?.slice(17) || path.join(__dirname,'../services/paper-folders.js');
let pool, started = false, passed = 0, failed = 0;
async function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  try { await reset(); await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
async function query(sql, args) { return pool.query(sql, args); }
async function one(sql, args) { return (await query(sql, args)).rows[0] || null; }
async function reset() {
  await query('TRUNCATE paper_folder_events,paper_folders,journal_outbox,records,clients,salons RESTART IDENTITY CASCADE');
  await query('INSERT INTO salons(id) VALUES(1),(2)');
}
async function client(salon = 1, options = {}) {
  return one(`INSERT INTO clients(salon_id,yclients_client_id,name,phone,visits_count)
    VALUES($1,$2,'Synthetic test client',$3,$4) RETURNING *`,
  [salon, options.yc ?? null, options.phone ?? null, options.visits ?? 0]);
}
let tomorrow, today, svc;
const time = (date = tomorrow, hhmm = '10:30') => `${date}T${hhmm}:00+03:00`;
async function record(c, options = {}) {
  const when = options.when || time();
  const r = await one(`INSERT INTO records(salon_id,client_id,yclients_record_id,visit_date,visit_datetime,status,raw_payload,yclients_client_id)
    VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'Europe/Moscow')::date,$4,$5,$6,$7) RETURNING *`,
  [c.salon_id,options.unlinked ? null : c.id,options.yc ?? c.id + 100000,when,options.status || 'confirmed',
    { attendance: options.attendance ?? 0, paid_full: options.paid ?? 0, client: { id: c.yclients_client_id,
      ...(options.isNew === undefined ? {} : {is_new:options.isNew}),
      ...(options.successVisits === undefined ? {} : {success_visits_count:options.successVisits}) }, datetime: when },c.yclients_client_id]);
  return r;
}
async function changeRecord(r, options) {
  await query('UPDATE records SET status=$2,raw_payload=raw_payload||$3::jsonb WHERE id=$1', [r.id, options.status || 'confirmed', options]);
}
async function folder(c) { return one('SELECT * FROM paper_folders WHERE salon_id=$1 AND client_id=$2',[c.salon_id,c.id]); }
async function events(c, action) { return Number((await one('SELECT count(*) n FROM paper_folder_events WHERE salon_id=$1 AND client_id=$2 AND action=$3',[c.salon_id,c.id,action])).n); }
async function archivedClient() {
  const c = await client(1,{yc:900001});
  await svc.update(c.salon_id,c.id,null,{number:7});
  await svc.update(c.salon_id,c.id,null,{archived:true});
  const r = await record(c);
  await svc.reconcile(c.salon_id,c.id);
  return { c, r };
}
async function main() {
  if (process.getuid?.() === 0) execFileSync('chown',['postgres:postgres',root]);
  asPostgres('initdb',['-D',data,'-A','trust','--no-locale','-E','UTF8']);
  asPostgres('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${root} -p ${port} -c listen_addresses='' -c max_connections=40`,'-w','start']);
  started = true;
  // Explicit Unix socket/user/database: PGHOST, PGPORT and DATABASE_URL cannot select a live server.
  pool = new Pool({host:root,port,user:process.getuid?.() === 0 ? 'postgres' : os.userInfo().username,database:'postgres',max:24});
  await query(`CREATE TABLE salons(id INTEGER PRIMARY KEY,is_active BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE clients(id SERIAL PRIMARY KEY,salon_id INTEGER NOT NULL REFERENCES salons(id),yclients_client_id BIGINT,
      name TEXT,phone TEXT,visits_count INTEGER NOT NULL DEFAULT 0,last_visit_at TIMESTAMPTZ);
    CREATE TABLE records(id BIGSERIAL PRIMARY KEY,salon_id INTEGER NOT NULL,client_id INTEGER,yclients_record_id BIGINT,yclients_client_id BIGINT,
      visit_date DATE,visit_datetime TIMESTAMPTZ,status TEXT,raw_payload JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE journal_outbox(id BIGSERIAL PRIMARY KEY,salon_id INTEGER NOT NULL,create_outbox_id BIGINT,
      yclients_record_id BIGINT,overlay JSONB,status TEXT NOT NULL DEFAULT 'queued',created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),released_at TIMESTAMPTZ);`);
  await query(PAPER_FOLDERS_DDL);
  await query(PAPER_FOLDERS_DDL);
  console.log('PASS additive DDL applied twice'); passed++;
  today = period.todayMsk(new Date());
  tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
  const db = {query,any:async (...args)=>(await query(...args)).rows,oneOrNone:one};
  const withTransaction = async fn => {
    const q = await pool.connect();
    try { await q.query('BEGIN'); const result = await fn(q); await q.query('COMMIT'); return result; }
    catch (e) { await q.query('ROLLBACK'); throw e; } finally { q.release(); }
  };
  const module = {exports:{}};
  const allowed = { '../db':{db,withTransaction}, './journal/overlay':{applyOverlay},
    '../utils/period':{...period,todayMsk:()=>today}, '../logger':{createLogger:()=>({warn:()=>{}})} };
  vm.runInNewContext(fs.readFileSync(sourceFile,'utf8'),{
    module,exports:module.exports,Date,require:id=>{assert.ok(Object.hasOwn(allowed,id),`Unexpected dependency ${id}`);return allowed[id];}
  },{filename:sourceFile});
  svc = module.exports;
  await test('backfill alphabet, attended only, reserves, tenants, dry run and repeat',async()=>{
    const {run,plan}=require('./paper-folders-backfill');
    const a=await client(1,{yc:80001}),b=await client(1,{yc:80002}),cancelled=await client(),future=await client(),foreign=await client(2);
    await query('UPDATE clients SET name=$2 WHERE id=$1',[a.id,'Я — синтетический']);
    await query('UPDATE clients SET name=$2 WHERE id=$1',[b.id,'А — синтетический']);
    const past=new Date(Date.now()-86400000).toISOString();
    await record(a,{when:past,status:'completed',attendance:1,paid:1});
    await record(b,{when:past,status:'arrived',attendance:1,unlinked:true});
    await record(cancelled,{when:past,status:'cancelled',attendance:-1});
    await record(future);await svc.reconcile(1,future.id);
    await svc.update(2,foreign.id,null,{number:1});
    const q=await pool.connect();
    try {
      const dry=await run(q,1);assert.equal(dry.eligible,2);assert.equal(dry.reservationsMoved,1);
      assert.equal((await svc.get(1,b.id)).number,null);
      const backup=path.join(root,'backfill-backup.json');
      await run(q,1,{write:true,backup});
      assert.equal((await svc.get(1,b.id)).number,1);assert.equal((await svc.get(1,a.id)).number,2);
      assert.equal((await svc.get(1,future.id)).number,3);assert.equal((await svc.get(2,foreign.id)).number,1);
      assert.equal((await svc.get(1,cancelled.id)).number,null);
      assert.equal((await folder(a)).committed,true);assert.equal((await folder(a)).prepared,false);
      assert.equal(fs.statSync(backup).mode & 0o777,0o600);
      const count=Number((await one('SELECT count(*) n FROM paper_folder_events')).n);
      assert.equal((await run(q,1,{write:true,backup})).changed,0);
      assert.equal(Number((await one('SELECT count(*) n FROM paper_folder_events')).n),count);
      assert.throws(()=>plan(Array.from({length:2001},(_,id)=>({id,name:'Synthetic'})),[]),/capacity/);
      assert.throws(()=>plan([], [{archived:true}]),/Archived/);
    }finally{q.release();}
  });
  await test('concurrent allocations cover 1..2000, exhaustion has no 2001, archive frees smallest slot',async()=>{
    await query(`INSERT INTO clients(salon_id,name) SELECT 1,'Synthetic capacity fixture' FROM generate_series(1,2001)`);
    const ids = (await query('SELECT id FROM clients ORDER BY id')).rows.map(r=>r.id);
    // bookingCreated requires a provider id; reconcile uses real persisted tomorrow appointments.
    await query(`INSERT INTO records(salon_id,client_id,yclients_record_id,visit_date,visit_datetime,status,raw_payload)
      SELECT 1,id,id,$1::date,$2::timestamptz,'confirmed','{"attendance":0,"paid_full":0}'::jsonb FROM clients`,[tomorrow,time()]);
    let index = 0;
    const allocations=await Promise.allSettled(Array.from({length:24},async()=>{ while(index<ids.length){const id=ids[index++];await svc.reconcile(1,id);} }));
    for(const allocation of allocations)if(allocation.status==='rejected')throw allocation.reason;
    const summary=await one('SELECT count(number)::int n,min(number) lo,max(number) hi,count(DISTINCT number)::int unique_n FROM paper_folders');
    assert.deepEqual(summary,{n:2000,lo:1,hi:2000,unique_n:2000});
    const full=await svc.day(1,tomorrow);assert.equal(full.free,0);assert.equal(full.items.filter(i=>i.number==null).length,1);
    const waiting=await one('SELECT client_id FROM paper_folders WHERE number IS NULL');
    await query('UPDATE clients SET visits_count=3 WHERE id=$1',[waiting.client_id]);
    await query("UPDATE paper_folders SET archived=TRUE,archived_at=NOW()-INTERVAL '1 day' WHERE client_id=$1",[waiting.client_id]);
    await query(`UPDATE records SET status='completed',raw_payload=raw_payload||'{"attendance":1,"paid_full":1}'::jsonb WHERE client_id=$1`,[waiting.client_id]);
    const completed=await svc.reconcile(1,waiting.client_id);
    assert.equal(completed.number,null);assert.equal(completed.archived,false);assert.equal(completed.prepared,false);
    const first=await one('SELECT client_id FROM paper_folders WHERE number=1');
    await query(`UPDATE records SET status='cancelled',raw_payload=raw_payload||'{"attendance":-1}'::jsonb WHERE client_id=$1`,[first.client_id]);
    await svc.update(1,first.client_id,null,{archived:true});
    await svc.sweep();
    assert.equal((await svc.get(1,waiting.client_id)).number,1);
    assert.equal((await svc.day(1,tomorrow)).free,0);
  });
  await test('tenant isolation in reads, writes, reconciliation, duplicate provider ids and day list',async()=>{
    const a=await client(1,{yc:500}), b=await client(2,{yc:500});await record(a);await record(b);
    assert.equal((await svc.bookingCreated(1,500,time())).number,1);
    assert.equal((await svc.bookingCreated(2,500,time())).number,1);
    assert.equal((await svc.get(2,a.id)).number,null);
    await assert.rejects(svc.update(2,a.id,null,{number:5}),{status:404});
    assert.equal(await svc.reconcile(2,a.id),null);
    assert.equal((await svc.day(1,tomorrow)).items.length,1);
    assert.equal((await svc.day(1,tomorrow)).items[0].clientId,a.id);
    await assert.rejects(query('INSERT INTO paper_folders(salon_id,client_id,number) VALUES(2,$1,8)',[a.id]),{code:'23503'});
  });
  await test('old paid history before cycle cannot remove archive, including one millisecond boundary',async()=>{
    const {c,r}=await archivedClient();
    await query('UPDATE paper_folders SET cycle_started_at=$2,archived_at=$3 WHERE client_id=$1',[c.id,`${today}T09:00:00.500Z`,`${today}T08:59:59.500Z`]);
    const f=await folder(c);
    const old=new Date(new Date(f.cycle_started_at).getTime()-1).toISOString();
    await record(c,{yc:999999,when:old,attendance:1,paid:1,status:'completed'});
    assert.equal((await svc.reconcile(1,c.id)).archived,true);
  });
  await test('confirmed and fully paid does not clear archive',async()=>{
    const {c,r}=await archivedClient();await changeRecord(r,{attendance:0,paid_full:1});
    assert.equal((await svc.reconcile(1,c.id)).archived,true);
  });
  await test('arrived and unpaid does not clear archive or release reservation',async()=>{
    const {c,r}=await archivedClient();await changeRecord(r,{attendance:1,paid_full:0,status:'arrived'});
    const f=await svc.reconcile(1,c.id);assert.equal(f.archived,true);assert.equal(f.number,1);
  });
  await test('arrived plus paid clears archive, duplicate delivery activates only once',async()=>{
    const {c,r}=await archivedClient();await changeRecord(r,{attendance:1,paid_full:1,status:'completed'});
    const f=await svc.reconcile(1,c.id);assert.equal(f.archived,false);assert.equal(f.prepared,false);assert.equal(f.number,1);
    const duplicates=await Promise.allSettled(Array.from({length:8},()=>svc.reconcile(1,c.id)));
    for(const duplicate of duplicates)if(duplicate.status==='rejected')throw duplicate.reason;
    assert.equal(await events(c,'reserved'),1);assert.equal(await events(c,'activated'),1);
  });
  await test('paid visit exactly at archive/cycle boundary activates',async()=>{
    const {c}=await archivedClient();
    const yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
    const boundary=`${yesterday}T09:00:00.500Z`;
    await query('UPDATE paper_folders SET cycle_started_at=$2,archived_at=$3 WHERE client_id=$1',
      [c.id,boundary,`${yesterday}T08:59:59.500Z`]);
    const paid=await record(c,{yc:999998,when:boundary,attendance:1,paid:1,status:'completed'});
    assert.equal((await svc.reconcile(1,c.id)).archived,false);
    assert.equal((await folder(c)).tracked_records.map(Number).includes(Number(paid.yclients_record_id)),false);
  });
  await test('cancelled unprepared reservation releases once, another client reuses it',async()=>{
    const c=await client(),r=await record(c);assert.equal((await svc.reconcile(1,c.id)).number,1);
    await changeRecord(r,{attendance:-1,status:'cancelled'});assert.equal((await svc.reconcile(1,c.id)).number,null);
    await svc.reconcile(1,c.id);assert.equal(await events(c,'released'),1);
    const next=await client();await record(next);assert.equal((await svc.reconcile(1,next.id)).number,1);
  });
  await test('cancelled prepared reservation retained until explicitly unprepared',async()=>{
    const c=await client(),r=await record(c);await svc.reconcile(1,c.id);await svc.update(1,c.id,null,{prepared:true});
    await changeRecord(r,{attendance:-1,status:'cancelled'});assert.equal((await svc.reconcile(1,c.id)).number,1);
    assert.equal((await svc.update(1,c.id,null,{prepared:false})).number,null);
  });
  await test('another live booking retains reservation when first is cancelled',async()=>{
    const c=await client(),r=await record(c);await record(c,{yc:987654,when:time(tomorrow,'15:30')});
    await svc.reconcile(1,c.id);await changeRecord(r,{attendance:-1,status:'cancelled'});
    assert.equal((await svc.reconcile(1,c.id)).number,1);assert.equal(await events(c,'released'),0);
    assert.equal((await svc.day(1,tomorrow)).items[0].visits,1);
  });
  await test('new-client outbox reserves then adopts same number without duplicate lease',async()=>{
    // Generated synthetic identity stays only in the disposable cluster; never logged.
    const syntheticPhone=String(70000000000+12345);
    const o=await one(`INSERT INTO journal_outbox(salon_id,overlay) VALUES(1,$1) RETURNING *`,[
      {kind:'create',date:tomorrow,time:'10:30',duration:30,client:{phone:syntheticPhone,name:'Synthetic new client'},services:[]}]);
    assert.equal((await svc.reconcileOutbox(1,o.id)).number,1);
    await svc.reconcileOutbox(1,o.id);
    assert.equal((await svc.day(1,tomorrow)).items[0].number,1);
    const c=await client(1,{phone:syntheticPhone,yc:7001});
    await record(c,{yc:4444});await query('UPDATE journal_outbox SET yclients_record_id=4444 WHERE id=$1',[o.id]);
    assert.equal((await svc.reconcile(1,c.id)).number,1);
    const summary=await one('SELECT count(*)::int n,count(number)::int occupied FROM paper_folders');
    assert.deepEqual(summary,{n:1,occupied:1});assert.equal(await events(c,'linked'),1);
    assert.equal((await svc.day(1,tomorrow)).items.length,1);
  });
  await test('provisional outbox cancelled before client exists releases only an unprepared lease',async()=>{
    for (const prepared of [false,true]) {
      const o=await one('INSERT INTO journal_outbox(salon_id,overlay) VALUES(1,$1) RETURNING *',[
        {kind:'create',date:tomorrow,time:'11:00',duration:30,client:{name:'Synthetic no-identity client'},services:[]}]);
      const reserved=await svc.reconcileOutbox(1,o.id);
      if(prepared)await svc.updateOutbox(1,o.id,null,{prepared:true});
      await query("UPDATE journal_outbox SET status='cancelled' WHERE id=$1",[o.id]);
      await svc.reconcileOutbox(1,o.id);
      const state=await one('SELECT number,prepared FROM paper_folders WHERE outbox_id=$1',[o.id]);
      assert.equal(state.number,prepared?reserved.number:null);assert.equal(state.prepared,prepared);
    }
  });
  await test('Moscow midnight appointments use Moscow day in reconciliation and list',async()=>{
    const c=await client();await record(c,{when:time(today,'00:30')});
    assert.equal((await svc.reconcile(1,c.id)).number,1);
    const list=await svc.day(1,today);assert.equal(list.items.length,1);assert.equal(list.items[0].time,'00:30');
    await assert.rejects(svc.update(1,c.id,null,{archived:true}),{status:409});
  });
  await test('optimistic arrival overlay cannot clear archive without persisted evidence',async()=>{
    const {c,r}=await archivedClient();
    await query('INSERT INTO journal_outbox(salon_id,yclients_record_id,overlay) VALUES(1,$1,$2)',
      [r.yclients_record_id,{kind:'patch',patch:{attendance:1}}]);
    await changeRecord(r,{attendance:0,paid_full:1});
    const f=await svc.reconcile(1,c.id);assert.equal(f.archived,true);assert.equal(f.number,1);
  });
  await test('confirmed create before mirror reserves and missing mirror does not release',async()=>{
    const c=await client(1,{yc:712345});
    assert.equal((await svc.bookingCreated(1,c.yclients_client_id,time())).number,1);
    assert.equal((await svc.reconcile(1,c.id)).number,1);
  });
  await test('returning unregistered client requires manual registration',async()=>{
    const c=await client(1,{visits:3});await record(c);
    assert.equal((await svc.reconcile(1,c.id)).number,null);
    const day=await svc.day(1,tomorrow);assert.equal(day.items[0].needsNumber,true);
    assert.equal((await svc.update(1,c.id,null,{number:250})).number,250);
  });
  await test('returning archived client booked thirty seconds after start activates only on persisted paid arrival',async()=>{
    const c=await client(1,{visits:3,yc:900002});
    await svc.update(1,c.id,null,{number:15});await svc.update(1,c.id,null,{archived:true});
    await query("UPDATE paper_folders SET archived_at=NOW()-INTERVAL '1 day' WHERE client_id=$1",[c.id]);
    const r=await record(c,{when:new Date(Date.now()-30000).toISOString()});
    let f=await svc.reconcile(1,c.id);assert.equal(f.number,1);assert.equal(f.archived,true);
    await changeRecord(r,{attendance:1,paid_full:1,status:'completed'});
    f=await svc.reconcile(1,c.id);assert.equal(f.number,1);assert.equal(f.archived,false);
  });
  await test('old completed history replay before archive never allocates a new number',async()=>{
    const c=await client(1,{visits:3,yc:900003});
    await svc.update(1,c.id,null,{number:15});await svc.update(1,c.id,null,{archived:true});
    await query('UPDATE paper_folders SET archived_at=$2 WHERE client_id=$1',[c.id,`${today}T09:00:00.500Z`]);
    await record(c,{when:`${today}T08:00:00.000Z`,attendance:1,paid:1,status:'completed'});
    const f=await svc.reconcile(1,c.id);assert.equal(f.number,null);assert.equal(f.archived,true);
  });
  await test('cancelling a booking whose start was thirty seconds ago frees unprepared lease',async()=>{
    const c=await client(1,{yc:900004}),r=await record(c,{when:new Date(Date.now()-30000).toISOString()});
    assert.equal((await svc.reconcile(1,c.id)).number,1);
    await changeRecord(r,{attendance:-1,status:'cancelled'});
    assert.equal((await svc.reconcile(1,c.id)).number,null);
  });
  await test('prepared provisional adoption preserves prepared and archive on an existing client row',async()=>{
    const c=await client(1,{visits:3,yc:900005});
    await svc.update(1,c.id,null,{number:15});await svc.update(1,c.id,null,{archived:true});
    const identity=String(70000000000+67890);
    const o=await one('INSERT INTO journal_outbox(salon_id,overlay) VALUES(1,$1) RETURNING *',[
      {kind:'create',date:tomorrow,time:'12:00',duration:30,client:{phone:identity,name:'Synthetic prepared adoption'},services:[]}]);
    const draft=await svc.reconcileOutbox(1,o.id);await svc.updateOutbox(1,o.id,null,{prepared:true});
    await query('UPDATE clients SET phone=$2 WHERE id=$1',[c.id,identity]);
    const adopted=await svc.reconcile(1,c.id);
    assert.equal(adopted.number,draft.number);assert.equal(adopted.prepared,true);assert.equal(adopted.archived,true);
    assert.equal(Number((await one('SELECT count(number) n FROM paper_folders WHERE salon_id=1')).n),1);
  });
  await test('same-phone provisional bookings share one number, retain until last booking cancelled',async()=>{
    const identity=String(70000000000+24680),drafts=[];
    for(const hhmm of ['10:00','14:00'])drafts.push(await one('INSERT INTO journal_outbox(salon_id,overlay) VALUES(1,$1) RETURNING *',[
      {kind:'create',date:tomorrow,time:hhmm,duration:30,client:{phone:identity,name:'Synthetic shared folder'},services:[]}]));
    const first=await svc.reconcileOutbox(1,drafts[0].id),second=await svc.reconcileOutbox(1,drafts[1].id);
    assert.equal(first.number,1);assert.equal(second.number,first.number);
    assert.equal(Number((await one('SELECT count(number) n FROM paper_folders')).n),1);
    let day=await svc.day(1,tomorrow);assert.equal(day.items.length,1);assert.equal(day.items[0].visits,2);
    await query("UPDATE journal_outbox SET status='cancelled' WHERE id=$1",[drafts[0].id]);
    await svc.reconcileOutbox(1,drafts[0].id);
    day=await svc.day(1,tomorrow);assert.equal(day.items.length,1);assert.equal(day.items[0].number,1);
    await query("UPDATE journal_outbox SET status='cancelled' WHERE id=$1",[drafts[1].id]);
    await svc.reconcileOutbox(1,drafts[1].id);
    assert.equal(Number((await one('SELECT count(number) n FROM paper_folders')).n),0);
  });
  await test('local move overlay brings stored appointment into target day and removes old day',async()=>{
    const c=await client(1,{yc:900006});
    const afterTomorrow=new Date(Date.parse(`${tomorrow}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    const r=await record(c,{when:time(afterTomorrow)});
    await query('INSERT INTO journal_outbox(salon_id,yclients_record_id,overlay) VALUES(1,$1,$2)',
      [r.yclients_record_id,{kind:'patch',patch:{datetime:time(tomorrow,'16:15')}}]);
    await svc.reconcile(1,c.id);
    const day=await svc.day(1,tomorrow);assert.equal(day.items.length,1);assert.equal(day.items[0].number,1);assert.equal(day.items[0].time,'16:15');
    assert.equal((await svc.day(1,afterTomorrow)).items.length,0);
  });
  await test('cancelling existing primary client local create releases reservation without mirror',async()=>{
    const identity=String(70000000000+13579),c=await client(1,{phone:identity,yc:900007});
    const o=await one('INSERT INTO journal_outbox(salon_id,overlay) VALUES(1,$1) RETURNING *',[
      {kind:'create',date:tomorrow,time:'13:00',duration:30,client:{phone:identity,name:'Synthetic existing primary'},services:[]}]);
    assert.equal((await svc.reconcileOutbox(1,o.id)).number,1);
    await query("UPDATE journal_outbox SET status='cancelled' WHERE id=$1",[o.id]);
    await svc.reconcileOutbox(1,o.id);
    assert.equal((await svc.get(1,c.id)).number,null);assert.equal(await events(c,'released'),1);
  });
  await test('provider primary regression: linked is_new true overrides future booking count one',async()=>{
    const c=await client(1,{visits:1,yc:910001});
    await record(c,{isNew:true,successVisits:1});
    assert.equal((await svc.reconcile(1,c.id)).number,1);
  });
  await test('provider primary regression: day and sweep include linked and unlinked provider clients',async()=>{
    const linked=await client(1,{visits:1,yc:910002}),unlinked=await client(1,{visits:1,yc:910003});
    await record(linked,{isNew:true,successVisits:1});
    await record(unlinked,{unlinked:true,isNew:true,successVisits:1});
    const before=await svc.day(1,tomorrow);assert.equal(before.items.length,2);
    assert.deepEqual(Array.from(before.items,item=>item.clientId).sort((a,b)=>a-b),[linked.id,unlinked.id]);
    await svc.sweep();
    const after=await svc.day(1,tomorrow);assert.equal(after.items.length,2);
    assert.deepEqual(Array.from(after.items,item=>item.number).sort((a,b)=>a-b),[1,2]);
  });
  await test('provider primary regression: record hook resolves missing local client by same salon provider id',async()=>{
    const c=await client(1,{visits:1,yc:910004});
    const r=await record(c,{unlinked:true,isNew:true,successVisits:1});
    assert.equal((await svc.reconcileRecord(1,r.id))?.number,1);
    assert.equal((await svc.get(1,c.id)).number,1);
  });
  await test('provider primary regression: same provider id in another tenant cannot link orphan record',async()=>{
    const foreign=await client(2,{visits:1,yc:910005});
    const r=await record(foreign,{unlinked:true,isNew:true,successVisits:1});
    await query('UPDATE records SET salon_id=1 WHERE id=$1',[r.id]);
    assert.equal(await svc.reconcileRecord(1,r.id),null);
    await svc.sweep();assert.equal((await svc.get(2,foreign.id)).number,null);
    assert.equal(Number((await one('SELECT count(*) n FROM paper_folders')).n),0);
    const day=await svc.day(1,tomorrow);assert.equal(day.items.some(item=>item.clientId===foreign.id),false);
  });
  await test('provider primary regression: known past attendance overrides future is_new true',async()=>{
    const c=await client(1,{visits:1,yc:910006});
    const yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
    await record(c,{yc:9910006,unlinked:true,when:time(yesterday,'11:30'),status:'arrived',attendance:1,isNew:false});
    await record(c,{isNew:true,successVisits:1});
    assert.equal((await svc.reconcile(1,c.id)).number,null);
  });
  await test('task labels reflect committed and prepared folders without mutating allocation flags',async()=>{
    const cases=[
      {number:41,archived:false,prepared:false,committed:true,task:'Подготовить папку к приёму'},
      {number:42,archived:false,prepared:false,committed:false,task:'Создать бумажный пакет'},
      {number:43,archived:true,prepared:false,committed:false,task:'Подготовить новый договор'},
      {number:44,archived:true,prepared:true,committed:false,task:'Подготовить папку к приёму'},
      {number:null,archived:false,prepared:false,committed:false,task:'Папка не зарегистрирована — проверить'},
      {number:null,archived:true,prepared:false,committed:false,cycle:true,task:'Нет свободного номера папки'},
    ];
    for(const [index,entry] of cases.entries()){
      const c=await client(1,{visits:entry.committed?3:0,yc:920000+index});entry.clientId=c.id;
      await record(c);
      if(entry.number!==null || entry.cycle)await query(`INSERT INTO paper_folders
        (salon_id,client_id,number,archived,prepared,committed,cycle_started_at)
        VALUES(1,$1,$2,$3,$4,$5,$6)`,[c.id,entry.number,entry.archived,entry.prepared,entry.committed,entry.cycle?time(today):null]);
    }
    const before=(await query('SELECT * FROM paper_folders ORDER BY id')).rows;
    const day=await svc.day(1,tomorrow);assert.equal(day.items.length,cases.length);
    for(const entry of cases){
      const item=day.items.find(row=>row.clientId===entry.clientId);assert.ok(item);
      assert.equal(item.task,entry.task,`number=${entry.number} archived=${entry.archived} prepared=${entry.prepared} committed=${entry.committed}`);
      assert.equal(item.number,entry.number);assert.equal(item.archived,entry.archived);assert.equal(item.prepared,entry.prepared);
      assert.equal(item.needsNumber,entry.number===null);
    }
    assert.deepEqual((await query('SELECT * FROM paper_folders ORDER BY id')).rows,before);
    assert.equal(Number((await one('SELECT count(*) n FROM paper_folder_events')).n),0);
  });
  await test('manual 2000 accepted, same-tenant collision rejected, other tenant independent',async()=>{
    const a=await client(),b=await client(),other=await client(2);
    assert.equal((await svc.update(1,a.id,null,{number:2000})).number,2000);
    await assert.rejects(svc.update(1,b.id,null,{number:2000}),{status:409});
    assert.equal((await svc.update(2,other.id,null,{number:2000})).number,2000);
    for(const number of [0,2001,1.5,'1'])await assert.rejects(svc.update(1,b.id,null,{number}),{status:400});
    await assert.rejects(svc.update(1,a.id,null,{archived:false}),{status:409});
    await assert.rejects(svc.update(1,a.id,null,{prepared:false}),{status:409});
  });
  console.log(`Paper folders isolated PostgreSQL: ${passed} passed, ${failed} failed`);
  process.exitCode=failed?1:0;
}
main().catch(e=>{ console.error(`Isolated PostgreSQL setup failed: ${e.message}`);process.exitCode=1; }).finally(async()=>{
  if(pool)await pool.end();
  if(started)asPostgres('pg_ctl',['-D',data,'-m','fast','-w','stop']);
  // Leave the private fixture directory for investigation; it contains synthetic data only.
});
