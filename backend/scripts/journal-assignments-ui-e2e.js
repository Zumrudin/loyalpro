'use strict';
// Actual scripts and DOM, synthetic fixtures, all network blocked.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const read=f=>fs.readFileSync(path.resolve(__dirname,'../../frontend',f),'utf8');
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',r=>r.abort());
  const index=read('index.html'),start=index.indexOf('<div class="page" id="page-journal">'),end=index.indexOf('<!-- ── RECORDS',start);
  await page.setContent('<html><body>'+index.slice(start,end)+'</body></html>');
  await page.addScriptTag({content:'const TOKEN="synthetic";const ME={role:"owner"};function notify(){};'});
  for(const f of ['js/core/static-events.js','js/core/ui-events.js','js/core/dynamic-events.js',...[...index.matchAll(/<script src="(js\/pages\/journal[^"?]*\.js)[^"]*"><\/script>/g)].map(m=>m[1])])await page.addScriptTag({content:read(f)});
  await page.evaluate(()=>{
   crypto.randomUUID=()=> '11111111-2222-4333-8444-555555555555';
   jrApi=async()=>({clients:[],slots:[]});jrLoadClients=()=>{};
   journal.data={date:'2030-04-01',serviceSource:'internal',staff:[{id:1,name:'А'},{id:2,name:'Б'}],categories:[{id:10,title:'Категория А'},{id:20,title:'Категория Б'}],services:[{id:70,yclientsId:900,title:'Услуга А',categoryId:10,staffIds:[1],duration:30,priceMin:100},{id:71,yclientsId:901,title:'Услуга Б',categoryId:20,staffIds:[2],duration:60,priceMin:200},{id:72,yclientsId:902,title:'Без назначения',staffIds:[],duration:30}]};jrForm(null,{staffId:1,date:'2030-04-01'});
  });
  assert.deepEqual(await page.$$eval('#jrServices option',els=>els.map(e=>e.value)),['70']);
  assert(!(await page.$eval('#jrAllServices',e=>e.textContent)).includes('Категория Б'));
  await page.select('#jrStaff','2');
  assert.deepEqual(await page.$$eval('#jrServices option',els=>els.map(e=>e.value)),['71']);
  assert(!(await page.$eval('#jrQuickServices',e=>e.textContent)).includes('Без назначения'));
  await page.evaluate(()=>{
   const record={id:8,staffId:1,staffName:'А',date:'2030-04-01',time:'10:00',duration:30,attendance:0,paid:false,services:[{id:902,title:'Историческая услуга',cost:100}],clientName:'Тест',labels:[]};
   journal.session={recordId:8};jrEl('jrModalBody').innerHTML=jrAppointmentCard(record);jrBindRecordEdit(record);
  });
  assert.deepEqual(await page.$$eval('#jrCardAll [data-add-service]',els=>els.map(e=>e.dataset.addService)),['900']);
  assert((await page.$eval('#jrLinesBox',e=>e.textContent)).includes('Историческая услуга'));
  assert.deepEqual(errors,[]);
  console.log('PASS journal assignments: creation, staff switch, empty categories, edit picker, historical line; no network or writes');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
