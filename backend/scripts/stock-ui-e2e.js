'use strict';
// Isolated real-browser check with synthetic API responses, no DB or external effects.
const fs=require('fs'), path=require('path'), assert=require('assert/strict'), puppeteer=require('puppeteer');
const root=path.join(__dirname,'../../frontend');
async function main(){
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const section=source.slice(source.indexOf('    <div class="page" id="page-stock">'),source.indexOf('    <div class="page" id="page-economics">'));
  const dialog=source.match(/<dialog id="stockGoodModal"[\s\S]*?<\/dialog>/)[0];
  await page.setContent('<!doctype html><html><head></head><body style="padding:20px">'+section+dialog+'</body></html>');
  for(const file of ['base.css','stock.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,'css',file),'utf8')});
  await page.addStyleTag({content:'#page-stock{display:block}*{animation:none!important;transition:none!important}'});
  await page.evaluate(()=>{
   window.ME={role:'owner'};window.stockTestWrites=[];
   const good={id:1,title:'Тестовый крем <img>',source:'loyalpro',stock_active:true,unit:'шт',service_unit:'мл',unit_id:1,service_unit_id:2,unit_equals:500,local_sale_price:100,balances:[{storage_id:1,qty_base:941,critical:true},{storage_id:2,qty_base:-20,negative:true}]};
   window.api=async(method,url,body)=>{
    if(method!=='GET'){window.stockTestWrites.push({method,url,body});return {good,warnings:['Тестовое предупреждение']};}
    if(url.includes('/dictionaries'))return {storages:[{id:1,title:'Продажи'},{id:2,title:'Расходники'}],units:[{id:1,short_title:'шт'},{id:2,short_title:'мл'}],suppliers:[],staff:[],categories:[[{id:1,title:'Косметика'}]]};
    if(url.includes('/goods/1'))return {good,balances:[],openings:[],receipts:[],techCards:[],movements:{movements:[],total:0}};
    if(url.includes('/goods'))return {goods:[good]};
    if(url.includes('/documents'))return {documents:[],total:0};
    throw new Error('Unexpected synthetic API route');
   };
  });
  for(const file of ['stock.js','stock-balances.js'])await page.addScriptTag({path:path.join(root,'js/pages',file)});
  await page.evaluate(()=>loadStock());
  for(const width of [1280,390])for(const theme of ['light','dark']){
   await page.setViewport({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'page overflow');
   await page.screenshot({path:`/tmp/stock-${theme}-${width}.png`,fullPage:true});
  }
  assert.equal(await page.$eval('#stockTab-balances',e=>e.querySelectorAll('img').length),0,'catalog XSS');
  await page.click('#stockTab-balances .stock-link');await page.waitForSelector('#stockGoodModal[open]');
  assert.equal(await page.$eval('#stockGoodTitleText',e=>e.textContent),'Тестовый крем <img>');
  await page.keyboard.press('Escape');assert.equal(await page.$eval('#stockGoodModal',e=>e.open),false);
  await page.evaluate(()=>stockNewGood());
  await page.type('#stockGoodTitle','Synthetic good');await page.select('#stockGoodUnit','1');
  await page.click('#stockGoodSave');await page.waitForFunction(()=>!document.getElementById('stockGoodModal').open);
  assert.equal(await page.evaluate(()=>stockTestWrites.length),1);
  assert.equal(await page.evaluate(()=>stockTestWrites[0].body.title),'Synthetic good');
  assert.equal(await page.$eval('#stockStatus',e=>e.textContent),'Тестовое предупреждение');assert.deepEqual(errors,[]);
  console.log('PASS: desktop/mobile, light/dark, no overflow, escaped catalog, card close, local good form (mock API only).');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
