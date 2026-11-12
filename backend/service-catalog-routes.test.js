'use strict';
jest.mock('./config',()=>({JWT_SECRET:'synthetic'}));
jest.mock('./services/service-catalog',()=>({list:jest.fn(),saveCategory:jest.fn(),saveService:jest.fn(),importYclients:jest.fn()}));
jest.mock('./middleware/auth',()=>({auth:(req,res,next)=>req.__user?(req.user=req.__user,next()):res.status(401).json({}),requireRole:(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({})}));
const service=require('./services/service-catalog');const router=require('./routes/service-catalog');
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
