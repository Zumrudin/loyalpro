'use strict';
const router=require('express').Router();
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {auth,requireRole}=require('../middleware/auth');
const store=require('../services/service-category-photos');
const priceListData=require('../services/agent/price-list-data');
const {JournalError,positiveId}=require('../services/journal/model');
const {validateImageBuffer}=require('../utils/upload-validator');

const uploadsDir=path.join(__dirname,'../../frontend/uploads');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1}});
const ALLOWED_MIME=new Set(['image/jpeg','image/png','image/webp']);
router.use(auth,requireRole('owner','admin'));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});

function safeUnlink(url){if(!url||!url.startsWith('/uploads/'))return;const base=path.basename(url);if(!base||base==='.'||base==='..')return;fs.unlink(path.join(uploadsDir,base),()=>{});}
function error(res,e){const status=e instanceof JournalError?e.status:500;res.status(status).json({error:e instanceof JournalError?e.message:'Не удалось выполнить операцию с фотографиями.'});}
function oneFile(req,res,next){upload.single('file')(req,res,e=>{if(e)return res.status(400).json({error:e.code==='LIMIT_FILE_SIZE'?'Файл больше 5 МБ.':'Не удалось прочитать файл.'});next();});}

router.get('/categories/:id/price-photos',async(req,res)=>{try{res.json(await store.list(req.user.salonId,req.params.id));}catch(e){error(res,e);}});
router.post('/categories/:id/price-photos',oneFile,async(req,res)=>{
 let fileUrl=null, written=false, committed=false;
 try{
  const categoryId=positiveId(req.params.id);
  if(!req.file) return res.status(400).json({error:'Выберите файл.'});
  if(!ALLOWED_MIME.has(String(req.file.mimetype).toLowerCase()))return res.status(400).json({error:'Разрешены только JPEG, PNG и WEBP.'});
  const valid=validateImageBuffer(req.file.buffer,req.file.originalname);
  if(!valid.ok||valid.ext==='.gif')return res.status(400).json({error:'Содержимое файла не соответствует JPEG, PNG или WEBP.'});
  const expectedMime=valid.ext==='.png'?'image/png':valid.ext==='.webp'?'image/webp':'image/jpeg';
  if(String(req.file.mimetype).toLowerCase()!==expectedMime)return res.status(400).json({error:'Тип файла не соответствует его содержимому.'});
  const ext=valid.ext==='.jpeg'?'.jpg':valid.ext;
  const fileName=`service_price_${req.user.salonId}_${categoryId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  fileUrl=`/uploads/${fileName}`;await fs.promises.mkdir(uploadsDir,{recursive:true});await fs.promises.writeFile(path.join(uploadsDir,fileName),req.file.buffer,{flag:'wx'});written=true;
  const photo=await store.add(req.user.salonId,categoryId,{fileUrl,fileName,mimeType:expectedMime,byteSize:req.file.size});
  committed=true;
  priceListData.invalidate(req.user.salonId);res.status(201).json(photo);
 }catch(e){if(written&&!committed)safeUnlink(fileUrl);error(res,e);}
});
router.put('/categories/:id/price-photos/reorder',async(req,res)=>{try{const out=await store.reorder(req.user.salonId,req.params.id,req.body&&req.body.items);priceListData.invalidate(req.user.salonId);res.json(out);}catch(e){error(res,e);}});
router.delete('/categories/:id/price-photos/:photoId',async(req,res)=>{try{const out=await store.remove(req.user.salonId,req.params.id,req.params.photoId);if(out.canDeleteFile)safeUnlink(out.fileUrl);priceListData.invalidate(req.user.salonId);res.json({ok:true});}catch(e){error(res,e);}});
module.exports=router;
