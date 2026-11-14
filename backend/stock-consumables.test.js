'use strict';
jest.mock('./db',()=>({db:{any:jest.fn(),oneOrNone:jest.fn()},pool:{connect:jest.fn()}}));
jest.mock('./services/stock/store');
jest.mock('./services/stock/documents',()=>({transaction:jest.fn((s,fn)=>fn(jest.fn().mockResolvedValue({rows:[]})))}));
const c=require('./services/stock/consumables');
const store=require('./services/stock/store');
const {transaction}=require('./services/stock/documents');
const goods=[{id:1,yclients_good_id:10,title:'Synthetic',unit_equals:10,unit_actual_cost:2}];
beforeEach(()=>{jest.clearAllMocks();store.consumablesContext.mockResolvedValue({services:[{id:20,amount:2}],staffId:30,date:'2026-11-14',goods,links:[],cards:[],overrides:[]});store.recordConsumableMovements.mockResolvedValue([{good_row_id:1,service_yc_id:20,qty_base:-4},{good_row_id:1,service_yc_id:20,qty_base:1}]);store.getSettings.mockResolvedValue({default_service_storage_id:2});store.storageById.mockResolvedValue({id:2,is_active:true});store.insertDocument.mockResolvedValue({id:9});store.stockPriceReceipts.mockResolvedValue([]);});
test('norm multiplies service quantity, uses selected staff card and shared price',()=>{
 const rows=c.expectedFor({id:20,amount:2},30,[{service_yc_id:20,staff_yc_id:30,source:'manual',tech_card_id:3}],[{id:3,items:[{good_id:10,amount:4}]}],()=>({price:2}),goods);
 expect(rows).toEqual([expect.objectContaining({goodRowId:1,qtyBase:8,unitPrice:2,cost:16})]);
});
test('signed adjustments reduce actual consumption; comparison flags excess/missing/extra',()=>{
 expect(c.actualRows([{good_row_id:1,qty_base:-4},{good_row_id:1,qty_base:1}])[0].qtyBase).toBe(3);
 expect(c.compare([{goodRowId:1,qtyBase:2}], [{goodRowId:1,qtyBase:3},{goodRowId:2,qtyBase:1}]).map(r=>r.flag)).toEqual(['over','extra']);
 expect(c.compare([{goodRowId:1,qtyBase:2}],[])[0].flag).toBe('missing');
});
test('target equal to net actual creates no document; delta correction is signed',async()=>{
 await expect(c.update(1,7,80,20,{lines:[{goodRowId:1,qtyBase:3}]})).resolves.toMatchObject({unchanged:true});expect(store.insertDocument).not.toHaveBeenCalled();
 await c.update(1,7,80,20,{lines:[{goodRowId:1,qtyBase:5}]});expect(store.insertMovement).toHaveBeenCalledWith(expect.any(Function),1,expect.objectContaining({qtyBase:-2,recordId:80,serviceYcId:20}));
 expect(transaction).toHaveBeenCalled();
});
test.each([[],[{goodRowId:99,qtyBase:1}],[{goodRowId:1,qtyBase:-1}],[{goodRowId:1,qtyBase:NaN}]].map(lines=>[lines]))('validates target and cross-tenant goods',async lines=>{
 if(!lines.length){await c.update(1,7,80,20,{lines});expect(store.insertMovement).toHaveBeenCalledWith(expect.any(Function),1,expect.objectContaining({qtyBase:3}));}
 else await expect(c.update(1,7,80,20,{lines})).rejects.toMatchObject({status:400});
});
test('unknown service and local-only record cannot be changed',async()=>{
 await expect(c.update(1,7,80,99,{lines:[]})).rejects.toMatchObject({status:404});
 await expect(c.update(1,7,-80,20,{lines:[]})).rejects.toMatchObject({status:409});
});
