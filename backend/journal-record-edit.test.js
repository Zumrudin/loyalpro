'use strict';
jest.mock('./config',()=>({JWT_SECRET:'synthetic'}));
const {parse,patch}=require('./services/journal/record-edit');
const m=require('./services/journal/model');
const record={id:1,staff_id:5,datetime:'2030-04-01T10:00:00+03:00',seance_length:3600,services:[{id:7,cost:100}],attendance:0};
const line={serviceId:8,quantity:1,unitPrice:200,discount:0};
const src={services:async()=>[{id:8,title:'Synthetic',staff:[{id:5}]}]};
test('new composition checks availability excluding original visit and keeps duration',async()=>{
 const availability=jest.fn(async()=>({slots:['10:00']}));
 const out=await patch({id:3},record,{lines:[line]},src,availability);
 expect(out.services[0]).toMatchObject({id:8,cost:200});
 expect(availability.mock.calls[0][2]).toMatchObject({id:1,seance_length:3600,services:out.services});
});
test('new composition refuses occupied time',async()=>{
 await expect(patch({id:3},record,{lines:[line]},src,async()=>({slots:[]}))).rejects.toMatchObject({code:'slot_taken'});
});
test('foreign or unavailable new service is refused',async()=>{
 await expect(patch({id:3},record,{lines:[line]},{services:async()=>[]},jest.fn())).rejects.toThrow('недоступна');
});
test.each([[],[line,line],[{...line,discount:101}],[{...line,quantity:0}]].map(lines=>[lines]))('invalid lines rejected',lines=>{
 expect(()=>parse({lines})).toThrow();
});
test('stale services revision refused',async()=>{
 await expect(patch({},record,{lines:[{serviceId:7,quantity:1,unitPrice:100,discount:0}],servicesVersion:m.servicesRevision({...record,services:[{id:7,cost:50}]})},src,jest.fn())).rejects.toMatchObject({code:'edit_conflict'});
});

describe('active payment guard',()=>{
 const {hasActivePayments}=require('./services/journal/record-edit');
 const payment={action:'payment',method:'account',external_ids:[1,2]};
 test('partial removal still blocks',()=>expect(hasActivePayments([payment,{action:'remove',method:'account',external_ids:[1]}])).toBe(true));
 test('another method cannot reverse payment',()=>expect(hasActivePayments([payment,{action:'remove',method:'loyalty_card',external_ids:[1,2]}])).toBe(true));
 test('complete removals unblock regardless of numeric or string ids',()=>expect(hasActivePayments([payment,{action:'remove',method:'account',external_ids:['1'],target_transaction_id:2}])).toBe(false));
 test('missing receipts stay blocked',()=>expect(hasActivePayments([{action:'payment',method:'account',external_ids:[]}])).toBe(true));
 test('only removals do not block',()=>expect(hasActivePayments([{action:'remove',method:'account',external_ids:[1]}])).toBe(false));
});

test('edit version ignores service/client enrichment but detects actual changes',()=>{
 const base={...record,client:{id:10},services:[{id:7,cost:100,amount:1,cost_per_unit:100}]};
 const enriched={...base,client:{id:10,extra:'synthetic'},services:[{...base.services[0],title:'Synthetic',extra:true}]};
 expect(m.editRevision(base)).toBe(m.editRevision(enriched));
 expect(m.editRevision({...base,attendance:1})).not.toBe(m.editRevision(base));
 expect(m.editRevision({...base,services:[{...base.services[0],cost:90}]})).not.toBe(m.editRevision(base));
 expect(m.editRevision({...base,client:{id:11}})).not.toBe(m.editRevision(base));
});
describe('edit of composition, quantity and price (10.11.2026)',()=>{
 const own={id:7,title:'Own',amount:1,cost:100,first_cost:100,cost_per_unit:100,discount:0,cost_to_pay:100,manual_cost:100};
 const base={...record,services:[own]};
 test('quantity/price change of the same services does not re-check free time',async()=>{
  const availability=jest.fn(async()=>({slots:[]}));
  const out=await patch({id:3},base,{lines:[{serviceId:7,quantity:2,unitPrice:150,discount:10}]},src,availability);
  expect(availability).not.toHaveBeenCalled();
  expect(out.services[0]).toMatchObject({id:7,amount:2,cost_per_unit:150,first_cost:300,discount:10,cost:270});
 });
 test('stale cost_to_pay/manual_cost are not carried into the changed line',async()=>{
  const out=await patch({id:3},base,{lines:[{serviceId:7,quantity:1,unitPrice:80,discount:0}]},src,jest.fn());
  expect(out.services[0]).not.toHaveProperty('cost_to_pay');
  expect(out.services[0]).not.toHaveProperty('manual_cost');
  expect(out.services[0].cost).toBe(80);
 });
 test('started/past visit: new composition is saved without the free-time check',async()=>{
  const past={...base,datetime:'2020-04-01T10:00:00+03:00'};
  const availability=jest.fn(async()=>({slots:[]}));
  const out=await patch({id:3},past,{lines:[{serviceId:7,quantity:1,unitPrice:100,discount:0},line]},src,availability);
  expect(availability).not.toHaveBeenCalled();
  expect(out.services.map(s=>s.id)).toEqual([7,8]);
 });
 test('future visit: an added service still checks free time and equipment',async()=>{
  const availability=jest.fn(async()=>({slots:[]}));
  await expect(patch({id:3},base,{lines:[{serviceId:7,quantity:1,unitPrice:100,discount:0},line]},src,availability)).rejects.toMatchObject({code:'slot_taken'});
 });
});
describe('conflict check only on the services the user edited (10.11.2026)', () => {
  test('a status change ignores any earlier change of the record (own status/payment packages)', async () => {
    const out = await patch({ id: 3 }, { ...record, attendance: 2, paid_amount: 0 }, { attendance: 1, version: 'a'.repeat(64), servicesVersion: m.servicesRevision(record) }, src, jest.fn());
    expect(out).toEqual({ attendance: 1 });
  });
  test('services edit conflicts only when the services themselves changed meanwhile', async () => {
    const base = m.servicesRevision(record);
    const changed = { ...record, services: [{ id: 7, cost: 999 }] };
    await expect(patch({ id: 3 }, changed, { lines: [{ serviceId: 7, quantity: 1, unitPrice: 100, discount: 0 }], servicesVersion: base }, src, jest.fn()))
      .rejects.toMatchObject({ code: 'edit_conflict' });
    const ok = await patch({ id: 3 }, { ...record, attendance: 2 }, { lines: [{ serviceId: 7, quantity: 2, unitPrice: 100, discount: 0 }], servicesVersion: base }, src, jest.fn());
    expect(ok.services[0]).toMatchObject({ id: 7, amount: 2 });
  });
});
