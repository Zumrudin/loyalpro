'use strict';
jest.mock('./config',()=>({JWT_SECRET:'synthetic'}));
jest.mock('./db',()=>({db:{any:jest.fn(),oneOrNone:jest.fn()},pool:{connect:jest.fn()}}));
jest.mock('./services/journal/yclients',()=>({list:jest.fn()}));
const {db,pool}=require('./db');const yc=require('./services/journal/yclients');const service=require('./services/service-catalog');
const body={title:'Synthetic',duration:30,priceMin:100,priceMax:200,active:true};let c;
beforeEach(()=>{jest.clearAllMocks();c={query:jest.fn().mockResolvedValue({rows:[]}),release:jest.fn()};pool.connect.mockResolvedValue(c);});
test('validation rejects invalid prices, duration and category ID',()=>{
 for(const patch of [{priceMin:-1},{priceMin:300,priceMax:200},{duration:0},{duration:1.5},{categoryId:'x'},{title:''},{active:'true'}])expect(()=>service.parseService({...body,...patch})).toThrow();
 expect(service.parseService(body)).toMatchObject({duration:30,priceMin:100});
});
test('categories reject cycles and foreign/missing parents',()=>{
 const rows=[{id:1,parent_id:null},{id:2,parent_id:1},{id:3,parent_id:2}];
 expect(()=>service.checkParent(rows,1,3)).toThrow();expect(()=>service.checkParent(rows,1,1)).toThrow();expect(()=>service.checkParent(rows,4,99)).toThrow();expect(()=>service.checkParent(rows,4,3)).not.toThrow();
});
test('category writes lock hierarchy and scope reads/writes by salon',async()=>{
 c.query.mockImplementation(async sql=>({rows:sql.startsWith('SELECT id,parent_id')?[{id:5,parent_id:null}]:sql.startsWith('UPDATE')?[{id:5}]:[]}));
 await service.saveCategory(3,5,{title:'Updated',parentId:null});
 expect(c.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(17292,$1)',[3]);
 expect(c.query).toHaveBeenCalledWith(expect.stringContaining('WHERE salon_id=$1 AND id=$2'),[3,5,'Updated',null]);
 expect(c.query).toHaveBeenCalledWith('COMMIT');
});
test('service cannot link a category or economics service belonging to another tenant',async()=>{
 await expect(service.saveService(3,null,{...body,categoryId:99})).rejects.toThrow('Категория');
 await expect(service.saveService(3,null,{...body,economicsId:88})).rejects.toThrow('экономики');
 expect(c.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 expect(c.query).toHaveBeenCalledWith('ROLLBACK');expect(c.release).toHaveBeenCalled();
});
test('listing is tenant scoped and journal excludes archived/unlinked services',async()=>{
 db.any.mockImplementation(async sql=>sql.includes('FROM service_categories')?[]:[{id:1,active:true,linked:true,title:'Local',staff:[{id:2}],duration:30},{id:2,active:false,linked:true},{id:3,active:true,linked:false}]);
 const result=await service.forJournal(4);expect(result.services.map(s=>s.id)).toEqual([1]);
 for(const [,args]of db.any.mock.calls)expect(args).toEqual([4]);
 expect(db.any.mock.calls.find(([sql])=>sql.includes('JOIN salons'))[0]).toContain('c.yclients_company_id::text=s.yclients_company_id::text');
});
test('resolve scopes IDs to tenant/company and fails on missing/archived mapping',async()=>{
 db.any.mockResolvedValue([]);await expect(service.resolve({id:3,yclients_company_id:30},[7])).rejects.toThrow();
 expect(db.any).toHaveBeenCalledWith(expect.stringContaining('salon_id=$1'),[3,[7],30]);
 expect(db.any.mock.calls[0][0]).toContain('AND active');
});
test('import is atomic and repeat imports never overwrite locally edited rows',async()=>{
 db.oneOrNone.mockResolvedValue({id:3,yclients_company_id:30});yc.list.mockImplementation(async(_,path)=>path.includes('service_categories')?[{id:10,title:'Cat'}]:[{id:7,title:'Service',category_id:10,duration:1800,price_min:500,price_max:500,staff:[{id:1}]}]);
 c.query.mockImplementation(async sql=>({rows:sql.startsWith('SELECT id,yclients_id')?[{id:100,yclients_id:10}]:[]}));
 expect(await service.importYclients(3)).toEqual({addedCategories:0,addedServices:0});
 const inserts=c.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT'));expect(inserts).toHaveLength(2);
 for(const [sql]of inserts){expect(sql).toContain('DO NOTHING');expect(sql).not.toContain('DO UPDATE');}
 expect(c.query).toHaveBeenCalledWith('COMMIT');
});
test('incomplete upstream import never starts database transaction',async()=>{
 db.oneOrNone.mockResolvedValue({id:3,yclients_company_id:30});yc.list.mockRejectedValue(new Error('upstream'));
 await expect(service.importYclients(3)).rejects.toThrow();expect(pool.connect).not.toHaveBeenCalled();
});
test('schema has composite tenant foreign keys and stable unique external mapping',()=>{
 const {SERVICE_CATALOG_DDL}=require('./migrations');
 expect(SERVICE_CATALOG_DDL).toContain('FOREIGN KEY(salon_id,parent_id)');expect(SERVICE_CATALOG_DDL).toContain('FOREIGN KEY(salon_id,category_id)');expect(SERVICE_CATALOG_DDL).toContain('UNIQUE(salon_id,yclients_company_id,yclients_id)');expect(SERVICE_CATALOG_DDL).not.toMatch(/DROP|DELETE|TRUNCATE/);
});
