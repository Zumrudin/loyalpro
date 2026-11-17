'use strict';
jest.mock('./db',()=>({db:{any:jest.fn()},pool:{connect:jest.fn()}}));
jest.mock('./services/journal/yclients',()=>({list:jest.fn()}));
const {db,pool}=require('./db');
const catalog=require('./services/service-catalog');
const {parseAssignments,effectiveValues}=require('./services/service-assignment-values');
const base={id:1,title:'Synthetic',duration:30,price_min:6000,price_max:6000,assignments_initialized:true};
const body={title:'Synthetic',duration:30,priceMin:6000,priceMax:6000,active:true,version:2};
let c;
beforeEach(()=>{jest.clearAllMocks();c={query:jest.fn(async sql=>({rows:sql.startsWith('SELECT id,version')?[{id:1,version:2}]:sql.startsWith('SELECT id,yclients_staff_id')?[{id:5,yclients_staff_id:50,is_active:true}]:sql.startsWith('UPDATE service_catalog')?[{id:1,version:3}]:[]})),release:jest.fn()};pool.connect.mockResolvedValue(c);});
test('independent inheritance, zero price and resetting overrides',()=>{
 expect(effectiveValues(base,{priceMin:null,priceMax:null,duration:45})).toEqual({priceMin:6000,priceMax:6000,duration:45,inheritsPrice:true,inheritsDuration:false});
 expect(effectiveValues(base,{priceMin:0,priceMax:null,duration:null})).toMatchObject({priceMin:0,priceMax:0,duration:30});
 expect(effectiveValues({...base,price_min:7000,price_max:8000},{priceMin:6000,priceMax:6000,duration:30})).toMatchObject({priceMin:6000,priceMax:6000,duration:30});
 expect(effectiveValues({...base,price_min:7000},{priceMin:null,priceMax:null,duration:null}).priceMin).toBe(7000);
});
test.each([{duration:0},{duration:1.5},{priceMin:-1},{priceMin:10,priceMax:9},{priceMax:5},{priceMin:true},{priceMin:1.001},{duration:{}},{staffMemberId:-1}])('rejects invalid assignment %p',patch=>{
 expect(()=>parseAssignments([{staffMemberId:5,...patch}])).toThrow();
});
test('duplicates and invalid lists rejected; empty list and zero price allowed',()=>{
 expect(()=>parseAssignments([{staffMemberId:5},{staffMemberId:5}])).toThrow();
 expect(()=>parseAssignments(null)).toThrow();expect(parseAssignments([])).toEqual([]);
 expect(parseAssignments([{staffMemberId:5,priceMin:0}])[0]).toMatchObject({priceMin:0,duration:null});
});
test('initialized empty assignments never fall back to legacy JSON',()=>{
 const row=catalog.decorate([{...base,staff:[{id:50}]}],[{id:5,yclients_staff_id:50,is_active:true}],[])[0];
 expect(row.staff).toEqual([]);expect(catalog.journalService(row).staffIds).toEqual([]);
});
test('inactive staff remains visible in editor but unavailable for booking',()=>{
 const row=catalog.decorate([base],[{id:5,yclients_staff_id:50,is_active:false}],[{service_id:1,staff_member_id:5,price_min:0,duration:45}])[0];
 expect(row.assignments).toHaveLength(1);expect(row.staff).toEqual([]);
});
test('booking values use the assignment snapshot read with service fields',()=>{
 const row=catalog.decorate([{...base,assignment_rows:[{service_id:1,staff_member_id:5,yclients_staff_id:50,is_active:true,price_min:0,price_max:0,duration:45}]}],[{id:5,yclients_staff_id:50,is_active:false}],[])[0];
 expect(catalog.journalService(row).staffDetails).toEqual([{id:50,priceMin:0,priceMax:0,duration:45}]);
 expect(row.assignment_rows).toBeUndefined();
});
test('legacy missing staff is reported; zero price survives journal adaptation',()=>{
 const row=catalog.decorate([{...base,assignments_initialized:false,staff:[{id:99},{id:50,price:{min:0,max:0},seance_length:1800}]}],[{id:5,yclients_staff_id:50,is_active:true}],[])[0];
 expect(row.assignmentsUnresolved).toBe(true);expect(row.assignments).toHaveLength(1);
 expect(catalog.journalService(row).staffDetails[1].priceMin).toBe(0);
});
test('legacy fixed price max zero is normalized without losing genuinely free price',()=>{
 const row=catalog.journalService({...base,staff:[{id:50,price:{min:6000,max:0}},{id:51,price:{min:0,max:0}}]});
 expect(row.staffDetails.map(s=>[s.priceMin,s.priceMax])).toEqual([[6000,6000],[0,0]]);
});
test('save atomically replaces assignments under server salon and bumps version',async()=>{
 await catalog.saveService(3,1,{...body,assignments:[{staffMemberId:5,priceMin:0,duration:45}],salonId:999});
 expect(c.query).toHaveBeenCalledWith(expect.stringContaining('FROM staff_members WHERE salon_id=$1'),[3,[5]]);
 expect(c.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO service_staff_assignments'),[3,1,5,0,null,45,'local']);
 expect(c.query).toHaveBeenCalledWith('COMMIT');
});
test('foreign or inactive member rolls back whole save',async()=>{
 c.query.mockImplementation(async sql=>({rows:sql.startsWith('SELECT id,version')?[{id:1,version:2}]:sql.startsWith('UPDATE service_catalog')?[{id:1,version:3}]:[]}));
 await expect(catalog.saveService(3,1,{...body,assignments:[{staffMemberId:99}]})).rejects.toThrow('Специалист');
 expect(c.query).toHaveBeenCalledWith('ROLLBACK');expect(c.query).not.toHaveBeenCalledWith('COMMIT');
 expect(c.query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);
});
test('stale version prevents any write; assignments edit requires version',async()=>{
 await expect(catalog.saveService(3,1,{...body,version:1,assignments:[]})).rejects.toThrow('изменена');
 expect(c.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
 await expect(catalog.saveService(3,1,{...body,version:undefined,assignments:[]})).rejects.toThrow('Обновите');
});
test('old API body keeps assignments untouched',async()=>{
 await catalog.saveService(3,1,{...body,version:undefined});
 expect(c.query.mock.calls.some(([sql])=>sql.includes('service_staff_assignments'))).toBe(false);
});
test('assignment schema preserves tenant boundaries and does no startup backfill',()=>{
 const {SERVICE_STAFF_ASSIGNMENTS_DDL:ddl}=require('./migrations');
 expect(ddl).toContain('FOREIGN KEY(salon_id,service_id)');expect(ddl).toContain('FOREIGN KEY(salon_id,staff_member_id)');
 expect(ddl).toContain('PRIMARY KEY(salon_id,service_id,staff_member_id)');
 expect(ddl).not.toMatch(/INSERT INTO|UPDATE service_catalog|DROP TABLE/);
});
