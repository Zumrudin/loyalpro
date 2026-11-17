'use strict';
jest.mock('./middleware/auth',()=>({auth:(req,res,next)=>req.__user?(req.user=req.__user,next()):res.status(401).json({}),requireRole:(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({})}));
jest.mock('./services/service-category-photos',()=>({list:jest.fn(),add:jest.fn(),reorder:jest.fn(),remove:jest.fn()}));
jest.mock('./services/agent/price-list-data',()=>({invalidate:jest.fn()}));
const store=require('./services/service-category-photos');
const cache=require('./services/agent/price-list-data');
const router=require('./routes/service-category-photos');
const express=require('express');
const http=require('http');
const fs=require('fs');

function call(method,url,user={role:'owner',salonId:3},body={}){return new Promise(resolve=>{const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this},status(s){this.statusCode=s;return this},json(value){resolve({status:this.statusCode,body:value,headers:this.headers})}};router.handle({method,url,headers:{},query:{},body,__user:user},res,()=>resolve({status:404}));});}
beforeEach(()=>jest.clearAllMocks());

test('all photo endpoints require owner/admin',async()=>{
 for(const user of [null,{role:'specialist',salonId:3},{role:'admin_cashier',salonId:3}]){
  expect((await call('GET','/categories/4/price-photos',user)).status).toBe(user?403:401);
  expect((await call('PUT','/categories/4/price-photos/reorder',user,{items:[]})).status).toBe(user?403:401);
  expect((await call('DELETE','/categories/4/price-photos/8',user)).status).toBe(user?403:401);
 }
 expect(store.list).not.toHaveBeenCalled();
});

test('GET uses server tenant and returns no-store response',async()=>{
 store.list.mockResolvedValue({photos:[],inheritedFrom:null,inheritedPhotos:[]});
 const out=await call('GET','/categories/4/price-photos',{role:'admin',salonId:3});
 expect(store.list).toHaveBeenCalledWith(3,'4');expect(out.headers['Cache-Control']).toBe('no-store');
});

test('reorder and delete invalidate only server tenant',async()=>{
 store.reorder.mockResolvedValue({ok:true});store.remove.mockResolvedValue({ok:true,fileUrl:'/uploads/shared.jpg',canDeleteFile:false});
 expect((await call('PUT','/categories/4/price-photos/reorder',{role:'owner',salonId:3},{items:[{id:8,displayOrder:0}],salonId:99})).status).toBe(200);
 expect(store.reorder).toHaveBeenCalledWith(3,'4',[{id:8,displayOrder:0}]);
 await call('DELETE','/categories/4/price-photos/8',{role:'owner',salonId:3});
 expect(store.remove).toHaveBeenCalledWith(3,'4','8');expect(cache.invalidate).toHaveBeenCalledTimes(2);expect(cache.invalidate).toHaveBeenCalledWith(3);
});

test('service errors are sanitized',async()=>{
 store.list.mockRejectedValue(new Error('synthetic-secret'));
 const out=await call('GET','/categories/4/price-photos');expect(out.status).toBe(500);expect(JSON.stringify(out)).not.toContain('synthetic-secret');
});

describe('multipart upload',()=>{
 let server,baseUrl,writeSpy,mkdirSpy,unlinkSpy;
 beforeAll(async()=>{
  writeSpy=jest.spyOn(fs.promises,'writeFile').mockResolvedValue();mkdirSpy=jest.spyOn(fs.promises,'mkdir').mockResolvedValue();unlinkSpy=jest.spyOn(fs,'unlink').mockImplementation((p,cb)=>cb&&cb());
  const app=express();app.use((req,res,next)=>{req.__user={role:'owner',salonId:3};next();});app.use(router);
  server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
 });
 afterAll(async()=>{writeSpy.mockRestore();mkdirSpy.mockRestore();unlinkSpy.mockRestore();await new Promise(resolve=>server.close(resolve));});
 test('valid JPEG is signature-checked, stored and invalidates index',async()=>{
  store.add.mockResolvedValue({id:9,categoryId:4,fileUrl:'/uploads/x.jpg',fileName:'x.jpg',displayOrder:0});
  const form=new FormData();form.append('file',new Blob([Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0])],{type:'image/jpeg'}),'price.jpg');
  const response=await fetch(`${baseUrl}/categories/4/price-photos`,{method:'POST',body:form});
  expect(response.status).toBe(201);expect(store.add).toHaveBeenCalledWith(3,4,expect.objectContaining({mimeType:'image/jpeg',byteSize:8}));expect(writeSpy).toHaveBeenCalled();expect(cache.invalidate).toHaveBeenCalledWith(3);
 });
 test('DB failure removes the new file; post-commit cache failure keeps it',async()=>{
  const send=async()=>{const form=new FormData();form.append('file',new Blob([Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0])],{type:'image/jpeg'}),'price.jpg');return fetch(`${baseUrl}/categories/4/price-photos`,{method:'POST',body:form});};
  store.add.mockRejectedValueOnce(new Error('synthetic DB failure'));
  expect((await send()).status).toBe(500);expect(unlinkSpy).toHaveBeenCalledTimes(1);
  unlinkSpy.mockClear();store.add.mockResolvedValueOnce({id:9});cache.invalidate.mockImplementationOnce(()=>{throw Error('synthetic cache failure');});
  expect((await send()).status).toBe(500);expect(unlinkSpy).not.toHaveBeenCalled();
 });
 test('spoofed JPEG is rejected before disk and DB',async()=>{
  writeSpy.mockClear();store.add.mockClear();const form=new FormData();form.append('file',new Blob([Buffer.from('not an image')],{type:'image/jpeg'}),'price.jpg');
  const response=await fetch(`${baseUrl}/categories/4/price-photos`,{method:'POST',body:form});
  expect(response.status).toBe(400);expect(writeSpy).not.toHaveBeenCalled();expect(store.add).not.toHaveBeenCalled();
 });
});
