'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', YC: 'https://example.invalid/api', YCLIENTS_INTEGRATION_USER_TOKEN: 'synthetic-token' }));
jest.mock('axios', () => jest.fn());
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycHeaders: jest.fn(() => ({ Authorization: 'synthetic' })) }));
const axios = require('axios');
const { ycGet, ycHeaders } = require('./services/yclients');
const yc = require('./services/journal/yclients');
const salon = { id: 3, yclients_company_id: 30 };
beforeEach(() => jest.clearAllMocks());
test('reads every page, including days with more than 200 appointments', async () => {
  ycGet.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }))).mockResolvedValueOnce([{ id: 201 }]);
  expect(await yc.records(salon, '2030-04-01')).toHaveLength(201);
  expect(ycGet.mock.calls[1][2]).toMatchObject({ page: 2, start_date: '2030-04-01', end_date: '2030-04-01' });
});
test('ignoring pagination and foreign-company records fail closed', async () => {
  ycGet.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })));
  await expect(yc.records(salon, '2030-04-01')).rejects.toThrow();
  ycGet.mockResolvedValue([{ id: 1, company_id: 999 }]);
  await expect(yc.records(salon, '2030-04-01')).rejects.toThrow();
});
test('record IDs are verified inside authenticated company', async () => {
  ycGet.mockResolvedValue({ id: 8, company_id: 999 });
  await expect(yc.getRecord(salon, 8)).rejects.toThrow();
  expect(ycGet.mock.calls[0][1]).toBe('/record/30/8');
  expect(ycGet).toHaveBeenCalledWith(salon, '/record/30/8');
});
test('only payment reads request consumables; ordinary booking reads retain the original service shape', async () => {
  const record = { id: 8, company_id: 30, services: [{ id: 7 }] };
  ycGet.mockImplementation(async (_salon, _path, params) => params?.include_consumables === 1
    ? { ...record, services: [{ id: 7, staff_service_link: { id: 4 } }], goods_transactions: [] }
    : record);
  expect((await yc.getRecord(salon, 8)).services).toEqual([{ id: 7 }]);
  expect(ycGet).toHaveBeenNthCalledWith(1, salon, '/record/30/8');
  expect((await yc.getRecord(salon, 8, { includeConsumables: true })).goods_transactions).toEqual([]);
  expect(ycGet).toHaveBeenNthCalledWith(2, salon, '/record/30/8', { include_consumables: 1 });
});
test('writes use integration identity, no retry, and require confirmed ID', async () => {
  axios.mockResolvedValue({ data: { success: true, data: { id: 8 } } });
  expect(await yc.write(salon, null, { save_if_busy: false })).toEqual({ recordId: 8 });
  expect(axios.mock.calls[0][0]).toMatchObject({ method: 'post', url: 'https://example.invalid/api/records/30', timeout: 30000 });
  expect(ycHeaders).toHaveBeenCalledWith({ ...salon, yclients_user_token: 'synthetic-token' });
  axios.mockRejectedValue(new Error('synthetic failure'));
  await expect(yc.write(salon, 8, {})).rejects.toThrow();
  expect(axios).toHaveBeenCalledTimes(2);
  axios.mockResolvedValue({ data: { success: true, data: {} } });
  await expect(yc.write(salon, null, {})).rejects.toThrow();
});
test('additive migration declares tenant primary key and no patient payload', () => {
  const { JOURNAL_DDL } = require('./migrations');
  expect(JOURNAL_DDL).toContain('CREATE TABLE IF NOT EXISTS');
  expect(JOURNAL_DDL).toContain('PRIMARY KEY (salon_id, operation_id)');
  expect(JOURNAL_DDL).not.toMatch(/phone|client_name|DROP|DELETE FROM/i);
});

test('payment adapter uses documented sale endpoint and performs one POST only', async () => {
 const state={items:[],payment_transactions:[],loyalty_transactions:[]};
 axios.mockResolvedValue({data:{success:true,data:{state,payment_methods:[]}}});
 expect((await yc.pay(salon,80,{slug:'loyalty_card',loyalty_card_id:10},30)).state).toEqual(state);
 expect(axios.mock.calls[0][0]).toMatchObject({method:'post',url:'https://example.invalid/api/company/30/sale/80/payment',data:{payment:{method:{slug:'loyalty_card',loyalty_card_id:10},amount:30}}});
 axios.mockRejectedValue(new Error('timeout'));await expect(yc.pay(salon,80,{slug:'loyalty_card',loyalty_card_id:10},30)).rejects.toThrow();expect(axios).toHaveBeenCalledTimes(2);
});
test('incomplete sale state is rejected before exposing payment options', async () => {
 ycGet.mockResolvedValue({state:{items:[]},payment_methods:[]});await expect(yc.getSale(salon,80)).rejects.toThrow();
});

test.each([['account','payment_transaction'],['loyalty_card','loyalty_transaction']])('deletes %s transaction through sale API once',async(method,kind)=>{
 axios.mockResolvedValue({data:{success:true,data:{state:{payment_transactions:[],loyalty_transactions:[]}}}});
 await yc.removePayment(salon,80,method,90);
 expect(axios).toHaveBeenCalledWith(expect.objectContaining({method:'delete',url:`https://example.invalid/api/company/30/sale/80/payment/${kind}/90`,timeout:30000}));
 expect(axios).toHaveBeenCalledTimes(1);
});

test('cash and card use the same sale payment POST and never re-send the visit',async()=>{
 const state={items:[],payment_transactions:[],loyalty_transactions:[]};
 axios.mockResolvedValue({data:{success:true,data:{state,payment_methods:[]}}});
 await yc.pay(salon,80,{slug:'account',account_id:9},70);
 expect(axios).toHaveBeenCalledTimes(1);
 expect(axios.mock.calls[0][0]).toMatchObject({method:'post',url:'https://example.invalid/api/company/30/sale/80/payment',timeout:30000,data:{payment:{method:{slug:'account',account_id:9},amount:70}}});
 expect(JSON.stringify(axios.mock.calls[0][0].data)).not.toMatch(/services|goods|attendance|visits/);
 expect(ycHeaders).toHaveBeenCalledWith({ ...salon, yclients_user_token: 'synthetic-token' });
});
test('unknown or incomplete payment methods fail before HTTP',async()=>{
 for(const method of [{slug:'deposit'},{slug:'account'},{slug:'account',account_id:0},{slug:'loyalty_card'},null])await expect(yc.pay(salon,80,method,100)).rejects.toThrow();
 expect(axios).not.toHaveBeenCalled();
});
test('arrival mark re-sends the record as read with attendance 1 through the integration identity',async()=>{
 const record={id:8,company_id:30,staff_id:4,datetime:'2030-04-01T10:00:00+03:00',seance_length:3600,client:{id:5,name:'Synthetic',phone:'+70000000000'},comment:'',attendance:0,services:[{id:7,title:'Synthetic',amount:1,cost:100,first_cost:100,discount:0,cost_per_unit:100}]};
 axios.mockResolvedValue({data:{success:true,data:{id:8}}});
 await yc.markArrived(salon,record);
 expect(axios).toHaveBeenCalledTimes(1);
 expect(axios.mock.calls[0][0]).toMatchObject({method:'put',url:'https://example.invalid/api/record/30/8',data:{staff_id:4,services:record.services,client:record.client,datetime:record.datetime,seance_length:3600,comment:'',attendance:1,save_if_busy:false,send_sms:false}});
 expect(yc.prepareAccountPayment).toBeUndefined();expect(yc.payAccount).toBeUndefined();
});
