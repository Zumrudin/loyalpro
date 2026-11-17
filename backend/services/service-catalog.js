'use strict';
const {db,pool}=require('../db');
const yc=require('./journal/yclients');
const {parseAssignments,effectiveValues,legacyAssignment}=require('./service-assignment-values');
const {fail,positiveId}=require('./journal/model');
// Base fields and assignment rows must come from one PostgreSQL snapshot.
const assignmentProjection=`COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'service_id',a.service_id,'staff_member_id',a.staff_member_id,'price_min',a.price_min,
 'price_max',a.price_max,'duration',a.duration,'yclients_staff_id',m.yclients_staff_id,'is_active',m.is_active))
 FROM service_staff_assignments a JOIN staff_members m ON m.salon_id=a.salon_id AND m.id=a.staff_member_id
 WHERE a.salon_id=c.salon_id AND a.service_id=c.id),'[]'::jsonb) AS assignment_rows`;
const optionalId=v=>v==null||v===''?null:positiveId(v);
function title(v) { if(typeof v!=='string'||!v.trim()||v.trim().length>200) fail('Название — от 1 до 200 символов.');return v.trim(); }
function parseService(b={}) {
 if(!b||typeof b!=='object'||Array.isArray(b))fail('Проверьте параметры услуги.');
 if([b.duration,b.priceMin,b.priceMax].some(v=>typeof v==='boolean'||(v!==null&&typeof v==='object')))fail('Некорректные параметры услуги.');
 const duration=Number(b.duration), min=b.priceMin==null||b.priceMin===''?null:Number(b.priceMin),max=b.priceMax==null||b.priceMax===''?null:Number(b.priceMax);
 if(!Number.isInteger(duration)||duration<1||duration>1440) fail('Длительность — от 1 до 1440 минут.');
 if([min,max].some(v=>v!==null&&(!Number.isFinite(v)||v<0||v>1e9||Math.abs(v*100-Math.round(v*100))>1e-5))||(max!==null&&(min===null||max<min))) fail('Проверьте диапазон цен.');
 if(typeof b.active!=='boolean') fail('Укажите активность услуги.');
 return {title:title(b.title),categoryId:optionalId(b.categoryId),duration,priceMin:min,priceMax:max,active:b.active,economicsId:optionalId(b.economicsId)};
}
async function transaction(salonId,fn) {
 const c=await pool.connect();try {await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function list(salonId) {
 const [categories,services,staffMembers]=await Promise.all([
 db.any('SELECT id,parent_id,title,yclients_id,yclients_company_id FROM service_categories WHERE salon_id=$1 ORDER BY title,id',[salonId]),
 db.any(`SELECT c.*, ${assignmentProjection}, (c.yclients_company_id::text=s.yclients_company_id::text AND c.yclients_id IS NOT NULL) AS linked
 FROM service_catalog c JOIN salons s ON s.id=c.salon_id WHERE c.salon_id=$1 ORDER BY c.title,c.id`,[salonId]),
 db.any('SELECT id,yclients_staff_id,name,is_active FROM staff_members WHERE salon_id=$1 ORDER BY name,id',[salonId])]);
 return {categories,services:decorate(services,staffMembers,[]),staffMembers};
}
function checkParent(rows,id,parentId) {
 let current=parentId;const seen=new Set([id]);
 while(current) {if(seen.has(current)) fail('Категория не может быть вложена в себя или своего потомка.');seen.add(current);const row=rows.find(r=>Number(r.id)===current);if(!row) fail('Родительская категория не найдена.',404);current=row.parent_id==null?null:Number(row.parent_id);}
}
async function saveCategory(salonId,id,body={}) {
 const name=title(body.title),parentId=optionalId(body.parentId);
 return transaction(salonId,async c=>{
 const {rows}=await c.query('SELECT id,parent_id FROM service_categories WHERE salon_id=$1',[salonId]);
 if(id&&!rows.some(r=>Number(r.id)===id)) fail('Категория не найдена.',404);
 checkParent(rows,id,parentId);
 const result=id?await c.query('UPDATE service_categories SET title=$3,parent_id=$4 WHERE salon_id=$1 AND id=$2 RETURNING id',[salonId,id,name,parentId]):await c.query('INSERT INTO service_categories(salon_id,title,parent_id) VALUES($1,$2,$3) RETURNING id',[salonId,name,parentId]);return result.rows[0];
 });
}
function decorate(services,staffMembers,assignments) {
 return services.map(s=>{
  const legacy=Array.isArray(s.staff)?s.staff:[];
  const stored=s.assignment_rows??assignments;
  const rows=s.assignments_initialized
   ? stored.filter(a=>Number(a.service_id)===Number(s.id)).map(a=>({staffMemberId:Number(a.staff_member_id),priceMin:a.price_min==null?null:Number(a.price_min),priceMax:a.price_max==null?null:Number(a.price_max),duration:a.duration==null?null:Number(a.duration)}))
   : legacy.flatMap(raw=>{const member=staffMembers.find(m=>Number(m.yclients_staff_id)===Number(raw?.id||raw));return member?[legacyAssignment(raw,member)]:[];});
  const assignmentsUnresolved=!s.assignments_initialized&&rows.length!==legacy.length;
  const staff=s.assignments_initialized?rows.flatMap(a=>{
   const member=s.assignment_rows ? stored.find(m=>Number(m.staff_member_id)===a.staffMemberId) : staffMembers.find(m=>Number(m.id)===a.staffMemberId);
   if(!member?.is_active)return [];
   const v=effectiveValues(s,a);
   return [{id:Number(member.yclients_staff_id),seance_length:v.duration*60,price:{min:v.priceMin,max:v.priceMax}}];
  }):legacy;
  const {assignment_rows,...service}=s;
  return {...service,version:Number(s.version||0),assignments:rows,assignmentsUnresolved,staff};
 });
}
async function replaceAssignments(c,salonId,serviceId,input,{source='local'}={}) {
 const assignments=parseAssignments(input);
 const {rows:members}=await c.query('SELECT id,yclients_staff_id,is_active FROM staff_members WHERE salon_id=$1 AND id=ANY($2::int[]) FOR SHARE',[salonId,assignments.map(a=>a.staffMemberId)]);
 if(assignments.some(a=>!members.some(m=>Number(m.id)===a.staffMemberId&&m.is_active))) fail('Специалист не найден в салоне или неактивен.',409);
 // Preserve a compatible representation for old readers. Null means inherit.
 const staff=assignments.map(a=>({id:Number(members.find(m=>Number(m.id)===a.staffMemberId).yclients_staff_id),seance_length:a.duration==null?null:a.duration*60,price:{min:a.priceMin,max:a.priceMax}}));
 const result=await c.query('UPDATE service_catalog SET staff=$3,assignments_initialized=TRUE WHERE salon_id=$1 AND id=$2 RETURNING id',[salonId,serviceId,JSON.stringify(staff)]);
 if(!result.rows.length)fail('Услуга не найдена.',404);
 await c.query('DELETE FROM service_staff_assignments WHERE salon_id=$1 AND service_id=$2',[salonId,serviceId]);
 for(const a of assignments)await c.query(`INSERT INTO service_staff_assignments(salon_id,service_id,staff_member_id,price_min,price_max,duration,source) VALUES($1,$2,$3,$4,$5,$6,$7)`,[salonId,serviceId,a.staffMemberId,a.priceMin,a.priceMax,a.duration,source]);
}
async function saveService(salonId,id,body) {
 const v=parseService(body);
 const hasAssignments=Object.prototype.hasOwnProperty.call(body,'assignments');
 const assignments=hasAssignments?parseAssignments(body.assignments):null;
 if(body.version!==undefined&&(!Number.isSafeInteger(body.version)||body.version<0))fail('Некорректная версия услуги.');
 if(id&&hasAssignments&&body.version===undefined)fail('Обновите карточку услуги перед сохранением.',409);
 return transaction(salonId,async c=>{
 if(id){
  const {rows}=await c.query('SELECT id,version,staff,assignments_initialized FROM service_catalog WHERE salon_id=$1 AND id=$2 FOR UPDATE',[salonId,id]);
  if(!rows.length)fail('Услуга не найдена.',404);
  if(body.version!==undefined&&Number(rows[0].version)!==body.version)fail('Услуга изменена другим пользователем. Обновите карточку.',409);
  if(hasAssignments&&!rows[0].assignments_initialized&&Array.isArray(rows[0].staff)&&rows[0].staff.length){
   const {rows:members}=await c.query('SELECT yclients_staff_id FROM staff_members WHERE salon_id=$1',[salonId]);
   const unresolved=rows[0].staff.some(raw=>!members.some(m=>Number(m.yclients_staff_id)===Number(raw?.id||raw)));
   if(unresolved&&body.replaceUnresolvedAssignments!==true)fail('Есть несопоставленные назначения. Подтвердите их замену в карточке.',409);
  }
 }
 if(v.categoryId&&!(await c.query('SELECT id FROM service_categories WHERE salon_id=$1 AND id=$2',[salonId,v.categoryId])).rows.length) fail('Категория не найдена.',404);
 if(v.economicsId&&!(await c.query(`SELECT c.id FROM service_catalog c JOIN salons s ON s.id=c.salon_id WHERE c.salon_id=$1 AND c.yclients_id=$2 AND c.yclients_company_id::text=s.yclients_company_id::text`,[salonId,v.economicsId])).rows.length) fail('Услуга экономики не найдена в этом салоне.',404);
 const values=[salonId,v.title,v.categoryId,v.duration,v.priceMin,v.priceMax,v.active,v.economicsId];
 const q=id?`UPDATE service_catalog SET title=$2,category_id=$3,duration=$4,price_min=$5,price_max=$6,active=$7,economics_yc_id=$8,updated_at=NOW(),version=version+1 WHERE salon_id=$1 AND id=$9 RETURNING id,version`:`INSERT INTO service_catalog(salon_id,title,category_id,duration,price_min,price_max,active,economics_yc_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,version`;
 const result=await c.query(q,id?[...values,id]:values);if(!result.rows.length) fail('Услуга не найдена.',404);
 if(hasAssignments||!id)await replaceAssignments(c,salonId,Number(result.rows[0].id),assignments||[]);
 return result.rows[0];
 });
}
async function importYclients(salonId) {
 const salon=await db.oneOrNone('SELECT * FROM salons WHERE id=$1',[salonId]);
 if(!salon?.yclients_company_id) fail('YClients не подключён.',409);
 const cid=salon.yclients_company_id;
 const [categories,services]=await Promise.all([yc.list(salon,`/service_categories/${cid}`),yc.list(salon,`/company/${cid}/services/`)]);
 if(!services.length) fail('Каталог YClients пуст. Импорт не выполнен.',409);
 // Fetch and validate before starting a short, tenant-serialized transaction.
 const sourceCats=new Map(categories.map(c=>[positiveId(c.id),{title:title(c.title),parentId:optionalId(c.parent_id||null)}]));
 for(const s of services) if(s.category_id&&!sourceCats.has(Number(s.category_id))) sourceCats.set(positiveId(s.category_id),{title:`Категория ${Number(s.category_id)}`,parentId:null});
 const parsed=services.map(s=>({id:positiveId(s.id),title:title(s.title),categoryId:optionalId(s.category_id||null),duration:Math.max(0,Math.min(1440,Math.ceil(Number(s.duration||0)/60))),min:s.price_min==null?null:Number(s.price_min),max:s.price_max==null?null:Number(s.price_max),active:!s.deleted&&!s.is_deleted&&!s.archive,staff:Array.isArray(s.staff)?s.staff:[]}));
 return transaction(salonId,async c=>{
 let addedCategories=0,addedServices=0;const map=new Map(),newCats=new Set();
 for(const [id,cat] of sourceCats){const out=await c.query(`INSERT INTO service_categories(salon_id,title,yclients_id,yclients_company_id) VALUES($1,$2,$3,$4) ON CONFLICT(salon_id,yclients_company_id,yclients_id) DO NOTHING RETURNING id`,[salonId,cat.title,id,cid]);if(out.rows.length){addedCategories++;newCats.add(id);}}
 const existing=await c.query('SELECT id,yclients_id FROM service_categories WHERE salon_id=$1 AND yclients_company_id=$2',[salonId,cid]);for(const row of existing.rows)map.set(Number(row.yclients_id),Number(row.id));
 for(const id of newCats){const cat=sourceCats.get(id);if(cat.parentId){checkParent([...sourceCats].map(([id,v])=>({id,parent_id:v.parentId})),id,cat.parentId);await c.query('UPDATE service_categories SET parent_id=$3 WHERE salon_id=$1 AND id=$2',[salonId,map.get(id),map.get(cat.parentId)]);}}
 for(const s of parsed){const out=await c.query(`INSERT INTO service_catalog(salon_id,title,category_id,duration,price_min,price_max,active,yclients_id,yclients_company_id,economics_yc_id,staff) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10) ON CONFLICT(salon_id,yclients_company_id,yclients_id) DO NOTHING RETURNING id`,[salonId,s.title,map.get(s.categoryId)||null,s.duration,s.min,s.max===null||s.min===null?null:Math.max(s.min,s.max),s.active,s.id,cid,JSON.stringify(s.staff)]);addedServices+=out.rows.length;}
 return {addedCategories,addedServices};
 });
}
function journalService(s) {
 const staff=Array.isArray(s.staff)?s.staff.filter(x=>x!=null&&Number(x.id||x)>0):[];
 return {id:Number(s.id),yclientsId:Number(s.yclients_id),title:s.title,categoryId:s.category_id,duration:s.duration,priceMin:s.price_min==null?null:Number(s.price_min),priceMax:s.price_max==null?null:Number(s.price_max),staffIds:staff.map(x=>Number(x.id||x)),staffDetails:staff.map(x=>({id:Number(x.id||x),duration:Number(x.seance_length)/60||s.duration,priceMin:x.price?.min==null?(s.price_min==null?null:Number(s.price_min)):Number(x.price.min),priceMax:x.price?.min==null?(s.price_max==null?null:Number(s.price_max)):Math.max(Number(x.price.max??x.price.min),Number(x.price.min))}))};
}
async function forJournal(salonId) {const data=await list(salonId);return {categories:data.categories,services:data.services.filter(s=>s.active&&s.linked).map(journalService)};}
async function resolve(salon,ids) {
 const rows=await db.any(`SELECT c.*, ${assignmentProjection} FROM service_catalog c WHERE salon_id=$1 AND id=ANY($2::int[]) AND active AND yclients_company_id=$3 AND yclients_id IS NOT NULL`,[salon.id,ids,salon.yclients_company_id]);
 if(rows.length!==ids.length) fail('Услуга недоступна или не связана с YClients. Обновите журнал.',409);
 const members=await db.any('SELECT id,yclients_staff_id,name,is_active FROM staff_members WHERE salon_id=$1',[salon.id]);
 const decorated=decorate(rows,members,[]);
 return ids.map(id=>decorated.find(r=>Number(r.id)===id));
}
module.exports={transaction,replaceAssignments,parseAssignments,decorate,list,saveCategory,saveService,importYclients,forJournal,resolve,journalService,parseService,checkParent};
