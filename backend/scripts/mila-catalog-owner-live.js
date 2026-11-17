'use strict';
// Owner-authorized real model/tools/Telegram. Inbound/history in memory, booking writes blocked.
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
const root=process.env.QA_RUNTIME_BACKEND;if(!root||!process.argv.includes('--execute'))throw Error('EXPLICIT_RUNTIME_REQUIRED');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
const app=p=>require(path.join(root,p));const lid=require.resolve(path.join(root,'logger'));
require.cache[lid]={id:lid,filename:lid,loaded:true,exports:{createLogger:()=>({info(){},warn(){},error(){},debug(){}})}};
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');console.log=console.warn=console.error=()=>{};
const {db,pool}=app('db'),phone=String(process.env.OWNER_TEST_PHONE||'').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7'),salonId=1;
const report={runtime:root,inbound:'in-memory',delivery:'real Telegram',cases:[]},reportPath=process.argv.includes('--local-model')?'/tmp/mila-catalog-owner-local-model-report.json':'/tmp/mila-catalog-owner-live-report.json';
async function main(){
 if(!/^7\d{10}$/.test(phone)||(await db.one('SELECT current_database() n')).n!=='loyalpro_test')throw Error('DEV_OWNER_REQUIRED');
 const route=await db.oneOrNone("SELECT chat_id FROM chatpush_messages WHERE salon_id=$1 AND right(regexp_replace(phone,'[^0-9]','','g'),10)=$2 AND channel='tdlib' AND chat_id IS NOT NULL ORDER BY msg_ts DESC LIMIT 1",[salonId,phone.slice(-10)]);if(!route)throw Error('OWNER_TELEGRAM_NOT_FOUND');
 const meta={salonId,phone,channel:'tdlib',chatId:route.chat_id};
 const config=app('config'),registry=app('services/agent/tools'),orchestrator=app('services/agent/orchestrator'),providers=app('services/agent/providers'),relay=app('services/agent/providers/codex-relay');
 let routing;
 report.modelRoute=process.argv.includes('--local-model')?'isolated local codex':'configured routing';
 const provider=process.argv.includes('--local-model')?app('services/agent/providers/codex'):app('services/agent/providers/resilient').createProvider({salonId,store:{get:async()=>routing||(routing=await app('services/agent/model-routing').getStore().get(salonId)),transition:async(_s,before,active)=>routing={...before,active},outcome:async()=>{}},providers:{gpt:relay,claude:relay.createProvider({engine:'claude'}),polza:providers.polza},legacy:providers.getProvider()});
 const base=config.AGENT_CATALOG_IN_PROMPT?registry.catalogMode:registry;
 const catalog=await app('services/agent/catalog-data').loadCatalogServices(salonId);
 const svc=catalog.find(s=>/peach/i.test(s.title)&&s.staff?.length)||catalog.find(s=>/чистка/i.test(s.title)&&s.staff?.length);if(!svc)throw Error('SERVICE_UNAVAILABLE');
 const member=svc.staff[0],category=svc.category_path?.[0]||'Эстетическая косметология';
 const tests=[{id:'service_price',q:`Здравствуйте! Сколько стоит ${svc.title}?`,price:svc.price_min},{id:'category_price_list',q:`Пришлите прайс категории «${category}» картинкой.`},{id:'service_specialists',q:`Кто из специалистов выполняет ${svc.title}?`,staff:svc.staff.map(s=>s.name)},{id:'specialist_services',q:`Какие услуги выполняет ${member.name}?`},{id:'personal_price_duration',q:`Сколько стоит ${svc.title} у ${member.name} и сколько длится процедура?`,price:member.price_min,duration:member.duration_min},{id:'second_category_price_list',q:'Пришлите прайс по лазерной эпиляции картинкой.'}];
 const allow=new Set(['list_services','list_staff','get_service_masters','search_knowledge_base','send_price_list','get_available_slots','get_available_dates']),dispatcher=app('services/agent/dispatcher');
 for(const t of tests){emit({stage:'started',case:t.id});const calls=[];let llm=0;const entry={id:t.id};
 const handlers=Object.fromEntries(Object.entries(base.handlers).map(([name,fn])=>[name,async(sid,input,ctx)=>{if(sid!==salonId||ctx.clientPhone!==phone)throw Error('OWNER_SCOPE');if(!allow.has(name)){calls.push({name,blocked:true});return {error:'QA: только вопросы о каталоге; операция не выполнена.'};}const result=await fn(sid,input,ctx);calls.push({name,error:!!result?.error});return result;}]));
 try{
 const out=await orchestrator.runDialog(salonId,'owner-catalog-qa-'+randomUUID(),{ctx:{phone,channel:'tdlib'},deps:{provider:{toolResultMessages:(...a)=>provider.toolResultMessages(...a),createMessage:async(...a)=>{if(++llm>10)throw Error('LLM_LIMIT');return provider.createMessage(...a)}},registry:{schemas:base.schemas,handlers},history:{loadTranscript:async()=>({messages:[{role:'user',content:t.q}],watermark:1}),hasIncomingAfter:async()=>false,hasEverAnswered:async()=>false,hasAgentEverWritten:async()=>false},state:{getOrCreate:async()=>({status:'bot'}),setWatermark:async()=>{}},toolEvents:{loadRecent:async()=>[],createBuffer:()=>({turnId:randomUUID(),push(){},flush:async()=>{}})}}});
 const answer=(out.replies||[]).join('\n');Object.assign(entry,{answerPresent:!!answer,escalated:!!out.escalated,attachments:out.attachments?.length||0,linkPresent:/https?:\/\//.test(answer),imageClaim:/прикреп|отправляю.*прайс|вот.*прайс/iu.test(answer)});
 if(t.price!=null)entry.expectedPriceMentioned=answer.replace(/[\s\u00a0]/g,'').includes(String(t.price));if(t.staff)entry.assignedStaffMentioned=t.staff.filter(n=>n.toLowerCase().split(/\s+/).some(token=>token.length>2&&answer.toLowerCase().includes(token))).length;if(t.duration!=null)entry.expectedDurationMentioned=[...answer.matchAll(/(\d+)\s*мин/giu)].some(m=>Number(m[1])===Number(t.duration));
 entry.deliveries=[];if(answer){const d=await dispatcher.defaultSend(meta,`Проверка Милы: ${t.q}\n\n${answer}`);entry.deliveries.push({accepted:d?.id!=null,kind:'text'});}for(const att of out.attachments||[]){const d=await dispatcher.defaultSendFile(meta,att);entry.deliveries.push({accepted:d?.id!=null,kind:'image'});}
 }catch(e){entry.error='LIVE_CASE_FAILED';entry.errorCode=/^[A-Z_]+$/.test(e.code||'')?e.code:undefined;entry.errorType=e.name;}
 Object.assign(entry,{llmCalls:llm,tools:calls});report.cases.push(entry);fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});emit(entry);if(entry.error)break;
 }
 emit({stage:'complete',reportPath,cases:report.cases.length});
}
main().catch(e=>emit({error:'LIVE_SETUP_FAILED',code:/^[A-Z_]+$/.test(e.message)?e.message:e.code||e.name})).finally(()=>pool.end()).then(()=>process.exit(0));
