'use strict';
// Real Chromium with repository HTML/CSS/JS and a synthetic API. No salon writes.
const assert=require('node:assert/strict'),puppeteer=require('puppeteer'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../../frontend');
async function main(){
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);page.on('request',r=>r.abort());await page.setViewport({width:1366,height:1000});
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const section=html.slice(html.indexOf('<div class="page" id="page-service-catalog">'),html.indexOf('<div class="page" id="page-journal">'));
 await page.setContent('<html><body><main style="padding:24px">'+section+'</main></body></html>');
 for(const file of ['base.css','features.css','ivory-brass.css','service-catalog.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,'css',file),'utf8')});
 await page.evaluate(()=>{
  document.querySelector('#page-service-catalog').style.display='block';
  window.__writes=[];window.__failSave=false;window.__failApply=false;window.confirm=()=>true;
  window.__catalog={categories:[],staffMembers:[{id:11,yclients_staff_id:101,name:'Специалист А',is_active:true},{id:12,yclients_staff_id:102,name:'Специалист Б',is_active:true},{id:13,yclients_staff_id:103,name:'Архивный специалист',is_active:false}],services:[{id:1,title:'Тестовая услуга',duration:30,price_min:6000,price_max:6000,active:true,linked:true,version:4,assignments:[{staffMemberId:11,priceMin:0,priceMax:null,duration:null}]},{id:2,title:'Услуга без длительности',duration:0,price_min:0,price_max:0,active:true,linked:true,version:0,assignments:[]}]};
  window.api=async(method,url,body)=>{
   if(method==='GET')return structuredClone(window.__catalog);window.__writes.push({method,url,body});
   if(url.endsWith('/reconcile/preview'))return {runId:'11111111-2222-4333-8444-555555555555',status:'preview',sourceCounts:{services:2,staff:3},skippedServices:1,removedInactiveAssignments:1,canApply:true,targets:[{serviceId:1,before:{priceMin:6000,priceMax:6000,duration:30,assignmentsInitialized:false,staff:[{id:101,price:{min:0,max:0},seance_length:1800},{id:103,price:{min:null,max:null},seance_length:1800}],assignments:[]},target:{priceMin:6500,priceMax:6500,duration:45,assignments:[{staffMemberId:11,priceMin:null,priceMax:null,duration:null}]}}],exceptions:[{code:'zero_duration_service',serviceId:2,blocking:false},{code:'inactive_staff_removed',serviceId:1,yclientsStaffId:103,blocking:false}]};
   if(url.endsWith('/apply')){if(window.__failApply)throw new Error('Сверка устарела. Создайте новую сверку.');return {status:'applied',updatedServices:1,skippedServices:1,removedInactiveAssignments:1};}
   if(window.__failSave)throw new Error('Услуга изменена другим пользователем. Обновите карточку.');
   const s=window.__catalog.services.find(s=>url.endsWith('/services/'+s.id));if(s){Object.assign(s,body,{price_min:body.priceMin===''?null:Number(body.priceMin),price_max:body.priceMax===''?null:Number(body.priceMax),version:s.version+1});return {id:s.id,version:s.version};}
   throw new Error('Unexpected synthetic route');
  };
 });
 await page.addScriptTag({content:fs.readFileSync(path.join(root,'js/pages/service-catalog.js'),'utf8')});
 await page.evaluate(()=>{document.querySelector('[data-static-onclick="s52"]').onclick=svcClose;return loadServiceCatalog();});
 await page.click('[data-edit-service="1"]');
 assert.equal(await page.$eval('[data-staff-price-min="0"]',e=>e.value),'0');
 assert(await page.$eval('[data-staff-duration-inherit="0"]',e=>e.checked));
 assert.equal(await page.$eval('#svcStaffAdd',e=>!!e.querySelector('option[value="13"]')),false);
 await page.select('#svcStaffAdd','12');await page.click('#svcAddStaff');await page.select('#svcStaffAdd','12');await page.click('#svcAddStaff');assert.equal(await page.$$eval('[data-staff-row]',e=>e.length),2);
 await page.click('[data-staff-duration-inherit="1"]');
 for(const [selector,value]of [['[data-staff-duration="1"]','45'],['#svcMin','7000'],['#svcMax','7000']])await page.$eval(selector,(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));},value);
 assert.match(await page.$eval('[data-staff-effective="1"]',e=>e.textContent),/7\s*000.*45/);
 await page.click('#svcSave');await page.waitForFunction(()=>!document.querySelector('#svcModal').open);
 const saved=await page.evaluate(()=>window.__writes.find(x=>x.method==='PUT').body);assert.equal(saved.assignments[0].priceMin,0);assert.equal(saved.assignments[1].priceMin,null);assert.equal(saved.assignments[1].duration,45);
 await page.click('[data-edit-service="1"]');assert.equal(await page.$$eval('[data-staff-row]',e=>e.length),2);assert(await page.$eval('[data-staff-price-inherit="1"]',e=>e.checked));
 const fits=()=>page.$eval('#svcModal',e=>e.getBoundingClientRect().width<=innerWidth&&e.scrollWidth<=e.clientWidth+1);
 assert(await fits(),'desktop dialog must fit content');await page.screenshot({path:'/tmp/service-catalog-desktop.png'});
 await page.setViewport({width:390,height:844});assert(await fits(),'mobile dialog must fit content');await page.screenshot({path:'/tmp/service-catalog-mobile.png'});
 await page.evaluate(()=>{window.__failSave=true;});await page.click('#svcSave');await page.waitForFunction(()=>document.querySelector('#svcError').textContent.includes('изменена'));assert(await page.$eval('#svcModal',e=>e.open));
 await page.evaluate(()=>{window.__failSave=false;svcClose();});
 await page.click('[data-edit-service="2"]');assert.equal(await page.$eval('#svcDuration',e=>e.value),'');await page.evaluate(()=>svcClose());
 await page.select('#svcStaffFilter','12');assert.equal(await page.$$eval('[data-edit-service]',e=>e.length),1);await page.select('#svcStaffFilter','');
 await page.click('#svcReconcileButton');await page.waitForSelector('#svcReconcileApply');
 const review=await page.$eval('#svcReconcilePanel',e=>e.textContent);for(const text of ['Архивный специалист','Без переноса: 1','К обновлению услуг: 1','базовая цена'])assert(review.includes(text),text);
 assert.equal(await page.evaluate(()=>window.__writes.filter(x=>x.url.endsWith('/apply')).length),0);
 await page.evaluate(()=>{window.__failApply=true;});await page.click('#svcReconcileApply');await page.waitForFunction(()=>document.querySelector('#svcStatus').textContent.includes('устарела'));
 await page.evaluate(()=>{window.__failApply=false;});await page.click('#svcReconcilePreview');await page.waitForFunction(()=>!svcState.busy);await page.click('#svcReconcileApply');
 await page.waitForFunction(()=>document.querySelector('#svcReconcilePanel').textContent.includes('Сверка применена'));assert.match(await page.$eval('#svcReconcilePanel',e=>e.textContent),/Обновлено услуг: 1/);assert(await page.$eval('#svcReconcileApply',e=>e.disabled));
 assert.deepEqual(errors,[]);
 console.log('PASS Chromium: inheritance, zero, duplicate assignment, save/reopen, conflict, zero base duration, staff filter, review/apply, expired report, desktop/mobile. Synthetic API only.');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
