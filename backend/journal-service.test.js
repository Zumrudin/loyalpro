'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/service-catalog', () => ({forJournal:jest.fn(),resolve:jest.fn(),journalService:jest.requireActual('./services/service-catalog').journalService}));
jest.mock('./services/journal/yclients', () => ({ list: jest.fn(), records: jest.fn(), getRecord: jest.fn(), write: jest.fn() }));
const { db, pool } = require('./db');
const yc = require('./services/journal/yclients');
const service = require('./services/journal');
const m = require('./services/journal/model');
const localCatalog=require('./services/service-catalog');
const operationId = '12345678-1234-4123-8123-123456789012';
const record = { id: 8, staff_id: 1, datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600, services: [{ id: 7, cost: 500, discount: 10 }], client: { id: 5, name: 'Тест' }, attendance: 0, comment: 'Synthetic' };
let conn, prior, unresolved;
const draft = () => ({ operationId, action: 'confirm', recordId: 8, version: m.revision(record) });
beforeEach(() => {
  jest.clearAllMocks(); localCatalog.forJournal.mockResolvedValue({categories:[],services:[{id:70,title:'Local',duration:60,priceMin:500,staffIds:[1]}]}); prior = null; unresolved = null;
  conn = { release: jest.fn(), query: jest.fn(async sql => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('SELECT request_hash')) return { rows: prior ? [prior] : [] };
    if (sql.includes('SELECT operation_id')) return { rows: unresolved ? [unresolved] : [] };
    if (sql.includes('RETURNING operation_id')) return { rows: [{ operation_id: operationId }] };
    return { rows: [] };
  }) };
  pool.connect.mockResolvedValue(conn);
  db.oneOrNone.mockResolvedValue({ id: 3, yclients_company_id: 30 });
  yc.getRecord.mockResolvedValue(structuredClone(record));
  yc.write.mockResolvedValue({ recordId: 8 });
  yc.records.mockResolvedValue([]);
  yc.list.mockImplementation(async (_, path) => {
    if (path.includes('/staff/')) return [{ id: 1 }];
    if (path.includes('/company/')) return [{ id: 7, title: 'Тест', duration: 3600, resources: [], staff: [{ id: 1 }] }];
    if (path.includes('/services/')) return [{ id: 7 }];
    if (path.includes('/schedule/')) return [{ date: '2030-04-01', is_working: 1, slots: [{ from: '09:00', to: '12:00' }] }];
    return [];
  });
});
test('pending commit precedes external effect; tenant/user scoped audit; unlock', async () => {
  yc.write.mockImplementation(async () => {
    expect(conn.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO journal_operations'))).toBe(true);
    return { recordId: 8 };
  });
  expect(await service.mutate(3, 4, draft())).toEqual({ recordId: 8 });
  const insert = conn.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO'));
  expect(insert[1].slice(0, 5)).toEqual([3, operationId, 4, 'confirm', 8]);
  expect(db.oneOrNone).toHaveBeenCalledWith('SELECT * FROM salons WHERE id=$1', [3]);
  expect(yc.write.mock.calls[0][2]).toMatchObject({ services: record.services, client: record.client, attendance: 2, save_if_busy: false });
  expect(conn.query.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');
  expect(conn.release).toHaveBeenCalledWith(false);
});
test('replay returns stored success without calling YClients', async () => {
  prior = { state: 'done', request_hash: m.fingerprint(draft()), result: { recordId: 8 } };
  expect(await service.mutate(3, 4, draft())).toEqual({ recordId: 8, duplicate: true });
  expect(yc.write).not.toHaveBeenCalled(); expect(yc.getRecord).not.toHaveBeenCalled();
});
test.each(['pending','reviewed','rejected'])('%s cannot replay external action', async state => {
  prior = { state, request_hash: m.fingerprint(draft()) };
  await expect(service.mutate(3, 4, draft())).rejects.toThrow();
  expect(yc.write).not.toHaveBeenCalled();
});
test('same key with different body rejected', async () => {
  prior = { state: 'done', request_hash: 'different' };
  await expect(service.mutate(3, 4, draft())).rejects.toThrow(/Ключ/);
  expect(yc.write).not.toHaveBeenCalled();
});
test('unknown result blocks new keys until manual reconciliation', async () => {
  unresolved = { operation_id: 'other' };
  await expect(service.mutate(3, 4, draft())).rejects.toMatchObject({ code: 'blocked_pending' });
  expect(yc.write).not.toHaveBeenCalled();
});
test('timeout remains pending; no blind retry', async () => {
  yc.write.mockRejectedValue(new Error('synthetic timeout'));
  await expect(service.mutate(3, 4, draft())).rejects.toMatchObject({ code: 'uncertain' });
  expect(yc.write).toHaveBeenCalledTimes(1);
  expect(conn.query.mock.calls.some(([sql]) => sql.includes("state='done'") || sql.includes("state='rejected'"))).toBe(false);
});
test('definite validation rejection releases pending block', async () => {
  yc.write.mockRejectedValue({ response: { status: 422 } });
  await expect(service.mutate(3, 4, draft())).rejects.toMatchObject({ code: 'rejected' });
  expect(conn.query.mock.calls.some(([sql]) => sql.includes("state='rejected'"))).toBe(true);
});
test('stale, paid, arrived, cancelled records never mutated', async () => {
  for (const patch of [{ comment: 'changed' }, { paid_full: true }, { attendance: 1 }, { deleted: true }, { attendance: -1 }]) {
    const r = { ...record, ...patch }; yc.getRecord.mockResolvedValue(r);
    const d = draft(); if (!patch.comment) d.version = m.revision(r);
    await expect(service.mutate(3, 4, d)).rejects.toThrow();
  }
  expect(yc.write).not.toHaveBeenCalled();
});
test('concurrent journal write fails quickly', async () => {
  conn.query.mockResolvedValue({ rows: [{ locked: false }] });
  await expect(service.mutate(3, 4, draft())).rejects.toMatchObject({ code: 'busy' });
  expect(yc.write).not.toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled();
});
test('create derives duration and rechecks complete slot', async () => {
  const d = { ...draft(), action: 'create', recordId: undefined, date: '2030-04-01', time: '09:00', staffId: 1, serviceIds: [7], clientName: 'Тест', clientPhone: '70000000000', comment: '' };
  await service.mutate(3, 4, d);
  expect(yc.write.mock.calls[0][2]).toMatchObject({ seance_length: 3600, datetime: '2030-04-01T09:00:00+03:00', staff_id: 1, send_sms: false, save_if_busy: false });
});
test('busy time rejected before durable marker or write', async () => {
  yc.records.mockResolvedValue([record]);
  const d = { ...draft(), action: 'create', recordId: undefined, date: '2030-04-01', time: '10:00', staffId: 1, serviceIds: [7] };
  await expect(service.mutate(3, 4, d)).rejects.toMatchObject({ code: 'slot_taken' });
  expect(yc.write).not.toHaveBeenCalled();
  expect(conn.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
});
test('move preserves price/client, cancellation follows existing convention', async () => {
  await service.mutate(3, 4, { ...draft(), action: 'move', date: '2030-04-01', time: '11:00', staffId: 1 });
  expect(yc.write.mock.calls[0][2]).toMatchObject({ client: record.client, services: record.services, datetime: '2030-04-01T11:00:00+03:00' });
  await service.mutate(3, 4, { ...draft(), action: 'cancel' });
  expect(yc.write.mock.calls[1][2]).toMatchObject({ attendance: -1, seance_length: 300 });
});
test('revision rechecked immediately before write', async () => {
  yc.getRecord.mockResolvedValueOnce(record).mockResolvedValueOnce({ ...record, attendance: 2 });
  await expect(service.mutate(3, 4, draft())).rejects.toMatchObject({ code: 'stale' });
  expect(yc.write).not.toHaveBeenCalled();
});
test('human reconciliation is tenant scoped, audited, and makes no external call', async () => {
  expect(await service.review(3, 4, operationId)).toEqual({ reviewed: true });
  const update = conn.query.mock.calls.find(([sql]) => sql.includes("state='reviewed'"));
  expect(update[1]).toEqual([3, operationId, 4]);
  expect(yc.write).not.toHaveBeenCalled();
});
test('connection with failed unlock is discarded', async () => {
  conn.query.mockImplementation(async sql => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) throw new Error('synthetic connection failure');
    return { rows: [] };
  });
  await service.mutate(3, 4, draft());
  expect(conn.release).toHaveBeenCalledWith(true);
});
test('unassigned service fails closed without write', async () => {
  yc.list.mockImplementation(async (_, path) => path.includes('/staff/') ? [{ id: 1 }] : [{ id: 7, duration: 3600, staff: [{ id: 2 }] }]);
  await expect(service.slots(3, { date: '2030-04-01', staffId: 1, serviceIds: [7] })).rejects.toThrow(/доступность/);
  expect(yc.write).not.toHaveBeenCalled();
});
test('failure to persist pending marker prevents upstream write', async () => {
  const original = conn.query.getMockImplementation();
  conn.query.mockImplementation(async (sql, args) => {
    if (sql.includes('INSERT INTO')) throw new Error('synthetic DB failure');
    return original(sql, args);
  });
  await expect(service.mutate(3, 4, draft())).rejects.toThrow();
  expect(yc.write).not.toHaveBeenCalled();
});
test('day loads neighbouring dates and excludes foreign Moscow dates', async () => {
  yc.records.mockResolvedValue([{ ...record, datetime: '2030-04-02T00:30:00+04:00' }, { ...record, id: 9, datetime: '2030-04-02T02:00:00+03:00' }]);
  const result = await service.day(3, '2030-04-01');
  expect(yc.records).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), '2030-03-31', '2030-04-02');
  expect(result.records.map(r => r.id)).toEqual([8]);
});
test('calendar excludes administrators but retains hidden specialists and exposes actual shifts', async () => {
  const original = yc.list.getMockImplementation();
  yc.list.mockImplementation(async (salon, path, params) => {
    if (path.includes('/staff/')) return [
      { id: 1, specialization: 'Врач', hidden: 1, bookable: false },
      { id: 2, position: { title: 'Администратор-регистратор' } },
      { id: 3, specialization: 'Косметолог' },
    ];
    if (path.includes('/schedule/30/3/')) return [{ date: '2030-04-01', is_working: 0, slots: [] }];
    return original(salon, path, params);
  });
  const result = await service.day(3, '2030-04-01');
  expect(result.staff.map(s => [s.id, s.working])).toEqual([[1,true],[3,false]]);
  expect(result.staff[0].workRanges).toEqual([{ start: 540, end: 720 }]);
  expect(yc.list.mock.calls.some(([,path]) => path.includes('/schedule/30/2/'))).toBe(false);
});
test('schedule load failure does not silently mark staff off-duty', async () => {
  const original = yc.list.getMockImplementation();
  yc.list.mockImplementation(async (salon, path, params) => {
    if (path.includes('/schedule/')) throw new Error('synthetic upstream error');
    return original(salon, path, params);
  });
  await expect(service.day(3, '2030-04-01')).rejects.toThrow();
});
test('journal day uses internal services without fetching remote service catalog', async () => {
 const result=await service.day(3,'2030-04-01');
 expect(result.serviceSource).toBe('internal');expect(result.services[0]).toMatchObject({id:70,title:'Local'});
 expect(localCatalog.forJournal).toHaveBeenCalledWith(3);
 expect(yc.list.mock.calls.some(([,path])=>path.includes('/company/'))).toBe(false);
});
test('internal booking IDs map to YClients only at integration boundary', async () => {
 localCatalog.resolve.mockResolvedValue([{id:70,yclients_id:7,title:'Local',duration:45,price_min:900,staff:[{id:1}]}]);
 const d={operationId,action:'create',date:'2030-04-01',time:'10:00',staffId:1,serviceIds:[70],serviceSource:'internal',clientName:'Synthetic',clientPhone:'70000000000',comment:''};
 await service.mutate(3,4,d);
 expect(localCatalog.resolve).toHaveBeenCalledWith(expect.objectContaining({id:3}),[70]);
 expect(yc.write.mock.calls[0][2]).toMatchObject({services:[{id:7,cost:900}],seance_length:2700});
});
test('unmapped local service fails before a booking side effect', async () => {
 localCatalog.resolve.mockRejectedValue(new m.JournalError(409,'Unmapped'));
 await expect(service.mutate(3,4,{operationId,action:'create',date:'2030-04-01',time:'10:00',staffId:1,serviceIds:[70],serviceSource:'internal'})).rejects.toThrow('Unmapped');
 expect(yc.write).not.toHaveBeenCalled();
});

test('quantity extends verified booking duration and quoted prices cross integration boundary', async () => {
 localCatalog.resolve.mockResolvedValue([{id:70,yclients_id:7,title:'Local',duration:20,price_min:900,staff:[{id:1}]}]);
 const line={serviceId:70,quantity:2,unitPrice:100,discount:10,gross:200,total:180,mode:'discount'};
 const d={operationId,action:'create',date:'2030-04-01',time:'10:00',staffId:1,serviceIds:[70],serviceSource:'internal',lines:[line],clientName:'Synthetic',clientPhone:'70000000000',comment:''};
 const slots=await service.slots(3,{...d,lines:undefined,quantities:{70:2}});expect(slots.duration).toBe(40);
 await service.mutate(3,4,d);expect(yc.write.mock.calls[0][2]).toMatchObject({seance_length:2400,services:[{id:7,amount:2,cost_per_unit:100,first_cost:200,discount:10,cost:180}]});
});
test('confirmed journal payment blocks changing its visit even before paid flag sync',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.includes("state='confirmed'")&&sql.includes('journal_financial_transactions')?Promise.resolve({rows:[{operation_id:operationId}]}):original(sql,args));
 await expect(service.mutate(3,4,draft())).rejects.toThrow('проведённые оплаты');expect(yc.write).not.toHaveBeenCalled();
});

test('pending payment on another visit does not block creation or touch financial history',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.includes('journal_financial_transactions')?Promise.resolve({rows:[{operation_id:'pending-other'}]}):original(sql,args));
 const d={operationId,action:'create',date:'2030-04-01',time:'10:00',staffId:1,serviceIds:[7],clientName:'Synthetic',clientPhone:'70000000000',comment:''};
 expect(await service.mutate(3,4,d)).toEqual({recordId:8});expect(yc.write).toHaveBeenCalledTimes(1);
 expect(conn.query.mock.calls.some(([sql])=>sql.includes('journal_financial_transactions'))).toBe(false);
});
test('pending payment guards only the same tenant, company and visit before booking write',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.includes('journal_financial_transactions')&&sql.includes("state='pending'")?Promise.resolve({rows:args[0]===3&&args[1]===8&&Number(args[2])===30?[{operation_id:'pending'}]:[]}):original(sql,args));
 await expect(service.mutate(3,4,draft())).rejects.toMatchObject({code:'payment_pending'});expect(yc.write).not.toHaveBeenCalled();
 expect(conn.query).toHaveBeenCalledWith(expect.stringContaining('yclients_record_id=$2 AND yclients_company_id=$3'),[3,8,30]);
});
test('editing a different visit remains allowed while another payment is pending',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.includes('journal_financial_transactions')&&sql.includes("state='pending'")?Promise.resolve({rows:args[1]===99?[{operation_id:'pending-other'}]:[]}):original(sql,args));
 expect(await service.mutate(3,4,draft())).toEqual({recordId:8});expect(yc.write).toHaveBeenCalledTimes(1);
});

test.each([-1,0,1,2])('edit status %s preserves duration, services and client', async attendance => {
  await service.mutate(3,4,{...draft(),action:'edit',edit:{attendance}});
  expect(yc.write.mock.calls[0][2]).toMatchObject({attendance,seance_length:3600,services:record.services,client:record.client});
});
test('edit reprices an arrived unpaid visit', async () => {
  const arrived={...record,attendance:1};yc.getRecord.mockResolvedValue(arrived);
  await service.mutate(3,4,{...draft(),version:m.revision(arrived),action:'edit',edit:{lines:[{serviceId:7,quantity:1,unitPrice:1000,discount:15}]}});
  expect(yc.write.mock.calls[0][2].services[0]).toMatchObject({cost:850,first_cost:1000,discount:15});
});
test('edit stale form fails before external write', async () => {
  await expect(service.mutate(3,4,{...draft(),action:'edit',edit:{servicesVersion:'0'.repeat(64),lines:[{serviceId:Number(record.services?.[0]?.id||1),quantity:1,unitPrice:100,discount:0}]}})).rejects.toMatchObject({code:'edit_conflict'});
  expect(yc.write).not.toHaveBeenCalled();
});
test('edit paid visit remains blocked', async () => {
  const paid={...record,paid_amount:100};yc.getRecord.mockResolvedValue(paid);
  await expect(service.mutate(3,4,{...draft(),version:m.revision(paid),action:'edit',edit:{attendance:0}})).rejects.toThrow('оплаты');
  expect(yc.write).not.toHaveBeenCalled();
});

test('removed cash and bonus receipts no longer block status edits', async () => {
 const original=conn.query.getMockImplementation();
 const ledger=['account','loyalty_card'].flatMap(method=>[
  {action:'payment',method,external_ids:[51]},
  {action:'remove',method,external_ids:[51]},
 ]);
 conn.query.mockImplementation((sql,args)=>sql.includes("state='confirmed'")&&sql.includes('journal_financial_transactions')?Promise.resolve({rows:ledger}):original(sql,args));
 await service.mutate(3,4,{...draft(),action:'edit',edit:{attendance:1}});
 expect(yc.write).toHaveBeenCalledTimes(1);
 expect(yc.write.mock.calls[0][2]).toMatchObject({attendance:1,services:record.services});
 const query=conn.query.mock.calls.find(([sql])=>sql.includes('SELECT action, method'));
 expect(query[1]).toEqual([3,8,30]);
});

describe('parity fields (12.11.2026)', () => {
  test('day carries the salon label list, normalised', async () => {
    const base = yc.list.getMockImplementation();
    yc.list.mockImplementation(async (s, path) => path === '/labels/30' ? [{ id: 3, title: 'VIP', color: 'FF0000' }] : base(s, path));
    const out = await service.day(3, '2030-04-01');
    expect(out.labels).toEqual([{ id: 3, title: 'VIP', color: '#ff0000' }]);
  });
  test('day survives a labels failure with an empty list', async () => {
    const base = yc.list.getMockImplementation();
    yc.list.mockImplementation(async (s, path) => { if (path === '/labels/30') throw new Error('boom'); return base(s, path); });
    expect((await service.day(3, '2030-04-01')).labels).toEqual([]);
  });
  test('availability: explicit duration and the record technical break', async () => {
    const salon = { id: 3, yclients_company_id: 30 };
    const src = require('./services/journal/sources').live(salon);
    const out = await service.availability(salon, { staffId: 1, date: '2030-04-01', time: '09:00', durationOverride: 90, technicalBreak: 1800 }, record, src);
    expect(out.duration).toBe(90);
    expect(out.slots).toContain('09:00');
    expect(out.slots).toContain('10:00');     // 10:00 + 90 + 30 = 12:00
    expect(out.slots).not.toContain('10:05');
    const plain = await service.availability(salon, { staffId: 1, date: '2030-04-01', time: '09:00' }, { ...record, technical_break_duration: 600 }, src);
    expect(plain.duration).toBe(60);
    expect(plain.slots).toContain('10:50');   // 60 + 10
    expect(plain.slots).not.toContain('10:55');
  });
  test('day survives a labels source that throws synchronously (review T2)', async () => {
    const src = { kind: 'live', staff: async () => [], records: async () => [], schedule: async () => [], labels: () => { throw new Error('sync'); } };
    expect((await service.day(3, '2030-04-01', src)).labels).toEqual([]);
  });
  test('card (detail) carries the client phone', async () => {
    yc.getRecord.mockResolvedValue({ ...structuredClone(record), client: { id: 5, name: 'Тест', phone: '79200255591' } });
    expect((await service.detail(3, 8)).clientPhone).toBe('79200255591');
  });
});
