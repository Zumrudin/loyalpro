'use strict';
// Explicit one-off operation. No startup migration or external integration calls.
const fs = require('node:fs');
const path = require('node:path');
const eligibleSql = `SELECT c.id,c.name FROM clients c WHERE c.salon_id=$1 AND EXISTS (
 SELECT 1 FROM records r WHERE r.salon_id=c.salon_id
 AND (r.client_id=c.id OR (r.client_id IS NULL AND r.yclients_client_id=c.yclients_client_id))
 AND r.status IN ('arrived','completed') AND r.visit_datetime<=NOW()
 AND COALESCE(r.raw_payload->>'deleted','false') NOT IN ('true','1'))`;
function plan(clients, folders) {
 const collator = new Intl.Collator('ru', {sensitivity:'base',numeric:false});
 const ordered = [...clients].sort((a,b)=>collator.compare((a.name||'').trim(),(b.name||'').trim()) || a.id-b.id);
 if(ordered.some(c=>!String(c.name||'').trim())) throw new Error('Eligible clients without names require review');
 if(folders.some(f=>f.archived)) throw new Error('Archived folders require review');
 const ids=new Set(ordered.map(c=>Number(c.id)));
 const other=folders.filter(f=>f.number!=null && !ids.has(Number(f.client_id)));
 if(ordered.length+other.length>2000) throw new Error('Cabinet capacity exceeded');
 const used=new Set(ordered.map((_,i)=>i+1));
 const assignments=ordered.map((c,i)=>({clientId:c.id,folderId:folders.find(f=>Number(f.client_id)===Number(c.id))?.id,number:i+1,committed:true}));
 for(const f of other.filter(f=>f.number>ordered.length)) {used.add(f.number);assignments.push({clientId:f.client_id,folderId:f.id,number:f.number,committed:f.committed});}
 for(const f of other.filter(f=>f.number<=ordered.length).sort((a,b)=>a.number-b.number)) {
  let n=ordered.length+1;while(used.has(n))n++;used.add(n);
  assignments.push({clientId:f.client_id,folderId:f.id,number:n,committed:f.committed});
 }
 return assignments;
}
async function run(q,salonId,{write=false,backup}={}) {
 await q.query(write?'BEGIN':'BEGIN READ ONLY');
 try {
  await q.query("SET LOCAL lock_timeout='5s'");await q.query("SET LOCAL statement_timeout='30s'");
  if(write)await q.query('SELECT pg_advisory_xact_lock(714032,$1::integer)',[salonId]);
  const clients=(await q.query(eligibleSql,[salonId])).rows;
  const folders=(await q.query('SELECT * FROM paper_folders WHERE salon_id=$1 ORDER BY id',[salonId])).rows;
  const assignments=plan(clients,folders);
  const changed=assignments.filter(a=>{const f=folders.find(f=>String(f.id)===String(a.folderId));return !f||f.number!==a.number||f.committed!==a.committed;});
  const result={eligible:clients.length,occupiedBefore:folders.filter(f=>f.number!=null).length,occupiedAfter:assignments.length,changed:changed.length,reservationsMoved:changed.filter(a=>!a.committed).length};
  if(write && changed.length) {
   if(!backup)throw new Error('Private backup path required');
   fs.writeFileSync(backup,JSON.stringify({salonId,at:new Date().toISOString(),folders,assignments}),{mode:0o600,flag:'wx'});
   const file=fs.openSync(backup,'r');try{fs.fsyncSync(file);}finally{fs.closeSync(file);}
   // Clear changed numbers together so swaps cannot violate tenant uniqueness.
   const moved=changed.filter(a=>a.folderId && folders.find(f=>String(f.id)===String(a.folderId))?.number!=null);
   for(const a of moved)await q.query(`INSERT INTO paper_folder_events(salon_id,folder_id,client_id,number,action)
    SELECT salon_id,id,client_id,number,'released' FROM paper_folders WHERE salon_id=$1 AND id=$2`,[salonId,a.folderId]);
   await q.query('UPDATE paper_folders SET number=NULL WHERE salon_id=$1 AND id=ANY($2::bigint[])',[salonId,changed.map(a=>a.folderId).filter(Boolean)]);
   for(const a of changed) {
    const f=a.folderId
     ? (await q.query('UPDATE paper_folders SET number=$3,committed=$4,updated_at=NOW() WHERE salon_id=$1 AND id=$2 RETURNING id',[salonId,a.folderId,a.number,a.committed])).rows[0]
     : (await q.query('INSERT INTO paper_folders(salon_id,client_id,number,committed) VALUES($1,$2,$3,$4) RETURNING id',[salonId,a.clientId,a.number,a.committed])).rows[0];
    await q.query('INSERT INTO paper_folder_events(salon_id,folder_id,client_id,number,action) VALUES($1,$2,$3,$4,$5)',[salonId,f.id,a.clientId,a.number,a.committed?'registered':'reserved']);
   }
   const actual=(await q.query('SELECT * FROM paper_folders WHERE salon_id=$1',[salonId])).rows;
   for(const a of assignments)if(!actual.some(f=>(a.folderId?String(f.id)===String(a.folderId):Number(f.client_id)===Number(a.clientId)) && f.number===a.number && f.committed===a.committed))throw new Error('Verification failed');
  }
  await q.query(write?'COMMIT':'ROLLBACK');return result;
 }catch(e){await q.query('ROLLBACK');throw e;}
}
async function main() {
 const args=process.argv.slice(2);const options={};
 for(const a of args){const m=a.match(/^--(salon|database|backup|backend)=(.+)$/);if(m)options[m[1]]=m[2];else if(a==='--write')options.write=true;else throw new Error('Unknown argument');}
 if(!/^[1-9]\d*$/.test(options.salon||'')||!options.database)throw new Error('Explicit --salon and --database required');
 const base=path.resolve(options.backend||path.join(__dirname,'..'));
 require(path.join(base,'node_modules/dotenv')).config({path:path.join(base,'.env'),quiet:true});
 const {Pool}=require(path.join(base,'node_modules/pg'));
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
 let q;try{q=await pool.connect();const actual=(await q.query('SELECT current_database() db')).rows[0].db;if(actual!==options.database)throw new Error('Unexpected database');
 console.log(JSON.stringify(await run(q,Number(options.salon),{write:!!options.write,backup:options.backup})));}
 finally{if(q)q.release();await pool.end();}
}
module.exports={plan,run,eligibleSql};
if(require.main===module)main().catch(e=>{console.error('Folder backfill failed: '+(e.code||e.message));process.exitCode=1;});
