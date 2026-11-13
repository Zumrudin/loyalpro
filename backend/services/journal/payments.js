'use strict';
const {db,pool}=require('../../db');
const m=require('./model');
const pricing=require('./pricing');
const yc=require('./yclients');
const reference=require('./reference-cache');
const config=require('../../config');
const visitPayment=require('./visit-payment');
const logger=require('../../logger').createLogger('JournalPayments');
const accountPaymentsEnabled=()=>config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED===true;
// The arrival mark re-sends the record (PUT /record), verified only for the
// simple subset. Other waiting visits are marked in YClients first; after that
// the payment itself never re-sends visit contents.
const ARRIVAL_IN_YCLIENTS='Отметьте приход клиента в YClients — после этого оплату можно провести здесь.';
// YClients deletes a cash payment of a waiting visit ~0.3 s after creating it;
// the readback waits past that window so a rollback is never confirmed.
let settleMs=2000;
const settle=()=>new Promise(r=>setTimeout(r,settleMs));
function logPaymentFailure(stage,draft,error) {
 // Upstream exceptions contain authorization headers and patient payloads.
 // Log only fixed stage names, HTTP status and structural counts, never errors.
 const status=error instanceof m.JournalError?null:(error?.response?.status??error?.status);
 const details={stage,method:draft.method==='account'?'account':'loyalty_card',action:draft.action==='remove'?'remove':'payment',upstream_status:Number.isInteger(status)&&status>=100&&status<=599?status:null};
 try{logger.warn('Payment verification failed '+JSON.stringify(details));}catch(_){/* Logging must not change financial state or retry a write. */}
}
function parse(body) {
 if(!body||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId||'')) m.fail('Некорректный ключ оплаты.');
 if(body.action!==undefined&&!['payment','remove'].includes(body.action))m.fail('Неизвестная финансовая операция.');
 if(!['account','loyalty_card'].includes(body.method))m.fail('Способ оплаты не поддерживается.');
 if(body.confirmArrival!==undefined&&typeof body.confirmArrival!=='boolean')m.fail('Некорректное подтверждение прихода.');
 if(body.confirmArrival===true&&(body.method!=='account'||body.action==='remove'))m.fail('Подтверждение прихода доступно только при оплате в кассу.');
 if(!/^[a-f0-9]{64}$/.test(body.version||''))m.fail('Обновите форму оплаты.');
 let cents;try{cents=pricing.money(body.amount);}catch(e){m.fail(e.message);}
 if(cents<=0)m.fail('Сумма оплаты должна быть больше нуля.');
 return {...(body.action==='remove'?{action:'remove',transactionId:m.positiveId(body.transactionId)}:{}),...(body.confirmArrival===true?{confirmArrival:true}:{}),operationId:body.operationId,recordId:m.positiveId(body.recordId),method:body.method,methodId:m.positiveId(body.methodId),amount:cents/100,version:body.version};
}
function transactions(sale,method,id) {
 const rows=method==='account'?sale.state.payment_transactions:sale.state.loyalty_transactions;
 return rows.filter(t=>method==='account'?Number(t.account_id)===id:Number(t.loyalty_card_id||t.card_id)===id&&Number(t.type_id)===3);
}
function receipt(sale,row) {
 if(row.action==='remove'){
  if(transactions(sale,row.method,Number(row.method_id)).some(t=>Number(t.id)===Number(row.target_transaction_id)))m.fail('Удаление требует сверки в YClients.',409,'uncertain');
  return [Number(row.target_transaction_id)];
 }
 const prior=new Set(row.before_ids.map(String));
 const confirmed=row.state==='confirmed'?new Set((row.external_ids||[]).map(String)):null;
 const fresh=transactions(sale,row.method,Number(row.method_id)).filter(t=>confirmed?confirmed.has(String(t.id)):!prior.has(String(t.id)));
 const cents=fresh.reduce((n,t)=>n+Math.round(Number(t.amount)*100),0);
 if(!fresh.length||(confirmed&&fresh.length!==confirmed.size)||new Set(fresh.map(t=>Number(t.id))).size!==fresh.length||fresh.some(t=>!Number.isSafeInteger(Number(t.id))||Number(t.id)<=0||!Number.isFinite(Number(t.amount))||Number(t.amount)<=0)||cents!==Math.round(Number(row.amount)*100))m.fail('Результат оплаты требует сверки в YClients.',409,'uncertain');
 return fresh.map(t=>Number(t.id));
}
function assertPriorPayments(before,after,accountId) {
 const key=(t,loyalty)=>JSON.stringify([Number(t.id),Number(loyalty?(t.loyalty_card_id||t.card_id):t.account_id),Number(t.amount),loyalty?Number(t.type_id):null]);
 for(const [field,loyalty] of [['payment_transactions',false],['loyalty_transactions',true]]){
  const current=new Set(after.state[field].map(t=>key(t,loyalty)));
  if(before.state[field].filter(t=>!loyalty||Number(t.type_id)===3).some(t=>!current.has(key(t,loyalty))))m.fail('Предыдущие оплаты визита изменились. Нужна сверка.',409,'uncertain');
 }
 const bonusKeys=rows=>rows.filter(t=>Number(t.type_id)===3).map(t=>key(t,true)).sort();
 const previousCashIds=new Set(before.state.payment_transactions.map(t=>Number(t.id)));
 if(JSON.stringify(bonusKeys(before.state.loyalty_transactions))!==JSON.stringify(bonusKeys(after.state.loyalty_transactions))
   ||after.state.payment_transactions.some(t=>!previousCashIds.has(Number(t.id))&&Number(t.account_id)!==accountId))m.fail('Во время оплаты появились другие финансовые операции. Нужна сверка.',409,'uncertain');
}
async function context(salonId,recordId,allowCancelled=false) {
 const salon=await db.oneOrNone('SELECT * FROM salons WHERE id=$1',[salonId]);
 if(!salon?.yclients_company_id)m.fail('YClients не подключён.',409);
 const record=await yc.getRecord(salon,recordId,{includeConsumables:true});
 if(!allowCancelled&&(record.deleted||Number(record.attendance)===-1))m.fail('Отменённый визит нельзя оплатить.',409);
 const docs=(record.documents||[]).filter(d=>Number(d.type_id)===7&&(!d.company_id||Number(d.company_id)===Number(salon.yclients_company_id))&&(!d.record_id||Number(d.record_id)===recordId));
 if(docs.length!==1)m.fail('Документ оплаты ещё не готов или неоднозначен. Обновите форму после сохранения записи.',409);
 const documentId=m.positiveId(docs[0].id),sale=await yc.getSale(salon,documentId);
 const version=m.fingerprint([recordId,documentId,visitPayment.snapshot(record),sale.state,sale.payment_methods]);
 return {salon,record,documentId,sale,version};
}
async function linkReferences(salonId) {
 // Existing webhook/reconciliation owns the bonus ledger. Link its visit
 // redemption; never subtract the balance or insert a duplicate redemption here.
 await db.query(`UPDATE journal_financial_transactions f SET record_id=r.id,client_id=r.client_id
 FROM records r WHERE f.salon_id=$1 AND r.salon_id=f.salon_id AND r.yclients_record_id=f.yclients_record_id
 AND (f.record_id IS DISTINCT FROM r.id OR f.client_id IS DISTINCT FROM r.client_id)`,[salonId]);
 await db.query(`UPDATE journal_financial_transactions f SET bonus_transaction_id=b.id
 FROM loyalty_card_transactions b WHERE f.salon_id=$1 AND f.state='confirmed' AND f.action='payment' AND f.method='loyalty_card'
 AND f.bonus_transaction_id IS NULL AND b.salon_id=f.salon_id AND b.client_id=f.client_id
 AND b.record_id=f.record_id AND b.type='redemption' AND b.amount<0 AND b.yclients_card_id=f.method_id
 AND b.title=('Списание бонусов при оплате визита #' || f.yclients_record_id::text)`,[salonId]);
}
// Saving the record (arrival mark — ours or made in YClients) makes YClients
// re-create the visit's bonus write-offs under new IDs with the same card and
// amount (dev 09.11.2026: 871653710 → 871653865). A confirmed bonus whose ID
// vanished is matched to an unclaimed live write-off of the same card and
// amount and its stored ID is updated; anything ambiguous stays unverified.
async function remapBonusIds(query,salonId,recordId,companyId,sale) {
 const rows=(await query("SELECT operation_id,action,method_id,amount,external_ids FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='confirmed' AND method='loyalty_card' ORDER BY created_at",[salonId,recordId,companyId])).rows||[];
 const live=sale.state.loyalty_transactions.filter(t=>Number(t.type_id)===3);
 const liveIds=new Set(live.map(t=>String(t.id)));
 const claimed=new Set(rows.flatMap(r=>(r.external_ids||[]).map(String)).filter(id=>liveIds.has(id)));
 for(const r of rows){
  const ids=(r.external_ids||[]).map(String);
  if(r.action==='remove'||ids.length!==1||liveIds.has(ids[0]))continue;
  const cents=Math.round(Number(r.amount)*100);
  const match=live.find(t=>!claimed.has(String(t.id))&&Number(t.loyalty_card_id||t.card_id)===Number(r.method_id)&&Math.round(Number(t.amount)*100)===cents);
  if(!match)continue;
  claimed.add(String(match.id));
  await query("UPDATE journal_financial_transactions SET external_ids=$3,updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2 AND state='confirmed'",[salonId,r.operation_id,JSON.stringify([Number(match.id)])]);
 }
}
async function options(salonId,recordId) {
 const c=await context(salonId,recordId);
 // Best-effort (never throws): teaches the local form the salon's bonus cap.
 await reference.learnBonusPercent(salonId,c.sale);
 await remapBonusIds((sql,args)=>db.query(sql,args),salonId,recordId,c.salon.yclients_company_id,c.sale);
 await linkReferences(salonId);
 const accountIssue=Number(c.record.attendance)===0&&visitPayment.unavailableReason(c.record)?ARRIVAL_IN_YCLIENTS:null;
 const methods=c.sale.payment_methods.filter(v=>['account','loyalty_card'].includes(v.slug)).map(v=>({
  method:v.slug,id:Number(v.slug==='account'?v.account_id:v.loyalty_card_id),
  title:v.slug==='account'?String(v.account?.title||'Касса'):'Бонусы',
  cash:v.slug==='account'&&!!v.account?.is_cash,available:v.is_applicable===true&&(v.slug!=='account'||(accountPaymentsEnabled()&&!accountIssue)),
  requiresArrivalConfirmation:v.slug==='account'&&Number(c.record.attendance)===0,
  unavailableReason:v.slug==='account'?(!accountPaymentsEnabled()?'Оплата в кассу временно отключена: выполняется проверка интеграции. Оплатите визит в YClients.':accountIssue):null,
  limit:Math.max(0,Number(v.applicable_amount)||0),balance:v.slug==='loyalty_card'?Number(v.loyalty_card?.balance)||0:null,
 }));
 const pending=await db.any("SELECT operation_id,action,yclients_record_id,method,method_id,amount,state FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='pending' ORDER BY created_at",[salonId,recordId,c.salon.yclients_company_id]);
 const history=await db.any('SELECT operation_id,action,method,method_id,amount,state,external_ids,before_ids,bonus_transaction_id,created_at FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 ORDER BY created_at DESC',[salonId,recordId,c.salon.yclients_company_id]);
 const liveIds=new Set([...c.sale.state.payment_transactions.map(t=>'account:'+t.id),...c.sale.state.loyalty_transactions.filter(t=>Number(t.type_id)===3).map(t=>'loyalty_card:'+t.id)]);
 const removedIds=new Set(history.filter(t=>t.action==='remove'&&t.state==='confirmed').flatMap(t=>(t.external_ids||[]).map(id=>t.method+':'+id)));
 for(const t of history){if(t.action!=='remove'&&t.state==='confirmed'&&(t.external_ids||[]).some(id=>!liveIds.has(t.method+':'+id)&&!removedIds.has(t.method+':'+id))){t.state='unverified';pending.push({...t,yclients_record_id:recordId});}}
 const paid=[...c.sale.state.payment_transactions.map(t=>({id:Number(t.id),method:'account',methodId:Number(t.account_id),amount:Number(t.amount),title:(t.account?.is_cash?'Наличные':'Банковская карта')+' · '+String(t.account?.title||'Касса')})),...c.sale.state.loyalty_transactions.filter(t=>Number(t.type_id)===3).map(t=>({id:Number(t.id),method:'loyalty_card',methodId:Number(t.loyalty_card_id||t.card_id),amount:Number(t.amount),title:'Бонусы'}))];
 return {paid,recordId,version:c.version,clientName:String(c.record.client?.name||''),items:c.sale.state.items.map(i=>({title:String(i.title||''),quantity:Number(i.amount)||1,total:Number(i.cost_to_pay_total)||0})),methods,due:Math.max(0,...methods.filter(v=>v.method==='account').map(v=>v.limit)),pending,history};
}
async function locked(salonId,fn) {
 const conn=await pool.connect();let held=false,broken=false;
 try {held=!!(await conn.query('SELECT pg_try_advisory_lock(17291,$1) AS locked',[salonId])).rows[0]?.locked;if(!held)m.fail('Другая операция ещё выполняется.',409,'busy');return await fn(conn);}
 finally{if(held)try{await conn.query('SELECT pg_advisory_unlock(17291,$1)',[salonId]);}catch(_){broken=true;}conn.release(broken);}
}
async function confirm(conn,salonId,row,ids) {
 await conn.query("UPDATE journal_financial_transactions SET state='confirmed',external_ids=$3,updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2",[salonId,row.operation_id,JSON.stringify(ids)]);
 return {confirmed:true,operationId:row.operation_id,recordId:Number(row.yclients_record_id)};
}
async function markArrived(conn,salonId,c,draft) {
 // Non-financial step, before any payment intent: arrival is the action the
 // administrator explicitly confirmed. Only the attendance may change.
 const reason=visitPayment.unavailableReason(c.record);
 if(reason)m.fail(ARRIVAL_IN_YCLIENTS,409,'payment_unsupported');
 const plain=await yc.getRecord(c.salon,draft.recordId);
 if(visitPayment.snapshot({...plain,goods_transactions:c.record.goods_transactions})!==visitPayment.snapshot(c.record))m.fail('Визит изменился. Обновите форму оплаты.',409,'stale');
 try{await yc.markArrived(c.salon,plain);}
 catch(e){logPaymentFailure('arrival_write',draft,e);m.fail('Не удалось отметить приход в YClients. Проверьте статус визита и обновите форму.',409,'arrival_failed');}
 const after=await yc.getRecord(c.salon,draft.recordId,{includeConsumables:true});
 if(visitPayment.snapshot(after)!==visitPayment.snapshot({...c.record,attendance:1})){logPaymentFailure('arrival_integrity',draft,null);m.fail('После отметки прихода визит в YClients отличается от ожидаемого. Проверьте его до оплаты.',409,'stale');}
 const sale=await yc.getSale(c.salon,c.documentId);
 // Cash must be exactly the same; bonus write-offs may only be re-created
 // (same cards and amounts, new IDs).
 const cash=s=>s.state.payment_transactions.map(t=>[Number(t.id),Number(t.account_id),Math.round(Number(t.amount)*100)]).sort((a,b)=>a[0]-b[0]);
 const bonus=s=>s.state.loyalty_transactions.filter(t=>Number(t.type_id)===3).map(t=>[Number(t.loyalty_card_id||t.card_id),Math.round(Number(t.amount)*100)]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 if(JSON.stringify(cash(sale))!==JSON.stringify(cash(c.sale))||JSON.stringify(bonus(sale))!==JSON.stringify(bonus(c.sale))){logPaymentFailure('arrival_payments',draft,null);m.fail('После отметки прихода оплаты визита изменились. Обновите форму.',409,'stale');}
 await remapBonusIds((sql,args)=>conn.query(sql,args),salonId,draft.recordId,c.salon.yclients_company_id,sale);
 return {...c,record:after,sale};
}
async function pay(salonId,userId,draft) {
 if(draft.method==='account'&&draft.action!=='remove'&&!accountPaymentsEnabled())m.fail('Оплата в кассу временно отключена. Проведите её в YClients.',409,'payment_disabled');
 return locked(salonId,async conn=>{
  const hash=m.fingerprint(draft);
  const prior=(await conn.query('SELECT * FROM journal_financial_transactions WHERE salon_id=$1 AND operation_id=$2',[salonId,draft.operationId])).rows[0];
  if(prior){if(prior.request_hash!==hash)m.fail('Ключ оплаты уже использован для других данных.');if(prior.state==='confirmed'){const current=await context(salonId,Number(prior.yclients_record_id),true);try{if(Number(prior.yclients_company_id)!==Number(current.salon.yclients_company_id)||Number(prior.document_id)!==current.documentId)m.fail('Документ изменился.',409,'uncertain');receipt(current.sale,prior);}catch(_){m.fail('Ранее записанная оплата не подтверждена в YClients. Выполните сверку.',409,'uncertain');}return {confirmed:true,duplicate:true,recordId:Number(prior.yclients_record_id)};}m.fail('Эта попытка уже обработана или требует сверки. Обновите форму оплаты.',409,prior.state==='pending'?'uncertain':'rejected');}
  let c=await context(salonId,draft.recordId);
  // Unknown outcomes only block another payment for the same visit. The shared
  // salon lock still serializes active writes, including balance changes.
  if((await conn.query("SELECT operation_id FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='pending' LIMIT 1",[salonId,draft.recordId,c.salon.yclients_company_id])).rows.length)m.fail('У этого визита есть неподтверждённая оплата. Сначала выполните сверку.',409,'blocked_pending');
  if((await conn.query("SELECT operation_id FROM journal_operations WHERE salon_id=$1 AND record_id=$2 AND state='pending' LIMIT 1",[salonId,draft.recordId])).rows.length)m.fail('Сначала сверьте неподтверждённое изменение этого визита.',409,'blocked_pending');
  await remapBonusIds((sql,args)=>conn.query(sql,args),salonId,draft.recordId,c.salon.yclients_company_id,c.sale);
  const previous=(await conn.query("SELECT method,action,external_ids FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2 AND yclients_company_id=$3 AND state='confirmed'",[salonId,draft.recordId,c.salon.yclients_company_id])).rows;
  const reversed=new Set(previous.filter(t=>t.action==='remove').flatMap(t=>t.external_ids.map(id=>t.method+':'+id)));
  const live=new Set([...c.sale.state.payment_transactions.map(t=>'account:'+t.id),...c.sale.state.loyalty_transactions.filter(t=>Number(t.type_id)===3).map(t=>'loyalty_card:'+t.id)]);
  if(previous.some(t=>t.action!=='remove'&&t.external_ids.some(id=>!live.has(t.method+':'+id)&&!reversed.has(t.method+':'+id))))m.fail('Предыдущая оплата не подтверждена в YClients. Сначала выполните сверку.',409,'blocked_pending');
  if(c.version!==draft.version)m.fail('Сумма или состояние визита изменились. Обновите форму оплаты.',409,'stale');
  const removing=draft.action==='remove';
  const target=removing?transactions(c.sale,draft.method,draft.methodId).find(t=>Number(t.id)===draft.transactionId):null;
  if(removing&&(!target||Math.round(Number(target.amount)*100)!==Math.round(draft.amount*100)))m.fail('Транзакция уже изменена или не принадлежит визиту.',409,'stale');
  const method=c.sale.payment_methods.find(v=>v.slug===draft.method&&Number(v.slug==='account'?v.account_id:v.loyalty_card_id)===draft.methodId);
  if(!removing&&(!method||method.is_applicable!==true||Math.round(draft.amount*100)>Math.round(Number(method.applicable_amount)*100)||!Number.isFinite(Number(method.applicable_amount))))m.fail('Сумма превышает доступную оплату этим способом.',409);
  const accountPayment=!removing&&draft.method==='account';
  if(accountPayment&&Number(c.record.attendance)===0){
   if(draft.confirmArrival!==true)m.fail('Для оплаты записи в ожидании подтвердите действие «Оплатить и отметить приход».',409,'arrival_confirmation_required');
   c=await markArrived(conn,salonId,c,draft);
  }
  if(accountPayment){
   const latest=await yc.getSale(c.salon,c.documentId);
   if(m.fingerprint(latest.state)!==m.fingerprint(c.sale.state))m.fail('Оплаты визита изменились. Обновите форму.',409,'stale');
   const fresh=latest.payment_methods.find(v=>v.slug==='account'&&Number(v.account_id)===draft.methodId);
   if(!fresh||fresh.is_applicable!==true||Math.round(draft.amount*100)>Math.round(Number(fresh.applicable_amount)*100))m.fail('Сумма превышает доступную оплату этим способом.',409,'stale');
  }
  const before=transactions(c.sale,draft.method,draft.methodId).map(t=>Number(t.id));
  const row={action:removing?'remove':'payment',target_transaction_id:draft.transactionId,operation_id:draft.operationId,method:draft.method,method_id:draft.methodId,amount:draft.amount,before_ids:before,yclients_record_id:draft.recordId};
  // Autocommit BEFORE external payment. A crash or timeout must never resubmit it.
  await conn.query(`INSERT INTO journal_financial_transactions(salon_id,operation_id,user_id,yclients_company_id,yclients_record_id,document_id,method,method_id,amount,state,request_hash,before_ids,quote,action,target_transaction_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14)`,[salonId,draft.operationId,userId,c.salon.yclients_company_id,draft.recordId,c.documentId,draft.method,draft.methodId,draft.amount,hash,JSON.stringify(before),JSON.stringify(c.record.services||[]),row.action,draft.transactionId||null]);
  let sale;
  try{sale=removing?await yc.removePayment(c.salon,c.documentId,draft.method,draft.transactionId):await yc.pay(c.salon,c.documentId,accountPayment?{slug:'account',account_id:draft.methodId}:{slug:'loyalty_card',loyalty_card_id:draft.methodId},draft.amount);}
  catch(e){logPaymentFailure('sale_write',draft,e);if([400,401,403,404,422,429].includes(e.response?.status)){await conn.query("UPDATE journal_financial_transactions SET state='rejected',updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2",[salonId,draft.operationId]);m.fail('YClients отклонил оплату. Обновите форму.',409,'rejected');}m.fail('Ответ на оплату не получен. Повторное списание заблокировано до сверки.',409,'uncertain');}
  let stage='sale_response';
  try{
   receipt(sale,row);
   if(accountPayment){
    await settle();
    stage='record_integrity';
    const after=await yc.getRecord(c.salon,draft.recordId,{includeConsumables:true});
    if(after.deleted||![1,2].includes(Number(after.attendance)))m.fail('Статус визита после оплаты не подтверждён.',409,'uncertain');
   }
   stage='sale_readback';
   const saved=await yc.getSale(c.salon,c.documentId);
   if(accountPayment){stage='prior_payments';assertPriorPayments(c.sale,saved,draft.methodId);}
   stage='saved_receipt';
   const ids=receipt(saved,row);
   stage='local_confirmation';
   return await confirm(conn,salonId,row,ids);
  }catch(e){logPaymentFailure(stage,draft,e);m.fail('Оплата отправлена, но результат требует сверки. Не проводите её повторно.',409,'uncertain');}
 });
}
async function review(salonId,userId,body) {
 if(body?.checkedInYclients!==true||!['confirmed','not_applied'].includes(body.outcome)||!/^[0-9a-f-]{36}$/i.test(body.operationId||''))m.fail('Подтвердите результат сверки в YClients.');
 return locked(salonId,async conn=>{
  const row=(await conn.query("SELECT * FROM journal_financial_transactions WHERE salon_id=$1 AND operation_id=$2 AND state IN ('pending','confirmed')",[salonId,body.operationId])).rows[0];if(!row)m.fail('Операция не найдена.',404);
  const c=await context(salonId,Number(row.yclients_record_id),true);
  if(Number(c.salon.yclients_company_id)!==Number(row.yclients_company_id)||c.documentId!==Number(row.document_id))m.fail('Компания или документ изменились. Нужна ручная сверка интеграции.',409);
  if(body.outcome==='confirmed')await confirm(conn,salonId,row,receipt(c.sale,row));
  else {
   if(row.action==='remove'&&!transactions(c.sale,row.method,Number(row.method_id)).some(t=>Number(t.id)===Number(row.target_transaction_id)))m.fail('Транзакция уже удалена в YClients.',409);
   const old=new Set(row.before_ids.map(String));if(row.action!=='remove'&&transactions(c.sale,row.method,Number(row.method_id)).some(t=>!old.has(String(t.id))))m.fail('В YClients появились новые транзакции. Нельзя отметить оплату как непроведённую.',409);
   await conn.query("UPDATE journal_financial_transactions SET state='reviewed',updated_at=NOW() WHERE salon_id=$1 AND operation_id=$2",[salonId,row.operation_id]);
  }
  await conn.query('UPDATE journal_financial_transactions SET reviewed_by=$3 WHERE salon_id=$1 AND operation_id=$2',[salonId,row.operation_id,userId]);return {reviewed:true};
 });
}
module.exports={parse,options,pay,review,context,receipt,transactions,_setSettleMs:v=>{settleMs=v;}};
