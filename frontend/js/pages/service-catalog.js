'use strict';
const svcState={data:{categories:[],services:[]},category:null,query:'',request:0,busy:false};
const svcEl=id=>document.getElementById(id);
const svcEscape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function svcApi(path='',body,method='POST') {return api(body===undefined?'GET':method,'/api/service-catalog'+path,body);}
function svcCategoryPath(id) {
 const titles=[],seen=new Set();let node=svcState.data.categories.find(c=>Number(c.id)===Number(id));
 while(node&&!seen.has(node.id)){seen.add(node.id);titles.unshift(node.title);node=svcState.data.categories.find(c=>Number(c.id)===Number(node.parent_id));}
 return titles.join(' / ')||'Без категории';
}
function svcDescendants(id) {
 const ids=new Set([Number(id)]);let changed=true;
 while(changed){changed=false;for(const c of svcState.data.categories)if(ids.has(Number(c.parent_id))&&!ids.has(Number(c.id))){ids.add(Number(c.id));changed=true;}}
 return ids;
}
async function loadServiceCatalog() {
 const request=++svcState.request;svcEl('svcStatus').textContent='Загрузка…';
 try {const data=await svcApi();if(request!==svcState.request)return;svcState.data=data;svcRender();svcEl('svcStatus').textContent=`${data.services.length} услуг · ${data.categories.length} категорий`;}
 catch(e){if(request===svcState.request)svcEl('svcStatus').textContent=e.message;}
}
function svcRender() {
 const nodes=svcState.data.categories;
 const branch=(parent,depth=0)=>nodes.filter(c=>Number(c.parent_id||0)===Number(parent||0)).map(c=>`<div class="svc-category" style="padding-left:${Math.min(depth,12)*14}px"><button type="button" class="${Number(svcState.category)===Number(c.id)?'active':''}" data-category="${Number(c.id)}">${svcEscape(c.title)}</button><button type="button" data-edit-category="${Number(c.id)}" aria-label="Изменить категорию">✎</button></div>${depth<50?branch(c.id,depth+1):''}`).join('');
 svcEl('svcTree').innerHTML=`<button class="btn btn-sec" type="button" id="svcAll">Все услуги</button>${branch(null)}`;
 svcEl('svcAll').onclick=()=>{svcState.category=null;svcRender();};
 svcEl('svcTree').querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{svcState.category=Number(b.dataset.category);svcRender();});
 svcEl('svcTree').querySelectorAll('[data-edit-category]').forEach(b=>b.onclick=()=>svcEditCategory(Number(b.dataset.editCategory)));
 const included=svcState.category?svcDescendants(svcState.category):null;
 const services=svcState.data.services.filter(s=>(!included||included.has(Number(s.category_id)))&&s.title.toLowerCase().includes(svcState.query.toLowerCase()));
 svcEl('svcList').innerHTML=services.length?services.map(s=>`<article class="svc-item${s.active?'':' svc-archived'}"><div><h3>${svcEscape(s.title)}</h3><small>${svcEscape(svcCategoryPath(s.category_id))}</small><p>${Number(s.duration)} мин · ${s.price_min==null?'Цена не задана':svcEscape(Number(s.price_min).toLocaleString('ru-RU'))+' ₽'}${Number(s.price_max)>Number(s.price_min)?' — '+svcEscape(Number(s.price_max).toLocaleString('ru-RU'))+' ₽':''}</p><small>${s.active?(s.linked?'Связана с YClients':'Внутренняя услуга · запись через YClients недоступна'):'В архиве'}</small></div><div class="svc-item-actions"><button type="button" class="btn btn-sec" data-edit-service="${Number(s.id)}">Изменить</button>${s.economics_yc_id?`<button type="button" class="btn btn-sec" data-economics="${Number(s.id)}">Экономика ↗</button>`:''}</div></article>`).join(''):'<div class="empty">Услуг нет. Создайте услугу или импортируйте каталог из YClients.</div>';
 svcEl('svcList').querySelectorAll('[data-edit-service]').forEach(b=>b.onclick=()=>svcEditService(Number(b.dataset.editService)));
 svcEl('svcList').querySelectorAll('[data-economics]').forEach(b=>b.onclick=()=>svcEconomics(Number(b.dataset.economics)));
}
function svcOptions(selected,excluded=new Set()) {
 return '<option value="">Без категории</option>'+svcState.data.categories.filter(c=>!excluded.has(Number(c.id))).map(c=>`<option value="${Number(c.id)}" ${Number(selected)===Number(c.id)?'selected':''}>${svcEscape(svcCategoryPath(c.id))}</option>`).join('');
}
function svcModal(title,html,save) {
 svcEl('svcModalTitle').textContent=title;svcEl('svcModalBody').innerHTML=html;svcEl('svcError').textContent='';svcEl('svcModal').showModal();
 svcEl('svcForm').onsubmit=async e=>{e.preventDefault();if(svcState.busy)return;svcState.busy=true;svcEl('svcSave').disabled=true;svcEl('svcError').textContent='';
 try{await save();svcEl('svcModal').close();await loadServiceCatalog();}catch(e){svcEl('svcError').textContent=e.message;}finally{svcState.busy=false;svcEl('svcSave').disabled=false;}};
}
function svcClose(){if(!svcState.busy)svcEl('svcModal').close();}
function svcEditCategory(id) {
 const category=svcState.data.categories.find(c=>Number(c.id)===id);
 svcModal(id?'Изменить категорию':'Новая категория',`<label>Название<input id="svcTitle" required maxlength="200" value="${svcEscape(category?.title||'')}"></label><label>Родительская категория<select id="svcParent">${svcOptions(category?.parent_id??svcState.category,id?svcDescendants(id):new Set())}</select></label>`,()=>svcApi('/categories'+(id?'/'+id:''),{title:svcEl('svcTitle').value,parentId:svcEl('svcParent').value||null},id?'PUT':'POST'));
}
function svcEditService(id) {
 const s=svcState.data.services.find(s=>Number(s.id)===id);
 svcModal(id?'Изменить услугу':'Новая услуга',`<label>Название<input id="svcTitle" required maxlength="200" value="${svcEscape(s?.title||'')}"></label><label>Категория<select id="svcParent">${svcOptions(s?.category_id??svcState.category)}</select></label><div class="svc-form-row"><label>Длительность, мин<input id="svcDuration" type="number" min="1" max="1440" required value="${Number(s?.duration)||30}"></label><label>Цена от, ₽<input id="svcMin" type="number" min="0" step="0.01" value="${s?.price_min==null?'':Number(s.price_min)}"></label><label>Цена до, ₽<input id="svcMax" type="number" min="0" step="0.01" value="${s?.price_max==null?'':Number(s.price_max)}"></label></div><label>Связь с экономикой<select id="svcEconomics"><option value="">Не связана</option>${svcState.data.services.filter(x=>x.linked).map(x=>`<option value="${Number(x.yclients_id)}" ${Number(s?.economics_yc_id)===Number(x.yclients_id)?'selected':''}>${svcEscape(x.title)}</option>`).join('')}</select></label><label class="svc-check"><input id="svcActive" type="checkbox" ${s?.active===false?'':'checked'}> Услуга активна</label><p class="svc-note">${s?.linked?'Связь с YClients сохранена. Индивидуальные длительности и цены специалистов из импорта имеют приоритет над базовыми. Изменения каталога сохраняются только в LoyalPro.':'Услугу можно вести внутри LoyalPro. Для записи через YClients нужна импортированная услуга.'}</p>`,()=>svcApi('/services'+(id?'/'+id:''),{title:svcEl('svcTitle').value,categoryId:svcEl('svcParent').value||null,duration:Number(svcEl('svcDuration').value),priceMin:svcEl('svcMin').value,priceMax:svcEl('svcMax').value,active:svcEl('svcActive').checked,economicsId:svcEl('svcEconomics').value||null},id?'PUT':'POST'));
}
async function svcImport() {
 if(svcState.busy)return;svcState.busy=true;svcEl('svcImport').disabled=true;svcEl('svcStatus').textContent='Импортируем каталог…';
 try{const r=await svcApi('/import',{});await loadServiceCatalog();svcEl('svcStatus').textContent=`Добавлено: ${r.addedCategories} категорий и ${r.addedServices} услуг. Существующие изменения сохранены.`;}catch(e){svcEl('svcStatus').textContent=e.message;}finally{svcState.busy=false;svcEl('svcImport').disabled=false;}
}
async function svcEconomics(id) {
 const service=svcState.data.services.find(s=>Number(s.id)===id);if(!service?.economics_yc_id)return;
 // Wait for the report before opening the detail: its loader clears the detail.
 navTo('economics');await ecoLoadServices();if(location.hash.split('?')[0]!=='#economics'||!_eco.report)return;
 if (!_eco.report.services.some(s=>Number(s.key)===Number(service.economics_yc_id))) {
  svcEl('ecoDetail').innerHTML='<div class="card"><h3>'+svcEscape(service.title)+'</h3><p>В выбранном периоде нет состоявшихся визитов по связанной услуге. Выберите другой период в разделе «Экономика».</p></div>';
 } else await ecoOpenService(Number(service.economics_yc_id));
 svcEl('ecoDetail').scrollIntoView({behavior:'smooth',block:'start'});
}
svcEl('svcModal').addEventListener('cancel',e=>{e.preventDefault();svcClose();});
