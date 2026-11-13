'use strict';
const {db,pool}=require('../db');
const yc=require('./journal/yclients');
const {fail,positiveId}=require('./journal/model');
const optionalId=v=>v==null||v===''?null:positiveId(v);
function title(v) { if(typeof v!=='string'||!v.trim()||v.trim().length>200) fail('Название — от 1 до 200 символов.');return v.trim(); }
function parseService(b={}) {
 const duration=Number(b.duration), min=b.priceMin==null||b.priceMin===''?null:Number(b.priceMin),max=b.priceMax==null||b.priceMax===''?null:Number(b.priceMax);
 if(!Number.isInteger(duration)||duration<1||duration>1440) fail('Длительность — от 1 до 1440 минут.');
 if([min,max].some(v=>v!==null&&(!Number.isFinite(v)||v<0||v>1e9))||(max!==null&&(min===null||max<min))) fail('Проверьте диапазон цен.');
 if(typeof b.active!=='boolean') fail('Укажите активность услуги.');
 return {title:title(b.title),categoryId:optionalId(b.categoryId),duration,priceMin:min,priceMax:max,active:b.active,economicsId:optionalId(b.economicsId)};
}
async function transaction(salonId,fn) {
 const c=await pool.connect();try {await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function list(salonId) {
 const [categories,services]=await Promise.all([
 db.any('SELECT id,parent_id,title FROM service_categories WHERE salon_id=$1 ORDER BY title,id',[salonId]),
 db.any(`SELECT c.*, (c.yclients_company_id::text=s.yclients_company_id::text AND c.yclients_id IS NOT NULL) AS linked
 FROM service_catalog c JOIN salons s ON s.id=c.salon_id WHERE c.salon_id=$1 ORDER BY c.title,c.id`,[salonId])]);
 return {categories,services};
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
async function saveService(salonId,id,body) {
 const v=parseService(body);
 return transaction(salonId,async c=>{
 if(v.categoryId&&!(await c.query('SELECT id FROM service_categories WHERE salon_id=$1 AND id=$2',[salonId,v.categoryId])).rows.length) fail('Категория не найдена.',404);
 if(v.economicsId&&!(await c.query(`SELECT c.id FROM service_catalog c JOIN salons s ON s.id=c.salon_id WHERE c.salon_id=$1 AND c.yclients_id=$2 AND c.yclients_company_id::text=s.yclients_company_id::text`,[salonId,v.economicsId])).rows.length) fail('Услуга экономики не найдена в этом салоне.',404);
 const values=[salonId,v.title,v.categoryId,v.duration,v.priceMin,v.priceMax,v.active,v.economicsId];
 const q=id?`UPDATE service_catalog SET title=$2,category_id=$3,duration=$4,price_min=$5,price_max=$6,active=$7,economics_yc_id=$8,updated_at=NOW() WHERE salon_id=$1 AND id=$9 RETURNING id`:`INSERT INTO service_catalog(salon_id,title,category_id,duration,price_min,price_max,active,economics_yc_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`;
 const result=await c.query(q,id?[...values,id]:values);if(!result.rows.length) fail('Услуга не найдена.',404);return result.rows[0];
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
 const staff=Array.isArray(s.staff)?s.staff:[];
 return {id:Number(s.id),yclientsId:Number(s.yclients_id),title:s.title,categoryId:s.category_id,duration:s.duration,priceMin:s.price_min==null?null:Number(s.price_min),priceMax:s.price_max==null?null:Number(s.price_max),staffIds:staff.map(x=>Number(x.id||x)),staffDetails:staff.map(x=>({id:Number(x.id||x),duration:Number(x.seance_length)/60||s.duration,priceMin:Number(x.price?.min)||null,priceMax:Number(x.price?.max)||Number(x.price?.min)||null}))};
}
async function forJournal(salonId) {const data=await list(salonId);return {categories:data.categories,services:data.services.filter(s=>s.active&&s.linked).map(journalService)};}
async function resolve(salon,ids) {
 const rows=await db.any('SELECT * FROM service_catalog WHERE salon_id=$1 AND id=ANY($2::int[]) AND active AND yclients_company_id=$3 AND yclients_id IS NOT NULL',[salon.id,ids,salon.yclients_company_id]);
 if(rows.length!==ids.length) fail('Услуга недоступна или не связана с YClients. Обновите журнал.',409);
 return ids.map(id=>rows.find(r=>Number(r.id)===id));
}
module.exports={list,saveCategory,saveService,importYclients,forJournal,resolve,journalService,parseService,checkParent};
