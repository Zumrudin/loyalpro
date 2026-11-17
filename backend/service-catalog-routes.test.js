'use strict';
jest.mock('./services/economics/report',()=>({invalidate:jest.fn()}));
jest.mock('./config',()=>({JWT_SECRET:'synthetic'}));
jest.mock('./services/service-catalog',()=>({list:jest.fn(),saveCategory:jest.fn(),saveService:jest.fn(),importYclients:jest.fn()}));
jest.mock('./services/service-catalog-reconcile',()=>({preview:jest.fn(),apply:jest.fn()}));
jest.mock('./middleware/auth',()=>({auth:(req,res,next)=>req.__user?(req.user=req.__user,next()):res.status(401).json({}),requireRole:(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({})}));
const service=require('./services/service-catalog');const router=require('./routes/service-catalog');
const reconcile=require('./services/service-catalog-reconcile');
function call(method,url,user={role:'owner',salonId:3},body={}) {return new Promise(resolve=>{const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this},status(s){this.statusCode=s;return this},json(body){resolve({status:this.statusCode,body,headers:this.headers})}};router.handle({method,url,headers:{},query:{},body,__user:user},res,()=>resolve({status:404}));});}
beforeEach(()=>jest.clearAllMocks());
test.each([null,{role:'specialist'},{role:'admin_cashier'}])('catalog read/import/write require staff authorization: %p',async user=>{for(const [method,path]of [['GET','/'],['POST','/import'],['POST','/categories'],['POST','/services']])expect((await call(method,path,user)).status).toBe(user?403:401);expect(service.importYclients).not.toHaveBeenCalled();});
test('admin can manage own tenant; body tenant is ignored',async()=>{
 const body={title:'Synthetic',salonId:999};expect((await call('POST','/categories',{role:'admin',salonId:3},body)).status).toBe(200);
 expect(service.saveCategory).toHaveBeenCalledWith(3,null,body);
 const result=await call('GET','/');expect(result.headers['Cache-Control']).toBe('no-store');expect(service.list).toHaveBeenCalledWith(3);
});
test('invalid IDs and upstream errors are safe',async()=>{
 expect((await call('PUT','/services/nope')).status).toBe(400);expect(service.saveService).not.toHaveBeenCalled();
 service.importYclients.mockRejectedValue(new Error('synthetic-secret'));const result=await call('POST','/import');expect(result.status).toBe(502);expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});
test('reconciliation uses server salon and is restricted to owners/admins',async()=>{
 for(const user of [null,{role:'specialist',salonId:3},{role:'admin_cashier',salonId:3}]){
  for(const path of ['/reconcile/preview','/reconcile/synthetic/apply'])expect((await call('POST',path,user)).status).toBe(user?403:401);
 }
 expect(reconcile.preview).not.toHaveBeenCalled();expect(reconcile.apply).not.toHaveBeenCalled();
 await call('POST','/reconcile/preview',{role:'admin',salonId:3},{salonId:999});
 expect(reconcile.preview).toHaveBeenCalledWith(3);
 await call('POST','/reconcile/synthetic/apply',{role:'owner',salonId:3},{salonId:999});
 expect(reconcile.apply).toHaveBeenCalledWith(3,'synthetic');
});

test('successful catalog mutations invalidate only the server tenant economics cache',async()=>{
 const economics=require('./services/economics/report');
 await call('PUT','/services/5',{role:'owner',salonId:3},{salonId:99});
 expect(economics.invalidate).toHaveBeenCalledWith(3);
 economics.invalidate.mockClear();
 await call('POST','/reconcile/preview');expect(economics.invalidate).not.toHaveBeenCalled();
 service.saveService.mockRejectedValueOnce(new Error('synthetic'));
 expect((await call('PUT','/services/5')).status).toBe(502);expect(economics.invalidate).not.toHaveBeenCalled();
});
