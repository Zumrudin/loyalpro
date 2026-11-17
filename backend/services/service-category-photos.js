'use strict';

const {db,pool}=require('../db');
const {fail,positiveId}=require('./journal/model');

const MAX_PHOTOS_PER_CATEGORY=10;

function dto(row){return {id:Number(row.id),categoryId:Number(row.category_id),fileUrl:row.file_url,fileName:row.file_name,displayOrder:Number(row.display_order)};}

async function categoryChain(executor,salonId,categoryId){
 const out=await executor.query(`WITH RECURSIVE chain AS (
  SELECT id,parent_id,title,0 AS depth FROM service_categories WHERE salon_id=$1 AND id=$2
  UNION ALL SELECT p.id,p.parent_id,p.title,c.depth+1 FROM service_categories p
  JOIN chain c ON c.parent_id=p.id WHERE p.salon_id=$1 AND c.depth<100
 ) SELECT id,parent_id,title,depth FROM chain ORDER BY depth`,[salonId,categoryId]);
 if(!out.rows.length)fail('Категория не найдена.',404);
 return out.rows;
}

async function list(salonId,rawCategoryId){
 const categoryId=positiveId(rawCategoryId),chain=await categoryChain(db,salonId,categoryId);
 const rows=await db.any(`SELECT id,category_id,file_url,file_name,display_order
  FROM service_category_price_photos WHERE salon_id=$1 AND category_id=ANY($2::int[])
  ORDER BY display_order,id`,[salonId,chain.map(x=>Number(x.id))]);
 const own=rows.filter(x=>Number(x.category_id)===categoryId);
 const inheritedNode=own.length?null:chain.slice(1).find(c=>rows.some(x=>Number(x.category_id)===Number(c.id)))||null;
 const inherited=inheritedNode?rows.filter(x=>Number(x.category_id)===Number(inheritedNode.id)):[];
 return {photos:own.map(dto),inheritedFrom:inheritedNode?{id:Number(inheritedNode.id),title:inheritedNode.title}:null,inheritedPhotos:inherited.map(dto)};
}

async function add(salonId,rawCategoryId,file){
 const categoryId=positiveId(rawCategoryId),c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);
  await categoryChain(c,salonId,categoryId);
  const count=await c.query(`SELECT COUNT(*)::int AS n,COALESCE(MAX(display_order),-1)+1 AS next_order
   FROM service_category_price_photos WHERE salon_id=$1 AND category_id=$2`,[salonId,categoryId]);
  if(Number(count.rows[0].n)>=MAX_PHOTOS_PER_CATEGORY)fail(`Больше ${MAX_PHOTOS_PER_CATEGORY} фото на один раздел загрузить нельзя.`,409);
  const out=await c.query(`INSERT INTO service_category_price_photos
   (salon_id,category_id,file_url,file_name,mime_type,byte_size,display_order)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,category_id,file_url,file_name,display_order`,
   [salonId,categoryId,file.fileUrl,file.fileName,file.mimeType,file.byteSize,count.rows[0].next_order]);
  await c.query('COMMIT');return dto(out.rows[0]);
 }catch(e){try{await c.query('ROLLBACK');}catch(_){}throw e;}finally{c.release();}
}

function parseItems(items){
 if(!Array.isArray(items)||!items.length)fail('Передайте порядок фотографий.');
 const out=items.map(x=>({id:positiveId(x&&x.id),displayOrder:Number(x&&x.displayOrder)}));
 if(out.some(x=>!Number.isInteger(x.displayOrder)||x.displayOrder<0)||new Set(out.map(x=>x.id)).size!==out.length||new Set(out.map(x=>x.displayOrder)).size!==out.length)fail('Некорректный порядок фотографий.');
 return out;
}

async function reorder(salonId,rawCategoryId,items){
 const categoryId=positiveId(rawCategoryId),parsed=parseItems(items),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);await categoryChain(c,salonId,categoryId);
  const found=await c.query('SELECT id FROM service_category_price_photos WHERE salon_id=$1 AND category_id=$2 AND id=ANY($3::int[]) FOR UPDATE',[salonId,categoryId,parsed.map(x=>x.id)]);
  if(found.rows.length!==parsed.length)fail('Фотография не найдена в этой категории.',409);
  for(const x of parsed)await c.query('UPDATE service_category_price_photos SET display_order=$4,updated_at=NOW() WHERE salon_id=$1 AND category_id=$2 AND id=$3',[salonId,categoryId,x.id,x.displayOrder]);
  await c.query('COMMIT');return {ok:true};
 }catch(e){try{await c.query('ROLLBACK');}catch(_){}throw e;}finally{c.release();}
}

async function remove(salonId,rawCategoryId,rawPhotoId){
 const categoryId=positiveId(rawCategoryId),photoId=positiveId(rawPhotoId),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(17292,$1)',[salonId]);await categoryChain(c,salonId,categoryId);
  const out=await c.query('DELETE FROM service_category_price_photos WHERE salon_id=$1 AND category_id=$2 AND id=$3 RETURNING file_url,legacy_photo_id',[salonId,categoryId,photoId]);
  if(!out.rows.length)fail('Фотография не найдена.',404);
  const row=out.rows[0];let canDeleteFile=false;
  if(row.legacy_photo_id==null){
   const refs=await c.query(`SELECT EXISTS(SELECT 1 FROM service_category_price_photos WHERE salon_id=$1 AND file_url=$2) OR
    EXISTS(SELECT 1 FROM agent_price_photos WHERE salon_id=$1 AND file_url=$2) AS used`,[salonId,row.file_url]);
   canDeleteFile=!refs.rows[0].used;
  }
  await c.query('COMMIT');return {ok:true,fileUrl:row.file_url,canDeleteFile};
 }catch(e){try{await c.query('ROLLBACK');}catch(_){}throw e;}finally{c.release();}
}

async function loadIndex(salonId){
 const [categories,photos,aliases]=await Promise.all([
  db.any('SELECT id,parent_id,title FROM service_categories WHERE salon_id=$1 ORDER BY id',[salonId]),
  db.any('SELECT id,category_id,file_url,file_name,mime_type,display_order FROM service_category_price_photos WHERE salon_id=$1 ORDER BY display_order,id',[salonId]),
  db.any('SELECT legacy_key,category_id FROM service_category_aliases WHERE salon_id=$1',[salonId]),
 ]);
 return {categories,photos,aliases};
}

module.exports={MAX_PHOTOS_PER_CATEGORY,list,add,reorder,remove,loadIndex,parseItems};
