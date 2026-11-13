'use strict';
jest.mock('./config',()=>({JWT_SECRET:'synthetic-test-secret',JOURNAL_ACCOUNT_PAYMENTS_ENABLED:true}));
jest.mock('./logger',()=>{const logger={warn:jest.fn()};return {createLogger:()=>logger};});
jest.mock('./db',()=>({db:{oneOrNone:jest.fn(),any:jest.fn(),query:jest.fn()},pool:{connect:jest.fn()}}));
jest.mock('./services/journal/yclients',()=>({getRecord:jest.fn(),getSale:jest.fn(),pay:jest.fn(),removePayment:jest.fn(),markArrived:jest.fn()}));
const {db,pool}=require('./db'),yc=require('./services/journal/yclients'),p=require('./services/journal/payments'),m=require('./services/journal/model');
const logger=require('./logger').createLogger();
const key='12345678-1234-4123-8123-123456789012';
let sale,conn,prior,pending,record;
beforeEach(()=>{
 jest.clearAllMocks();prior=null;pending=false;
 record={id:8,company_id:30,visit_id:800,staff_id:4,datetime:'2030-04-01T10:00:00+03:00',seance_length:3600,comment:'',client:{id:5,name:'Synthetic'},services:[{id:7,title:'Synthetic service',amount:1,cost:100,manual_cost:100,cost_per_unit:100,first_cost:100,discount:0}],goods_transactions:[],attendance:1,documents:[{id:80,type_id:7,company_id:30,record_id:8,visit_id:800}]};
 sale={state:{items:[{id:7,title:'Synthetic',amount:1,cost_to_pay_total:100}],payment_transactions:[],loyalty_transactions:[]},payment_methods:[{slug:'account',account_id:9,is_applicable:true,applicable_amount:100,account:{title:'Synthetic account',is_cash:true}},{slug:'loyalty_card',loyalty_card_id:10,is_applicable:true,applicable_amount:30,loyalty_card:{balance:30}}]};
 db.oneOrNone.mockResolvedValue({id:3,yclients_company_id:30});db.any.mockResolvedValue([]);db.query.mockResolvedValue({});
 p._setSettleMs(0);
 yc.markArrived.mockImplementation(async()=>{record.attendance=1;});
 yc.getRecord.mockImplementation(async()=>structuredClone(record));yc.getSale.mockImplementation(async()=>structuredClone(sale));
 yc.pay.mockImplementation(async(_,__,method,amount)=>{
  if(method.slug==='account')sale.state.payment_transactions.push({id:90,account_id:method.account_id,amount});
  else sale.state.loyalty_transactions.push({id:91,type_id:3,loyalty_card_id:method.loyalty_card_id,amount});
  return structuredClone(sale);
 });
 conn={release:jest.fn(),query:jest.fn(async sql=>{
  if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked:true}]};
  if(sql.includes('SELECT * FROM journal_financial_transactions'))return{rows:prior?[prior]:[]};
  if(sql.includes("state='pending' LIMIT 1")&&sql.includes('journal_financial_transactions'))return{rows:pending?[{operation_id:key}]:[]};
  return{rows:[]};
 })};pool.connect.mockResolvedValue(conn);
});
async function draft(patch={}) {const c=await p.context(3,8);return {operationId:key,recordId:8,method:'account',methodId:9,amount:100,version:c.version,...patch};}
test('payment intent is durable before external effect and tenant-scoped receipt after it',async()=>{
 yc.pay.mockImplementation(async()=>{expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO journal_financial_transactions'))).toBe(true);sale.state.payment_transactions=[{id:90,account_id:9,amount:100}];return structuredClone(sale);});
 const d=await draft();expect(await p.pay(3,4,d)).toMatchObject({confirmed:true,recordId:8});
 const insert=conn.query.mock.calls.find(([sql])=>sql.startsWith('INSERT'));expect(insert[1].slice(0,6)).toEqual([3,key,4,30,8,80]);
 expect(yc.pay).toHaveBeenCalledWith(expect.objectContaining({id:3}),80,{slug:'account',account_id:9},100);
 expect(yc.markArrived).not.toHaveBeenCalled();
 expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("state='confirmed'"),[3,key,'[90]']);
 expect(conn.release).toHaveBeenCalledWith(false);
});
test('confirmed exact replay performs no external payment, changed payload cannot reuse key',async()=>{
 const d=await draft();prior={request_hash:m.fingerprint(d),state:'confirmed',yclients_record_id:8,yclients_company_id:30,document_id:80,method:'account',method_id:9,amount:100,before_ids:[],external_ids:[90]};sale.state.payment_transactions=[{id:90,account_id:9,amount:100}];
 expect(await p.pay(3,4,d)).toMatchObject({duplicate:true});expect(yc.pay).not.toHaveBeenCalled();
 await expect(p.pay(3,4,{...d,amount:90})).rejects.toThrow('Ключ');
});
test('pending operation across fresh keys blocks new payment for the same visit',async()=>{pending=true;await expect(p.pay(3,4,await draft())).rejects.toThrow('неподтверждённая');await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'blocked_pending'});expect(yc.pay).not.toHaveBeenCalled();});
test('stale state and excessive or foreign payment method fail before intent',async()=>{
 for(const patch of [{version:'a'.repeat(64)},{amount:101},{methodId:99},{method:'loyalty_card',methodId:10,amount:31}])await expect(p.pay(3,4,await draft(patch))).rejects.toThrow();
 expect(yc.pay).not.toHaveBeenCalled();expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('timeout leaves pending marker and cannot be retried under same operation',async()=>{
 const d=await draft();yc.pay.mockRejectedValue(new Error('timeout'));
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
 prior={request_hash:m.fingerprint(d),state:'pending',yclients_record_id:8};
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});expect(yc.pay).toHaveBeenCalledTimes(1);
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("state='rejected'"))).toBe(false);
});
test('definite validation rejection is recorded; failed pending insert never sends funds',async()=>{
 yc.pay.mockRejectedValue({response:{status:422}});await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'rejected'});
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("state='rejected'"))).toBe(true);
 yc.pay.mockClear();const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.startsWith('INSERT')?Promise.reject(new Error('db failure')):original(sql,args));
 await expect(p.pay(3,4,await draft())).rejects.toThrow('db failure');expect(yc.pay).not.toHaveBeenCalled();
});
test('receipt ignores old transactions, other cards, and accruals; sum must match',()=>{
 const row={method:'loyalty_card',method_id:10,amount:30,before_ids:[1]};
 sale.state.loyalty_transactions=[{id:1,type_id:3,loyalty_card_id:10,amount:50},{id:2,type_id:2,loyalty_card_id:10,amount:100},{id:3,type_id:3,loyalty_card_id:99,amount:30},{id:4,type_id:3,loyalty_card_id:10,amount:30}];
 expect(p.receipt(sale,row)).toEqual([4]);expect(()=>p.receipt(sale,{...row,amount:31})).toThrow();
});
test('bonus payment delegates withdrawal once and never changes local balances',async()=>{
 await p.pay(3,4,await draft({method:'loyalty_card',methodId:10,amount:30}));
 expect(yc.pay).toHaveBeenCalledWith(expect.anything(),80,{slug:'loyalty_card',loyalty_card_id:10},30);
 await p.options(3,8);
 const writes=[...db.query.mock.calls,...conn.query.mock.calls].map(([sql])=>sql).join('\n');
 expect(writes).not.toMatch(/UPDATE clients|INSERT INTO loyalty_card_transactions|INSERT INTO bonus_transactions/);
 expect(writes).toContain('b.salon_id=f.salon_id');expect(writes).toContain('bonus_transaction_id=b.id');
});
test('document ownership and cancelled records fail closed',async()=>{
 record.documents[0].company_id=99;await expect(p.context(3,8)).rejects.toThrow();expect(yc.getSale).not.toHaveBeenCalled();
 record.documents[0].company_id=30;record.deleted=true;await expect(p.context(3,8)).rejects.toThrow();
});
test('owner review confirms receipt read-only; cannot clear operation if new payment exists',async()=>{
 prior={operation_id:key,method:'account',method_id:9,amount:100,before_ids:[],yclients_record_id:8,yclients_company_id:30,document_id:80};sale.state.payment_transactions=[{id:90,account_id:9,amount:100}];
 await expect(p.review(3,4,{operationId:key,checkedInYclients:true,outcome:'not_applied'})).rejects.toThrow('новые');
 expect(await p.review(3,4,{operationId:key,checkedInYclients:true,outcome:'confirmed'})).toEqual({reviewed:true});expect(yc.pay).not.toHaveBeenCalled();
});
test('parse rejects negative amounts, arbitrary methods and invalid operation keys',()=>{
 const b={operationId:key,recordId:8,method:'account',methodId:9,amount:'1.23',version:'a'.repeat(64)};
 expect(p.parse(b).amount).toBe(1.23);
 for(const patch of [{amount:0},{amount:-1},{amount:'1.001'},{method:'deposit'},{methodId:0},{version:''},{operationId:'bad'}])expect(()=>p.parse({...b,...patch})).toThrow();
});
test('arrival consent is explicit, restricted to cash creation and preserves old request hashes when absent',()=>{
 const b={operationId:key,recordId:8,method:'account',methodId:9,amount:100,version:'a'.repeat(64)};
 expect(p.parse(b)).toEqual(b);expect(p.parse({...b,confirmArrival:false})).toEqual(b);
 expect(p.parse({...b,confirmArrival:true})).toEqual({...b,confirmArrival:true});
 for(const patch of [{confirmArrival:'true'},{confirmArrival:1},{confirmArrival:true,method:'loyalty_card'},{confirmArrival:true,action:'remove',transactionId:90}])expect(()=>p.parse({...b,...patch})).toThrow();
});
test('waiting visits require explicit arrival consent before an intent or payment is sent',async()=>{
 record.attendance=0;
 const options=await p.options(3,8);
 expect(options.methods.find(v=>v.method==='account').requiresArrivalConfirmation).toBe(true);
 expect(options.methods.find(v=>v.method==='loyalty_card').requiresArrivalConfirmation).toBe(false);
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'arrival_confirmation_required'});
 expect(yc.markArrived).not.toHaveBeenCalled();expect(yc.pay).not.toHaveBeenCalled();
 expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 expect(record.attendance).toBe(0);
});
test('explicit arrival consent changes only the expected attendance and confirms the real receipt',async()=>{
 record.attendance=0;const originalServices=structuredClone(record.services);
 await expect(p.pay(3,4,await draft({confirmArrival:true}))).resolves.toMatchObject({confirmed:true});
 expect(yc.markArrived).toHaveBeenCalledTimes(1);expect(yc.pay).toHaveBeenCalledTimes(1);expect(record.attendance).toBe(1);expect(record.services).toEqual(originalServices);
 // Arrival precedes the payment intent; the payment itself is the sale POST.
 const insertAt=conn.query.mock.invocationCallOrder[conn.query.mock.calls.findIndex(([sql])=>sql.startsWith('INSERT'))];
 expect(yc.markArrived.mock.invocationCallOrder[0]).toBeLessThan(insertAt);
 expect(yc.pay.mock.invocationCallOrder[0]).toBeGreaterThan(insertAt);
});
test('migration creates scoped durable journal with links to visits and bonus ledger',()=>{const {JOURNAL_FINANCE_DDL}=require('./migrations');expect(JOURNAL_FINANCE_DDL).toContain('PRIMARY KEY(salon_id,operation_id)');expect(JOURNAL_FINANCE_DDL).toContain('REFERENCES records(id)');expect(JOURNAL_FINANCE_DDL).toContain('REFERENCES loyalty_card_transactions(id)');expect(JOURNAL_FINANCE_DDL).not.toMatch(/DROP|TRUNCATE/);});

test('removal validates live membership and amount before a durable intent',async()=>{
 sale.state.payment_transactions=[{id:90,account_id:9,amount:100}];
 const d=await draft({action:'remove',transactionId:90});
 yc.removePayment.mockImplementation(async()=>{sale={...sale,state:{...sale.state,payment_transactions:[]}};return sale;});
 expect(await p.pay(3,4,d)).toMatchObject({confirmed:true});
 expect(yc.removePayment).toHaveBeenCalledWith(expect.objectContaining({id:3}),80,'account',90);
 expect(yc.pay).not.toHaveBeenCalled();
 const insert=conn.query.mock.calls.find(([sql])=>sql.startsWith('INSERT'));
 expect(insert[1].slice(-2)).toEqual(['remove',90]);
 await expect(p.pay(3,4,{...d,transactionId:91})).rejects.toMatchObject({code:'stale'});
 await expect(p.pay(3,4,{...d,amount:99})).rejects.toMatchObject({code:'stale'});
 expect(yc.removePayment).toHaveBeenCalledTimes(1);
});
test('bonus deletion verifies disappearance and preserves pending on timeout',async()=>{
 sale.state.loyalty_transactions=[{id:91,type_id:3,loyalty_card_id:10,amount:30}];
 const d=await draft({action:'remove',transactionId:91,method:'loyalty_card',methodId:10,amount:30});
 yc.removePayment.mockResolvedValue(sale);
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
 yc.removePayment.mockRejectedValue(new Error('timeout'));
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("SET state='confirmed'"))).toBe(false);
});
test('options show external cash and bonus redemptions but omit accruals',async()=>{
 sale.state.payment_transactions=[{id:90,account_id:9,amount:70,account:{title:'Cash'}}];
 sale.state.loyalty_transactions=[{id:91,type_id:3,loyalty_card_id:10,amount:30},{id:92,type_id:2,loyalty_card_id:10,amount:7}];
 sale.payment_methods[0].applicable_amount=0;
 const result=await p.options(3,8);
 expect(result.paid.map(t=>[t.method,t.amount])).toEqual([['account',70],['loyalty_card',30]]);
 expect(result.due).toBe(0);
});
test('removal review cannot dismiss an absent transaction as not applied',async()=>{
 prior={operation_id:key,action:'remove',method:'account',method_id:9,amount:100,before_ids:[90],target_transaction_id:90,yclients_record_id:8,yclients_company_id:30,document_id:80};
 await expect(p.review(3,4,{operationId:key,checkedInYclients:true,outcome:'not_applied'})).rejects.toThrow('удалена');
 expect(await p.review(3,4,{operationId:key,checkedInYclients:true,outcome:'confirmed'})).toEqual({reviewed:true});
});

test('cash payment of an arrived visit is one sale POST and is independently read before confirming',async()=>{
 const d=await draft();expect(await p.pay(3,4,d)).toMatchObject({confirmed:true});
 expect(yc.pay).toHaveBeenCalledTimes(1);expect(yc.markArrived).not.toHaveBeenCalled();
 expect(yc.getSale.mock.invocationCallOrder.at(-1)).toBeGreaterThan(yc.pay.mock.invocationCallOrder[0]);
 expect(yc.getRecord.mock.invocationCallOrder.at(-1)).toBeGreaterThan(yc.pay.mock.invocationCallOrder[0]);
 expect(yc.getRecord.mock.calls.every(([,id,options])=>id===8&&options?.includeConsumables===true)).toBe(true);
});
test('a successful response without the cash transaction stays pending, never confirms',async()=>{
 yc.pay.mockResolvedValue(structuredClone(sale));
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'uncertain'});
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("state='confirmed',external_ids"))).toBe(false);
 expect(yc.pay).toHaveBeenCalledTimes(1);
});
test('YClients rollback after the response (visit back to waiting, transaction deleted) is never confirmed',async()=>{
 yc.pay.mockImplementation(async(_,__,method,amount)=>{const r=structuredClone(sale);r.state.payment_transactions.push({id:90,account_id:method.account_id,amount});record.attendance=0;return r;});
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'uncertain'});
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("SET state='confirmed'"))).toBe(false);
 expect(logger.warn).toHaveBeenCalledWith('Payment verification failed '+JSON.stringify({stage:'record_integrity',method:'account',action:'payment',upstream_status:null}));
});
test('readback waits past the rollback window after a cash payment',async()=>{
 p._setSettleMs(40);let paidAt=0;
 yc.pay.mockImplementation(async(_,__,method,amount)=>{paidAt=Date.now();sale.state.payment_transactions.push({id:90,account_id:method.account_id,amount});return structuredClone(sale);});
 const read=yc.getRecord.getMockImplementation();let readAt=0;yc.getRecord.mockImplementation(async(...a)=>{readAt=Date.now();return structuredClone(record);});
 expect(await p.pay(3,4,await draft())).toMatchObject({confirmed:true});
 expect(readAt-paidAt).toBeGreaterThanOrEqual(35);
});
test('confirmed replay after another partial payment checks only its recorded receipt',async()=>{
 const d=await draft();prior={request_hash:m.fingerprint(d),state:'confirmed',yclients_record_id:8,yclients_company_id:30,document_id:80,method:'account',method_id:9,amount:100,before_ids:[],external_ids:[90]};
 sale.state.payment_transactions=[{id:90,account_id:9,amount:100},{id:91,account_id:9,amount:25}];
 expect(await p.pay(3,4,d)).toMatchObject({duplicate:true});expect(yc.pay).not.toHaveBeenCalled();
 prior.document_id=81;await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
});
test('historical local success missing from YClients is exposed as unverified and blocks UI',async()=>{
 db.any.mockImplementation(async sql=>sql.includes('ORDER BY created_at DESC')?[{operation_id:key,method:'account',action:'payment',state:'confirmed',external_ids:[90],amount:100}]:[]);
 const d=await p.options(3,8);expect(d.history[0].state).toBe('unverified');expect(d.pending).toHaveLength(1);expect(d.paid).toEqual([]);
});

test('payment options only include pending operations for the requested company and visit',async()=>{
 db.any.mockImplementation(async(sql,args)=>{
  if(sql.includes("state='pending'")){
   expect(sql).toContain('yclients_record_id=$2 AND yclients_company_id=$3');
   expect(args).toEqual([3,8,30]);return [];
  }
  return [];
 });
 const result=await p.options(3,8);expect(result.pending).toEqual([]);expect(result.methods[0].available).toBe(true);
});
test('unresolved payment on another visit does not block payment on a new visit',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>{
  if(sql.includes("state='pending' LIMIT 1")&&sql.includes('journal_financial_transactions')){
   expect(sql).toContain('yclients_record_id=$2 AND yclients_company_id=$3');
   expect(args).toEqual([3,8,30]);return Promise.resolve({rows:args[1]===99?[{operation_id:'other'}]:[]});
  }
  if(sql.includes("state='pending' LIMIT 1")&&sql.includes('journal_operations')){
   expect(sql).toContain('record_id=$2');expect(args).toEqual([3,8]);return Promise.resolve({rows:[]});
  }
  return original(sql,args);
 });
 expect(await p.pay(3,4,await draft())).toMatchObject({confirmed:true});expect(yc.pay).toHaveBeenCalledTimes(1);
});
test('an unresolved edit of this same visit still prevents payment',async()=>{
 const original=conn.query.getMockImplementation();conn.query.mockImplementation((sql,args)=>sql.includes('FROM journal_operations')&&args[1]===8?Promise.resolve({rows:[{operation_id:'edit'}]}):original(sql,args));
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'blocked_pending'});expect(yc.pay).not.toHaveBeenCalled();
});

test('cash payments are disabled before any external write during containment',async()=>{
 const config=require('./config');config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED=false;
 try{await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'payment_disabled'});expect(yc.pay).not.toHaveBeenCalled();const d=await p.options(3,8);expect(d.methods.find(m=>m.method==='account').available).toBe(false);expect(d.methods.find(m=>m.method==='loyalty_card').available).toBe(true);}finally{config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED=true;}
});

test('payment diagnostics distinguish upstream rejection without logging response or request data',async()=>{
 const d=await draft();
 yc.pay.mockRejectedValue({response:{status:422,data:{message:'synthetic-private-response'}},config:{headers:{Authorization:'synthetic-private-header'}},message:'synthetic-private-error'});
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'rejected'});
 expect(logger.warn).toHaveBeenCalledWith('Payment verification failed '+JSON.stringify({stage:'sale_write',method:'account',action:'payment',upstream_status:422}));
 expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('synthetic-private');
});

test.each(['removed_bonus','added_bonus','another_account'])('unexpected %s stays pending without another payment',async change=>{
 sale.state.loyalty_transactions=[{id:91,type_id:3,loyalty_card_id:10,amount:30}];
 yc.pay.mockImplementation(async()=>{
  sale.state.payment_transactions=[{id:90,account_id:9,amount:100}];
  if(change==='removed_bonus')sale.state.loyalty_transactions=[];
  if(change==='added_bonus')sale.state.loyalty_transactions.push({id:92,type_id:3,loyalty_card_id:10,amount:2});
  if(change==='another_account')sale.state.payment_transactions.push({id:92,account_id:99,amount:2});
  const response=structuredClone(sale);response.state.payment_transactions=[{id:90,account_id:9,amount:100}];return response;
 });
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'uncertain'});
 expect(logger.warn).toHaveBeenCalledWith('Payment verification failed '+JSON.stringify({stage:'prior_payments',method:'account',action:'payment',upstream_status:null}));
 expect(conn.query.mock.calls.some(([sql])=>sql.includes("SET state='confirmed'")||sql.includes("SET state='rejected'"))).toBe(false);
 expect(yc.pay).toHaveBeenCalledTimes(1);
});

test.each(['record_integrity','sale_readback','saved_receipt','local_confirmation'])('diagnostics identify %s failure without altering uncertain handling',async stage=>{
 const d=await draft();
 if(stage==='record_integrity')yc.pay.mockImplementation(async(_,__,method,amount)=>{sale.state.payment_transactions.push({id:90,account_id:9,amount});record.deleted=true;return structuredClone(sale);});
 if(stage==='sale_readback')yc.getSale.mockResolvedValueOnce(structuredClone(sale)).mockResolvedValueOnce(structuredClone(sale)).mockRejectedValueOnce({status:503,body:'synthetic-private-body'});
 if(stage==='saved_receipt'){
  yc.pay.mockImplementation(async(_,__,method,amount)=>{const r=structuredClone(sale);r.state.payment_transactions.push({id:90,account_id:9,amount});return r;});
 }
 if(stage==='local_confirmation'){
  const query=conn.query.getMockImplementation();
  conn.query.mockImplementation((sql,args)=>sql.includes("SET state='confirmed'")?Promise.reject(new Error('synthetic-private-database-error')):query(sql,args));
 }
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
 expect(logger.warn).toHaveBeenCalledTimes(1);
 const details=JSON.parse(logger.warn.mock.calls[0][0].slice('Payment verification failed '.length));
 expect(details.stage).toBe(stage);
 if(stage==='sale_readback')expect(details.upstream_status).toBe(503);
 expect(JSON.stringify(details)).not.toContain('synthetic-private');
 expect(yc.pay).toHaveBeenCalledTimes(1);
});

test('a stale comment cannot be overwritten by payment and fails before intent',async()=>{
 const d=await draft();record.comment='Synthetic changed comment';
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'stale'});
 expect(yc.markArrived).not.toHaveBeenCalled();expect(yc.pay).not.toHaveBeenCalled();
 expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});

test('arrived visits with quantity, goods or consumables are paid without re-sending the visit',async()=>{
 record.services[0].amount=2;record.goods_transactions=[{id:1}];record.services[0].consumables=[{id:2}];
 const options=await p.options(3,8);
 expect(options.methods.find(x=>x.method==='account').available).toBe(true);
 expect(await p.pay(3,4,await draft())).toMatchObject({confirmed:true});
 expect(yc.markArrived).not.toHaveBeenCalled();expect(yc.pay).toHaveBeenCalledTimes(1);
});
test('a waiting visit that cannot be marked arrived automatically asks to mark arrival in YClients first',async()=>{
 record.attendance=0;record.services[0].amount=2;
 const options=await p.options(3,8),cash=options.methods.find(x=>x.method==='account');
 expect(cash.available).toBe(false);expect(cash.unavailableReason).toMatch(/Отметьте приход клиента в YClients/);
 expect(options.methods.find(x=>x.method==='loyalty_card').available).toBe(true);
 await expect(p.pay(3,4,await draft({confirmArrival:true}))).rejects.toMatchObject({code:'payment_unsupported'});
 expect(yc.markArrived).not.toHaveBeenCalled();expect(yc.pay).not.toHaveBeenCalled();expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('a failed arrival mark sends no payment and records no intent',async()=>{
 record.attendance=0;yc.markArrived.mockRejectedValue({response:{status:422}});
 await expect(p.pay(3,4,await draft({confirmArrival:true}))).rejects.toMatchObject({code:'arrival_failed'});
 expect(yc.pay).not.toHaveBeenCalled();expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('an arrival mark that changed anything but attendance stops before payment',async()=>{
 record.attendance=0;yc.markArrived.mockImplementation(async()=>{record.attendance=1;record.services=[];});
 await expect(p.pay(3,4,await draft({confirmArrival:true}))).rejects.toMatchObject({code:'stale'});
 expect(yc.pay).not.toHaveBeenCalled();expect(conn.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});
test('a bonus already applied to a waiting visit survives the arrival mark; cash then pays the rest',async()=>{
 record.attendance=0;sale.state.loyalty_transactions=[{id:91,type_id:3,loyalty_card_id:10,amount:30}];sale.payment_methods[0].applicable_amount=70;
 expect(await p.pay(3,4,await draft({amount:70,confirmArrival:true}))).toMatchObject({confirmed:true});
 expect(yc.pay).toHaveBeenCalledWith(expect.anything(),80,{slug:'account',account_id:9},70);
});
test('another unconfirmed operation blocks with blocked_pending; own pending key stays uncertain',async()=>{
 // A previously confirmed payment whose transaction vanished from YClients blocks a NEW operation.
 const original=conn.query.getMockImplementation();
 conn.query.mockImplementation((sql,args)=>sql.includes("state='confirmed'")&&sql.includes('SELECT method,action,external_ids')?Promise.resolve({rows:[{method:'account',action:'payment',external_ids:[555]}]}):original(sql,args));
 await expect(p.pay(3,4,await draft())).rejects.toMatchObject({code:'blocked_pending',message:'Предыдущая оплата не подтверждена в YClients. Сначала выполните сверку.'});
 expect(yc.pay).not.toHaveBeenCalled();
 conn.query.mockImplementation(original);
 const d=await draft();prior={request_hash:m.fingerprint(d),state:'pending',yclients_record_id:8};
 await expect(p.pay(3,4,d)).rejects.toMatchObject({code:'uncertain'});
});
