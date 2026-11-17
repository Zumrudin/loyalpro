'use strict';
// One-time explicit transfer. Keeps legacy rows/files for rollback; never startup backfill.
const {createHash,randomUUID}=require('crypto');
const fs=require('fs'),path=require('path');
const {transaction}=require('./service-catalog');
const {fail,positiveId}=require('./journal/model');
const uploadRoot=path.resolve(__dirname,'../../frontend/uploads');
const fingerprint=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function filePresent(url){
 if(typeof url!=='string'||!/^\/uploads\/[^/\\]+$/.test(url)||['.','..'].includes(path.basename(url)))return false;
 try{const p=fs.realpathSync(path.join(uploadRoot,path.basename(url))),root=fs.realpathSync(uploadRoot);return p.startsWith(root+path.sep)&&fs.statSync(p).isFile();}catch(_){return false;}
}
async function readState(c,salonId){
 const query=async sql=>(await c.query(sql,[salonId])).rows;
 const salon=(await query('SELECT id,yclients_company_id FROM salons WHERE id=$1 FOR SHARE'))[0];
 if(!salon)fail('Салон не найден.',404);
 return {companyId:String(salon.yclients_company_id||''),
 categories:await query('SELECT id,title,parent_id,yclients_id,yclients_company_id FROM service_categories WHERE salon_id=$1 ORDER BY id FOR UPDATE'),
 subcats:await query('SELECT id,title,parent_id,yc_category_id,display_order FROM agent_service_subcategories WHERE salon_id=$1 ORDER BY id FOR SHARE'),
 photos:await query('SELECT id,yc_category_id,subcategory_id,file_url,file_name,mime_type,byte_size,display_order FROM agent_price_photos WHERE salon_id=$1 ORDER BY id FOR SHARE'),
 placements:await query('SELECT yc_service_id,subcategory_id FROM agent_service_placements WHERE salon_id=$1 ORDER BY yc_service_id FOR SHARE'),
 services:await query('SELECT id,yclients_id,yclients_company_id,category_id,version FROM service_catalog WHERE salon_id=$1 ORDER BY id FOR UPDATE'),
 aliases:await query('SELECT legacy_key,category_id FROM service_category_aliases WHERE salon_id=$1 ORDER BY legacy_key'),
 targetPhotos:await query('SELECT id,category_id,legacy_photo_id,file_url,display_order FROM service_category_price_photos WHERE salon_id=$1 ORDER BY id')};
}
function buildSnapshot(state,exists=filePresent){
 const exceptions=[],aliases=[],newCategories=[],photos=[],placements=[];
 const mapping=new Map(state.aliases.map(a=>[a.legacy_key,Number(a.category_id)]));
 for(const c of state.categories){if(c.yclients_id&&String(c.yclients_company_id)===state.companyId){const key='c'+c.yclients_id;if(mapping.has(key)&&mapping.get(key)!==Number(c.id))exceptions.push({code:'alias_conflict',key});else{mapping.set(key,Number(c.id));aliases.push({key,categoryId:Number(c.id)});}}}
 const pending=new Map(state.subcats.map(s=>[Number(s.id),s]));
 for(let iteration=0;pending.size&&iteration<=state.subcats.length;iteration++){
  let progress=false;
  for(const [id,s] of pending){const key='s'+id,parentKey=s.parent_id?'s'+s.parent_id:'c'+s.yc_category_id;
   if(!mapping.has(parentKey))continue;
   if(!String(s.title||'').trim()||String(s.title).length>200){exceptions.push({code:'invalid_title',key});pending.delete(id);progress=true;continue;}
   if(!mapping.has(key)){mapping.set(key,key);newCategories.push({key,title:s.title,parentKey});}
   pending.delete(id);progress=true;
  }
  if(!progress)break;
 }
 for(const [id]of pending)exceptions.push({code:'missing_parent_or_cycle',key:'s'+id});
 const counts=new Map();
 for(const p of state.targetPhotos){const k=String(p.category_id);counts.set(k,(counts.get(k)||0)+1);}
 for(const p of state.photos){const key=p.subcategory_id?'s'+p.subcategory_id:'c'+p.yc_category_id;
  if(!mapping.has(key)){exceptions.push({code:'unmatched_photo',photoId:p.id,key});continue;}
  if(!exists(p.file_url)){exceptions.push({code:'missing_file',photoId:p.id});continue;}
  const previous=state.targetPhotos.find(t=>Number(t.legacy_photo_id)===Number(p.id));
  if(previous){if(previous.file_url!==p.file_url||String(previous.category_id)!==String(mapping.get(key)))exceptions.push({code:'photo_conflict',photoId:p.id});continue;}
  const node=String(mapping.get(key)),count=(counts.get(node)||0)+1;counts.set(node,count);
  if(count>10)exceptions.push({code:'photo_limit',key});
  photos.push({...p,key});
 }
 for(const p of state.placements){const key='s'+p.subcategory_id;const service=state.services.find(s=>String(s.yclients_id)===String(p.yc_service_id)&&String(s.yclients_company_id)===state.companyId);
  if(!service||!mapping.has(key)){exceptions.push({code:'unmatched_placement',serviceId:p.yc_service_id});continue;}
  placements.push({serviceId:Number(service.id),key});
 }
 return {schemaVersion:1,capturedAt:new Date().toISOString(),fingerprint:fingerprint(state),before:state,aliases,newCategories,photos,placements,exceptions,canApply:!exceptions.length};
}
async function preview(salonId){positiveId(salonId);return transaction(salonId,async c=>{
 const done=(await c.query("SELECT id FROM service_photo_transfer_runs WHERE salon_id=$1 AND status='applied'",[salonId])).rows[0];
 if(done)return {runId:done.id,alreadyApplied:true,canApply:false};
 const snapshot=buildSnapshot(await readState(c,salonId)),runId=randomUUID();
 await c.query('INSERT INTO service_photo_transfer_runs(id,salon_id,snapshot) VALUES($1,$2,$3)',[runId,salonId,JSON.stringify(snapshot)]);
 return {runId,...snapshot};});}
async function apply(salonId,runId){positiveId(salonId);if(typeof runId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId))fail('Некорректный ID переноса.');
 return transaction(salonId,async c=>{
 const run=(await c.query('SELECT * FROM service_photo_transfer_runs WHERE salon_id=$1 AND id=$2 FOR UPDATE',[salonId,runId])).rows[0];if(!run)fail('Перенос не найден.',404);
 if(run.status==='applied')return {alreadyApplied:true,photos:0,categories:0};
 if((await c.query("SELECT id FROM service_photo_transfer_runs WHERE salon_id=$1 AND status='applied'",[salonId])).rows.length)fail('Перенос уже выполнен.',409);
 const s=run.snapshot,age=Date.now()-Date.parse(s.capturedAt);
 if(s.schemaVersion!==1||!s.canApply||!Number.isFinite(age)||age<0||age>1800000)fail('Перенос устарел или содержит исключения.',409);
 if(fingerprint(await readState(c,salonId))!==s.fingerprint)fail('Настройки изменились. Повторите сверку.',409);
 if(s.photos.some(p=>!filePresent(p.file_url)))fail('Файл прайса недоступен. Повторите сверку.',409);
 const map=new Map(s.before.aliases.map(a=>[a.legacy_key,Number(a.category_id)]));
 for(const a of s.aliases){map.set(a.key,a.categoryId);await c.query('INSERT INTO service_category_aliases(salon_id,legacy_key,category_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[salonId,a.key,a.categoryId]);}
 for(const cat of s.newCategories){const row=(await c.query('INSERT INTO service_categories(salon_id,title,parent_id) VALUES($1,$2,$3) RETURNING id',[salonId,cat.title,map.get(cat.parentKey)])).rows[0];map.set(cat.key,Number(row.id));await c.query('INSERT INTO service_category_aliases(salon_id,legacy_key,category_id) VALUES($1,$2,$3)',[salonId,cat.key,row.id]);}
 for(const p of s.photos)await c.query(`INSERT INTO service_category_price_photos(salon_id,category_id,file_url,file_name,mime_type,byte_size,display_order,legacy_photo_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[salonId,map.get(p.key),p.file_url,p.file_name,p.mime_type,p.byte_size,p.display_order,p.id]);
 for(const p of s.placements)await c.query('UPDATE service_catalog SET category_id=$3,version=version+1,updated_at=NOW() WHERE salon_id=$1 AND id=$2',[salonId,p.serviceId,map.get(p.key)]);
 await c.query("UPDATE service_photo_transfer_runs SET status='applied',applied_at=NOW() WHERE salon_id=$1 AND id=$2",[salonId,runId]);
 return {alreadyApplied:false,photos:s.photos.length,categories:s.newCategories.length,placements:s.placements.length};});}
module.exports={buildSnapshot,preview,apply,readState,filePresent};
