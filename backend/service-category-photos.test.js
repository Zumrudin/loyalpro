'use strict';
jest.mock('./db',()=>({
 db:{query:jest.fn(),any:jest.fn()},
 pool:{connect:jest.fn()},
}));
const {db,pool}=require('./db');
const store=require('./services/service-category-photos');

function conn(handler){const c={query:jest.fn(handler),release:jest.fn()};pool.connect.mockResolvedValue(c);return c;}
beforeEach(()=>jest.clearAllMocks());

test('list is tenant-scoped and returns nearest inherited photos',async()=>{
 db.query.mockResolvedValue({rows:[{id:7,parent_id:3,title:'Child',depth:0},{id:3,parent_id:null,title:'Parent',depth:1}]});
 db.any.mockResolvedValue([{id:4,category_id:3,file_url:'/uploads/p.jpg',file_name:'p.jpg',display_order:0}]);
 const out=await store.list(12,7);
 expect(db.query.mock.calls[0][1]).toEqual([12,7]);
 expect(db.any.mock.calls[0][1]).toEqual([12,[7,3]]);
 expect(out).toEqual({photos:[],inheritedFrom:{id:3,title:'Parent'},inheritedPhotos:[{id:4,categoryId:3,fileUrl:'/uploads/p.jpg',fileName:'p.jpg',displayOrder:0}]});
});

test('add holds catalog advisory lock and enforces cap atomically',async()=>{
 const c=conn(async(sql)=>{
  if(sql.includes('WITH RECURSIVE'))return {rows:[{id:7,parent_id:null,title:'Cat',depth:0}]};
  if(sql.includes('COUNT(*)'))return {rows:[{n:10,next_order:10}]};
  return {rows:[]};
 });
 await expect(store.add(12,7,{fileUrl:'/uploads/x.jpg',fileName:'x.jpg',mimeType:'image/jpeg',byteSize:3})).rejects.toMatchObject({status:409});
 expect(c.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(17292,$1)',[12]);
 expect(c.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);
 expect(c.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO service_category_price_photos'))).toBe(false);
});

test('remove cannot cross tenant/category and preserves shared legacy file',async()=>{
 const c=conn(async(sql)=>{
  if(sql.includes('WITH RECURSIVE'))return {rows:[{id:7,parent_id:null,title:'Cat',depth:0}]};
  if(sql.startsWith('DELETE'))return {rows:[{file_url:'/uploads/shared.jpg',legacy_photo_id:55}]};
  return {rows:[]};
 });
 const out=await store.remove(12,7,9);
 expect(c.query.mock.calls.find(([sql])=>sql.startsWith('DELETE'))[1]).toEqual([12,7,9]);
 expect(out).toEqual({ok:true,fileUrl:'/uploads/shared.jpg',canDeleteFile:false});
});

test('reorder rejects duplicate ids before SQL',async()=>{
 await expect(store.reorder(12,7,[{id:1,displayOrder:0},{id:1,displayOrder:1}])).rejects.toMatchObject({status:400});
 expect(pool.connect).not.toHaveBeenCalled();
});

test('loadIndex scopes categories, photos and aliases by salon',async()=>{
 db.any.mockResolvedValue([]);await store.loadIndex(23);
 expect(db.any).toHaveBeenCalledTimes(3);
 for(const call of db.any.mock.calls)expect(call[1]).toEqual([23]);
});
