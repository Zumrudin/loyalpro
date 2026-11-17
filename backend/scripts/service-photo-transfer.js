'use strict';
// Explicit operator CLI. inspect is read-only, preview stores a reviewable run.
const {pool}=require('../db');
const transfer=require('../services/service-photo-transfer');
function summary(p){return {runId:p.runId,alreadyApplied:!!p.alreadyApplied,canApply:p.canApply,
 sourcePhotos:p.before?.photos?.length||0,categories:p.newCategories?.length||0,
 photos:p.photos?.length||0,placements:p.placements?.length||0,exceptions:p.exceptions||[]};}
async function inspect(salonId){
 const c=await pool.connect();
 try{
  await c.query('BEGIN READ ONLY');
  const tables=['service_category_aliases','service_category_price_photos'];
  const missing=new Set();
  for(const name of tables){if(!(await c.query('SELECT to_regclass($1) AS name',[name])).rows[0].name)missing.add(name);}
  const reader={query(sql,args){
   if([...missing].some(name=>sql.includes('FROM '+name+' ')))return Promise.resolve({rows:[]});
   return c.query(sql.replace(/ FOR SHARE| FOR UPDATE/g,''),args);
  }};
  return transfer.buildSnapshot(await transfer.readState(reader,salonId));
 }finally{await c.query('ROLLBACK');c.release();}
}
async function main(){
 const args=process.argv.slice(2),get=k=>args.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=');
 const salonId=Number(get('salon')),database=get('confirm-database'),mode=args[0];
 if(!Number.isSafeInteger(salonId)||salonId<=0||!['inspect','preview','apply'].includes(mode)||!database)throw Error('usage');
 if((await pool.query('SELECT current_database() name')).rows[0].name!==database)throw Error('target');
 if(mode==='inspect'||mode==='preview')console.log(JSON.stringify(summary(await (mode==='inspect'?inspect(salonId):transfer.preview(salonId)))));
 else{const result=await transfer.apply(salonId,get('run'));require('../services/agent/price-list-data').invalidate(salonId);console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message==='target'?'Database mismatch':e.message==='usage'?'Usage: inspect|preview|apply --salon=ID --confirm-database=NAME [--run=UUID]':'Transfer rejected; inspect preview and retry',status:e.status||null}));process.exitCode=1}).finally(()=>pool.end());
