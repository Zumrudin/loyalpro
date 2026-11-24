'use strict';
jest.mock('./db',()=>({db:{any:jest.fn(),one:jest.fn(),oneOrNone:jest.fn()},pool:{}}));
jest.mock('./middleware/auth',()=>({
  ...jest.requireActual('./middleware/auth'),
  auth:(req,res,next)=>req.testUser?(req.user=req.testUser,next()):res.status(401).json({})
}));
jest.mock('./services/paper-folders',()=>({day:jest.fn(),get:jest.fn(),update:jest.fn(),updateOutbox:jest.fn()}));
jest.mock('./services/loyalty',()=>({}));
jest.mock('./services/yclients',()=>({}));
jest.mock('./services/finance-ops',()=>({}));
const folders=require('./services/paper-folders');
const cabinet=require('./routes/paper-folders');
const clients=require('./routes/clients');
const user={salonId:7,userId:8,role:'admin'};
function call(router,method,url,options={}) {
  return new Promise(resolve=>{
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}};
    router.handle({method,url,query:options.query||{},body:options.body,testUser:options.user===undefined?user:options.user},res,()=>resolve({status:404}));
  });
}
beforeEach(()=>jest.resetAllMocks());
test.each([null,{...user,role:'specialist'}])('cabinet read/write enforce auth and role %p',async actor=>{
  const expected=actor?403:401;
  expect((await call(cabinet,'GET','/day',{user:actor})).status).toBe(expected);
  expect((await call(cabinet,'PATCH','/outbox/5',{user:actor,body:{prepared:true}})).status).toBe(expected);
  expect((await call(clients,'PATCH','/5/paper-folder',{user:actor,body:{archived:true}})).status).toBe(expected);
  expect(folders.day).not.toHaveBeenCalled();expect(folders.update).not.toHaveBeenCalled();expect(folders.updateOutbox).not.toHaveBeenCalled();
});
test('day ignores tenant query and uses authenticated salon',async()=>{
  folders.day.mockResolvedValue({items:[]});
  expect((await call(cabinet,'GET','/day',{query:{date:'2030-01-01',salonId:99}})).status).toBe(200);
  expect(folders.day).toHaveBeenCalledWith(7,'2030-01-01');
});
test('client updates use authenticated tenant and actor',async()=>{
  folders.update.mockResolvedValue({number:null,archived:true});
  expect((await call(clients,'PATCH','/5/paper-folder',{body:{archived:true}})).body.paperFolder.archived).toBe(true);
  expect(folders.update).toHaveBeenCalledWith(7,5,8,{archived:true});
});
test.each(['0','-1','wat','9007199254740993'])('invalid ID %s rejected without write',async id=>{
  expect((await call(clients,'PATCH',`/${id}/paper-folder`,{body:{archived:true}})).status).toBe(400);
  expect((await call(cabinet,'PATCH',`/outbox/${id}`,{body:{prepared:true}})).status).toBe(400);
  expect(folders.update).not.toHaveBeenCalled();expect(folders.updateOutbox).not.toHaveBeenCalled();
});
test('expected conflict survives; unexpected errors do not leak database detail',async()=>{
  folders.update.mockRejectedValueOnce(Object.assign(new Error('Номер уже занят'),{status:409}));
  expect((await call(clients,'PATCH','/5/paper-folder',{body:{number:2000}}))).toEqual({status:409,body:{error:'Номер уже занят'}});
  folders.day.mockRejectedValueOnce(new Error('internal-database-detail'));
  expect((await call(cabinet,'GET','/day',{query:{date:'2030-01-01'}}))).toEqual({status:500,body:{error:'Не удалось загрузить папки'}});
});

test('cashier reads cabinet and marks known-client preparation using authenticated tenant',async()=>{
  const cashier={...user,role:'admin_cashier'};
  folders.day.mockResolvedValue({items:[]});
  folders.update.mockResolvedValue({number:5,prepared:true});
  expect((await call(cabinet,'GET','/day',{user:cashier,query:{date:'2030-01-01',salonId:99}})).status).toBe(200);
  expect(folders.day).toHaveBeenCalledWith(7,'2030-01-01');
  expect((await call(clients,'PATCH','/5/paper-folder',{user:cashier,body:{prepared:true}})).status).toBe(200);
  expect(folders.update).toHaveBeenCalledWith(7,5,8,{prepared:true});
});
test('cashier marks provisional outbox preparation using authenticated tenant',async()=>{
  folders.updateOutbox.mockResolvedValue({number:5,prepared:true});
  expect((await call(cabinet,'PATCH','/outbox/5',{user:{...user,role:'admin_cashier'},body:{prepared:true}})).status).toBe(200);
  expect(folders.updateOutbox).toHaveBeenCalledWith(7,5,8,{prepared:true});
});
test.each([{archived:true},{number:5},{prepared:true,archived:true},{prepared:true,role:'owner'}])('cashier cannot change cabinet ownership/archive or smuggle extra keys %p',async body=>{
  expect((await call(clients,'PATCH','/5/paper-folder',{user:{...user,role:'admin_cashier'},body})).status).toBe(403);
  expect(folders.update).not.toHaveBeenCalled();
});
