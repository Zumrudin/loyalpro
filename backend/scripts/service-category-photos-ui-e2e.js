'use strict';
// Real Chromium synthetic UI check. API calls are intercepted in memory; no salon writes.
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'../../frontend');

async function main(){
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
 const tmpFiles=['/tmp/loyalpro-ui-price-a.jpg','/tmp/loyalpro-ui-price-b.png'];
 fs.writeFileSync(tmpFiles[0],Buffer.from([0xff,0xd8,0xff,0xd9]));
 fs.writeFileSync(tmpFiles[1],Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request',req=>{
   if(req.url().includes('/api/service-catalog/categories/1/price-photos')&&req.method()==='POST')return req.respond({status:201,contentType:'application/json',body:JSON.stringify({id:3,categoryId:1,fileUrl:'/uploads/new.jpg',fileName:'new.jpg',displayOrder:2})});
   req.abort();
  });
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start=html.indexOf('<div class="page" id="page-service-catalog">');
  const end=html.indexOf('<div class="page" id="page-journal">');
  const agentStart=html.indexOf('<div class="page" id="page-agent-services">');
  const agentEnd=html.indexOf('<div class="page" id="page-edocs">');
  const section=html.slice(start,end)+html.slice(agentStart,agentEnd);
  await page.setContent('<html><body><main style="padding:24px">'+section+'</main></body></html>');
  for(const file of ['base.css','features.css','ivory-brass.css','service-catalog.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,'css',file),'utf8')});
  await page.evaluate(()=>{
   window.confirm=()=>true;window.notify=()=>{};window.navTo=page=>{window.__navigated=page;};window.TOKEN='synthetic';window.__writes=[];window.__photoGets=[];window.__photoState={1:{photos:[{id:1,categoryId:1,fileUrl:'/uploads/a.jpg',fileName:'a.jpg',displayOrder:0},{id:2,categoryId:1,fileUrl:'/uploads/b.jpg',fileName:'b.jpg',displayOrder:1}],inheritedFrom:null,inheritedPhotos:[]},2:{photos:[],inheritedFrom:{id:1,title:'Родитель'},inheritedPhotos:[{id:1,categoryId:1,fileUrl:'/uploads/a.jpg',fileName:'a.jpg',displayOrder:0}]}};
   window.__catalog={categories:[{id:1,title:'Родитель',parent_id:null},{id:2,title:'Дочерняя',parent_id:1}],staffMembers:[],services:[]};
   window.__agent={serviceMode:'all',categories:[{id:101,title:'Старая категория',services:[{yc_id:7,title:'Видимая услуга',price_min:100,price_max:100,active:true,visible:true,staff:[{yc_id:9,name:'Мастер',hidden:false}]}],subcategories:[{id:201,title:'Старая подкатегория',services:[],subcategories:[]}]}]};
   window.api=async(method,url,body)=>{
    if(url==='/api/service-catalog'&&method==='GET')return structuredClone(window.__catalog);
    const m=url.match(/^\/api\/service-catalog\/categories\/(\d+)\/price-photos$/);
    if(m&&method==='GET'){window.__photoGets.push(Number(m[1]));if(m[1]==='1'&&window.__delayPhotoA)return new Promise(resolve=>setTimeout(()=>resolve({photos:[{id:99,categoryId:1,fileUrl:'/uploads/stale.jpg',fileName:'stale.jpg',displayOrder:0}],inheritedFrom:null,inheritedPhotos:[]}),200));return structuredClone(window.__photoState[m[1]]);}
    if(url.includes('/price-photos/reorder')){window.__writes.push({method,url,body});return {ok:true};}
    if(url.includes('/price-photos/')&&method==='DELETE'){window.__writes.push({method,url});return {ok:true};}
    if(url==='/api/agent/services'&&method==='GET')return structuredClone(window.__agent);
    if(url==='/api/agent/service-rules'&&method==='GET')return {rules:[]};
    if(url==='/api/agent/settings'&&method==='GET')return {priceListUrl:'https://price.test'};
    throw new Error(`Unexpected synthetic route ${method} ${url}`);
   };
  });
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'js/pages/service-catalog.js'),'utf8')});
  await page.evaluate(()=>{document.querySelector('#page-service-catalog').style.display='block';return loadServiceCatalog();});
  await page.click('[data-edit-category="1"]');
  await page.waitForFunction(()=>document.querySelector('#svcPricePhotos img'));
  assert.equal(await page.$$eval('#svcPricePhotos img',els=>els.length),2);
  assert.equal(await page.$eval('#svcPricePhotos',el=>el.textContent.includes('до 5 МБ')),true);
  await page.click('[data-price-move="1"][data-photo-id="1"]');
  await page.waitForFunction(()=>document.querySelector('#svcPricePhotos [data-price-move="-1"][data-photo-id="1"]'));
  assert(await page.evaluate(()=>window.__writes.some(x=>x.url.endsWith('/reorder'))));
  await page.click('[data-price-delete="2"]');
  assert(await page.evaluate(()=>window.__writes.some(x=>x.method==='DELETE'&&x.url.endsWith('/price-photos/2'))));
  const input=await page.$('#svcPricePhotos input[type=file]');await input.uploadFile(...tmpFiles);
  await page.waitForFunction(()=>window.__writes.length>=2);
  assert.equal(await page.evaluate(()=>window.__writes.filter(x=>x.method==='POST').length),0,'multipart uploads use intercepted fetch, not JSON api');
  assert.equal(await page.evaluate(()=>window.__photoGets.at(-1)),1);
  const stale=page.evaluate(()=>{window.__delayPhotoA=true;return svcLoadPricePhotos(1);});
  await page.evaluate(()=>svcEditCategory(2));
  await page.waitForFunction(()=>document.querySelector('#svcPricePhotos').textContent.includes('Родитель'),{timeout:3000});
  await stale;assert(await page.$eval('#svcPricePhotos',el=>el.textContent.includes('Унаследованные картинки')),'stale category response must not replace selected category');
  await page.setViewport({width:390,height:844});assert(await page.$eval('#svcModal',el=>el.getBoundingClientRect().width<=innerWidth));
  await page.evaluate(()=>document.querySelector('#svcModal').close());
  await page.evaluate(()=>{document.querySelector('#page-agent-services').style.display='block';});
  await page.addScriptTag({content:fs.readFileSync(path.join(root,'js/pages/agent-services-catalog.js'),'utf8')});
  await page.evaluate(()=>loadAgentServices());
  await page.click('.as-cat-toggle');
  assert.equal(await page.$$('.as-svc-cb').then(x=>x.length),1);
  assert.equal(await page.$$('.as-pair-cb').then(x=>x.length),1);
  for(const selector of ['.as-price-btn','.as-add-sub','.as-sub-rename','.as-sub-del','.as-move'])assert.equal(await page.$$(selector).then(x=>x.length),0,selector);
  await page.click('.as-cat-cb');assert.equal(await page.$$('.as-cat-cb').then(x=>x.length),1);
  await page.click('[data-settings-services]');assert.equal(await page.evaluate(()=>window.__navigated),'service-catalog');
  assert.deepEqual(errors,[]);
  console.log('PASS Chromium: category previews/upload2/reorder/delete/inheritance/stale response/mobile and Mila controls. Synthetic API only.');
 }finally{for(const f of tmpFiles)try{fs.unlinkSync(f);}catch(_){}await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
