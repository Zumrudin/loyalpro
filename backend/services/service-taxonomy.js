'use strict';
// Reviewed website taxonomy, applied without changing service identities, commercial
// values, visibility, staff or external accounting category keys.
const crypto = require('crypto');
const manifest = require('../catalog/peri-taxonomy-20261117.json');
const {pool} = require('../db');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function state(c,salonId) {
 const out={};
 for(const [key,table,order] of [
  ['categories','service_categories','id'],['services','service_catalog','id'],
  ['assignments','service_staff_assignments','service_id,staff_member_id'],
  ['photos','service_category_price_photos','id'],['aliases','service_category_aliases','legacy_key'],
  ['memberships','service_category_memberships','service_id,category_id']]) {
  out[key]=(await c.query(`SELECT * FROM ${table} WHERE salon_id=$1 ORDER BY ${order}`,[salonId])).rows;
 }
 return out;
}
function buildPlan(before,source=manifest) {
 const byId=new Map(before.categories.map(c=>[Number(c.id),c]));
 function path(c){const result=[],seen=new Set();while(c){if(seen.has(c.id))throw Error('Category cycle');seen.add(c.id);result.unshift(c.title);c=byId.get(Number(c.parent_id));}return result;}
 const categories=source.oldCategories.map(expected=>{
  const matches=before.categories.filter(c=>JSON.stringify(path(c))===JSON.stringify(expected.path));
  if(matches.length!==1)throw Error('Category mapping changed: '+expected.path.join(' / '));
  return {id:Number(matches[0].id),destination:expected.destination};
 });
 if(categories.length!==before.categories.length)throw Error('Unexpected categories; regenerate preview');
 const services=source.services.map(expected=>{
  const matches=before.services.filter(s=>String(s.yclients_id)===String(expected.yclientsId)&&s.title===expected.expectedTitle);
  if(matches.length!==1)throw Error('Service mapping changed: '+expected.expectedTitle);
  return {id:Number(matches[0].id),categories:expected.categories};
 });
 if(services.length!==before.services.length||new Set(services.map(s=>s.id)).size!==services.length)throw Error('Incomplete service mapping');
 const keys=new Set();for(const node of source.nodes){if(keys.has(node.key)||(node.parent&&!keys.has(node.parent)))throw Error('Invalid node hierarchy');keys.add(node.key);}
 for(const s of services)if(!s.categories.length||s.categories.some(k=>!keys.has(k)))throw Error('Invalid service destination');
 for(const c of categories)if(!keys.has(c.destination))throw Error('Invalid category destination');
 const photoCounts=new Map();for(const photo of before.photos){const cat=categories.find(c=>c.id===Number(photo.category_id));if(!cat)throw Error('Unmapped photo');photoCounts.set(cat.destination,(photoCounts.get(cat.destination)||0)+1);}
 if([...photoCounts.values()].some(n=>n>10))throw Error('Photo limit exceeded');
 return {sourceKey:source.sourceKey,manifestHash:hash(source),fingerprint:hash(before),nodes:source.nodes,categories,services};
}
function invariant(before,after){
 // PostgreSQL JSONB reorders object keys in the persisted recovery snapshot.
 const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const equal=(a,b)=>canonical(a)===canonical(b);
 const stable=s=>{const {category_id,accounting_category_id,version,updated_at,...rest}=s;return rest;};
 if(!equal(before.services.map(stable),after.services.map(stable))||!equal(before.assignments,after.assignments))throw Error('Service or assignment invariant failed');
 const photos=rows=>rows.map(({category_id,display_order,updated_at,...rest})=>rest);
 if(!equal(photos(before.photos),photos(after.photos)))throw Error('Photo invariant failed');
}
async function preview(salonId){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const prior=(await c.query('SELECT id FROM service_taxonomy_runs WHERE salon_id=$1 AND source_key=$2',[salonId,manifest.sourceKey])).rows[0];if(prior)return {alreadyApplied:true,id:prior.id};return buildPlan(await state(c,salonId));}finally{await c.query('ROLLBACK');c.release();}}
async function apply(salonId,expectedFingerprint){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);
  const prior=(await c.query('SELECT id FROM service_taxonomy_runs WHERE salon_id=$1 AND source_key=$2',[salonId,manifest.sourceKey])).rows[0];
  if(prior){await c.query('COMMIT');return {alreadyApplied:true,id:prior.id};}
  const before=await state(c,salonId),plan=buildPlan(before);
  if(!expectedFingerprint||plan.fingerprint!==expectedFingerprint)throw Error('Stale or missing preview');
  const ids=new Map();for(const node of plan.nodes){const r=await c.query('INSERT INTO service_categories(salon_id,title,parent_id,display_order) VALUES($1,$2,$3,$4) RETURNING id',[salonId,node.title,node.parent?ids.get(node.parent):null,node.order]);ids.set(node.key,Number(r.rows[0].id));}
  for(const s of plan.services){await c.query('UPDATE service_catalog SET accounting_category_id=COALESCE(accounting_category_id,category_id),category_id=$3,version=version+1,updated_at=NOW() WHERE salon_id=$1 AND id=$2',[salonId,s.id,ids.get(s.categories[0])]);for(const key of s.categories.slice(1))await c.query('INSERT INTO service_category_memberships(salon_id,service_id,category_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[salonId,s.id,ids.get(key)]);}
  for(const cat of plan.categories){const dest=ids.get(cat.destination);await c.query('UPDATE service_category_price_photos SET category_id=$3 WHERE salon_id=$1 AND category_id=$2',[salonId,cat.id,dest]);await c.query('UPDATE service_category_aliases SET category_id=$3 WHERE salon_id=$1 AND category_id=$2',[salonId,cat.id,dest]);await c.query('INSERT INTO service_category_aliases(salon_id,legacy_key,category_id) VALUES($1,$2,$3) ON CONFLICT(salon_id,legacy_key) DO UPDATE SET category_id=EXCLUDED.category_id',[salonId,'k'+cat.id,dest]);await c.query('UPDATE service_categories SET archived=TRUE WHERE salon_id=$1 AND id=$2',[salonId,cat.id]);}
  // Stable order after merging photo groups; files and photo identities stay intact.
  await c.query(`WITH ordered AS (SELECT id,row_number() OVER(PARTITION BY category_id ORDER BY display_order,id)-1 AS n FROM service_category_price_photos WHERE salon_id=$1) UPDATE service_category_price_photos p SET display_order=o.n FROM ordered o WHERE p.salon_id=$1 AND p.id=o.id`,[salonId]);
  const after=await state(c,salonId);invariant(before,after);
  const id=crypto.randomUUID();await c.query('INSERT INTO service_taxonomy_runs(id,salon_id,source_key,snapshot) VALUES($1,$2,$3,$4)',[id,salonId,manifest.sourceKey,JSON.stringify({before,plan,afterFingerprint:hash(after),nodeIds:Object.fromEntries(ids)})]);await c.query('COMMIT');
  return {id,categories:plan.nodes.length,services:plan.services.length,additionalMemberships:after.memberships.length,photos:after.photos.length};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={preview,apply,buildPlan,invariant,hash};
