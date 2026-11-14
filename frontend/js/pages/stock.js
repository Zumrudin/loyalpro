// Товары и склад. Все обращения используют общий авторизованный API.
const _stock = {tab:'balances', goods:[], dictionaries:{storages:[],units:[],suppliers:[],staff:[],categories:[]}, goodsRequest:0, cardRequest:0, categories:new Map(), busy:false, good:null};
const STOCK_TABS = {balances:'Остатки',goods:'Товары',docs:'Операции',suppliers:'Справочники','tech-cards':'Техкарты',inventory:'Инвентаризация',turnover:'Оборотка',settings:'Настройки'};
function stockEl(id) { return document.getElementById(id); }
function stockEsc(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function stockApi(path, body, method) { return api(method || (body ? 'POST':'GET'), '/api/stock'+path, body); }
function stockMoney(value) { return Number(value || 0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽'; }
function stockDate(value) { return value ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}) : '—'; }
function stockToday() { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()); }
async function loadStock() {
  stockEl('stockStatus').textContent='Загрузка…';
  try {
    _stock.dictionaries=await stockApi('/dictionaries');
    stockEl('stockTabBtn-settings').hidden=ME?.role!=='owner';
    stockRenderFilters();
    await stockOnHashArg((location.hash || '').replace(/^#stock\/?/,''));
    await stockLoadCounters();
    stockEl('stockStatus').textContent='';
  } catch(e) { stockEl('stockStatus').textContent=e.message; }
}
async function stockOnHashArg(arg) {
  const [tab,id]=String(arg||'').split('/');
  if(tab==='good' && /^\d+$/.test(id||'')) { await stockSwitchTab('goods',false);await stockOpenGood(Number(id));return; }
  if(tab==='doc' && /^\d+$/.test(id||'')){await stockSwitchTab('docs',false);await stockOpenDocument(Number(id));return;}
  stockCloseGood();
  await stockSwitchTab(STOCK_TABS[tab]?tab:'balances',false);
}
async function stockSwitchTab(tab, updateHash=true) {
  if(!STOCK_TABS[tab]) return;
  _stock.tab=tab;
  for(const key of Object.keys(STOCK_TABS)) {
    stockEl('stockTab-'+key).hidden=key!==tab;
    stockEl('stockTabBtn-'+key).classList.toggle('active',key===tab);
  }
  if(updateHash && location.hash!=='#stock/'+tab) {location.hash='stock/'+tab;return;}
  stockEl('stockFilters').hidden=!['goods','balances'].includes(tab);
  const loaders={docs:stockLoadDocs,suppliers:stockLoadRefs,inventory:stockLoadInventory,turnover:stockLoadTurnover,settings:stockLoadSettings,'tech-cards':()=>ecoLoadTechCards('stockTechCards')};
  if(loaders[tab])await loaders[tab]();else await stockLoadGoods();
}
async function stockLoadCounters() {
  try {
    const today=stockToday();
    const [goods,docs]=await Promise.all([stockApi('/goods?active=1'),stockApi('/documents?from='+today+'&to='+today+'&limit=1')]);
    const rows=goods.goods||[];
    stockEl('stockCounters').textContent=`Критических: ${rows.filter(g=>(g.balances||[]).some(b=>b.critical)).length} · Отрицательных: ${rows.filter(g=>(g.balances||[]).some(b=>b.negative)).length} · Документов сегодня: ${docs.total||0}`;
  } catch(e) { stockEl('stockCounters').textContent='Счётчики недоступны'; }
}
function stockFilters() {
  return {search:stockEl('stockSearch').value,storage:stockEl('stockStorage').value,category:stockEl('stockCategory').value,
    active:stockEl('stockActive').value,onlyCritical:stockEl('stockCritical').checked,onlyNegative:stockEl('stockNegative').checked};
}
function stockRenderFilters() {
  const selectedStorage=stockEl('stockStorage').value, selectedCategory=stockEl('stockCategory').value;
  stockEl('stockStorage').innerHTML='<option value="">Все склады</option>'+_stock.dictionaries.storages.map(s=>`<option value="${Number(s.id)}">${stockEsc(s.title)}</option>`).join('');
  stockEl('stockStorage').value=selectedStorage;
  const cats=_stock.categories;
  for(const path of _stock.dictionaries.categories||[]) for(let i=0;i<(path||[]).length;i++) cats.set(String(path[i].id),path.slice(0,i+1).map(c=>c.title).join(' › '));
  for(const g of _stock.goods) if(g.local_category) cats.set(g.local_category,g.local_category);
  stockEl('stockCategory').innerHTML='<option value="">Все категории</option>'+[...cats].sort((a,b)=>a[1].localeCompare(b[1],'ru')).map(([id,title])=>`<option value="${stockEsc(id)}">${stockEsc(title)}</option>`).join('');
  stockEl('stockCategory').value=selectedCategory;
}
async function stockLoadGoods() {
  const request=++_stock.goodsRequest, f=stockFilters();
  const params=new URLSearchParams({search:f.search,storage:f.storage,category:f.category,active:f.active,only_critical:f.onlyCritical?'1':'',only_negative:f.onlyNegative?'1':''});
  try {
    const data=await stockApi('/goods?'+params);
    if(request!==_stock.goodsRequest)return;
    _stock.goods=data.goods||[]; stockRenderFilters();
    stockEl('stockTab-balances').innerHTML=stockBalancesHtml(_stock.goods,_stock.dictionaries.storages,f);
    stockEl('stockTab-goods').innerHTML=stockGoodsHtml(_stock.goods);
    stockEl('stockStatus').textContent='';
  }catch(e){if(request===_stock.goodsRequest)stockEl('stockStatus').textContent=e.message;}
}
