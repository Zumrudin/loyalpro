function stockFmtQty(qty, equals, unit, baseUnit) {
  const n=Number(qty)||0, eq=Number(equals)||1, abs=Math.abs(n);
  const fmt=x=>Number(x.toFixed(4)).toLocaleString('ru-RU',{maximumFractionDigits:4});
  const sign=n<0?'−':'';
  if(eq<=1 || unit===baseUnit)return sign+fmt(abs)+' '+(baseUnit||unit||'ед.');
  const packs=Math.floor(n/eq), rest=Number((n-packs*eq).toFixed(4));
  return (packs<0?'−':'')+(packs?fmt(Math.abs(packs))+' '+(unit||'уп.')+(rest?' + ':''):'')+(rest||!packs?fmt(rest)+' '+(baseUnit||'ед.'):'');
}
function stockBalanceRows(goods, storages, filters={}) {
  return goods.filter(g=>(!filters.search || String(g.title).toLocaleLowerCase('ru').includes(filters.search.toLocaleLowerCase('ru')))&&
    (!filters.onlyCritical||(g.balances||[]).some(b=>b.critical))&&(!filters.onlyNegative||(g.balances||[]).some(b=>b.negative)))
    .slice().sort((a,b)=>String(a.title).localeCompare(String(b.title),'ru'));
}
function stockBalancesHtml(goods, storages, filters={}) {
  const columns=storages.filter(s=>!filters.storage||String(s.id)===String(filters.storage));
  const rows=stockBalanceRows(goods,columns,filters);
  if(!rows.length)return '<div class="empty">Товары не найдены</div>';
  return '<table class="stock-table"><thead><tr><th>Товар</th>'+columns.map(s=>'<th>'+stockEsc(s.title)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(g=>`<tr><td data-label="Товар"><button class="stock-link" onclick="stockOpenGood(${Number(g.id)})">${stockEsc(g.title)}</button>${g.source==='loyalpro'?'<span class="stock-badge">LoyalPro</span>':''}</td>`+columns.map(s=>{
    const b=(g.balances||[]).find(b=>String(b.storage_id)===String(s.id));
    return `<td data-label="${stockEsc(s.title)}" class="${b?.negative?'stock-neg':b?.critical?'stock-crit':''}">${b?stockEsc(stockFmtQty(b.qty_base,g.unit_equals,g.unit,g.service_unit)):'—'}</td>`;
  }).join('')+'</tr>').join('')+'</tbody></table>';
}
function stockGoodsHtml(goods) {
  if(!goods.length)return '<div class="empty">Товары не найдены</div>';
  return '<table class="stock-table"><thead><tr><th>Товар</th><th>Категория</th><th>Цена</th><th>Статус</th></tr></thead><tbody>'+goods.map(g=>`<tr><td data-label="Товар"><button class="stock-link" onclick="stockOpenGood(${Number(g.id)})">${stockEsc(g.title)}</button> <span class="stock-badge">${g.source==='loyalpro'?'LoyalPro':'YClients'}</span></td><td data-label="Категория">${stockEsc(g.local_category||(g.category_path||[]).map(c=>c.title).join(' › '))}</td><td data-label="Цена">${stockMoney(g.local_sale_price??g.sale_price)}</td><td data-label="Статус">${g.stock_active===false?'Архив':'Активен'}</td></tr>`).join('')+'</tbody></table>';
}
function stockCloseGood() { if(_stock.busy)return; ++_stock.cardRequest;stockEl('stockGoodModal').close(); }
function stockInput(id,label,value,type='text',attrs='') { return `<label>${stockEsc(label)}<input id="${id}" type="${type}" value="${stockEsc(value??'')}" ${attrs}></label>`; }
function stockUnitOptions(selected) { return '<option value="">Выберите единицу</option>'+_stock.dictionaries.units.map(u=>`<option value="${Number(u.id)}" ${String(selected)===String(u.id)?'selected':''}>${stockEsc(u.short_title||u.title)}</option>`).join(''); }
function stockGoodFields(g={}) {
  const local=g.source!=='yclients';
  return (local?stockInput('stockGoodTitle','Название',g.title,'text','required maxlength="500"')+stockInput('stockGoodCategory','Категория',g.local_category,'text','maxlength="200"')+
    `<div class="stock-form-row"><label>Единица продажи<select id="stockGoodUnit" required>${stockUnitOptions(g.unit_id)}</select></label><label>Единица списания<select id="stockGoodServiceUnit">${stockUnitOptions(g.service_unit_id)}</select></label>${stockInput('stockGoodRatio','В упаковке',g.unit_equals??1,'number','min="1" step="any" required')}</div>`:'<p>'+stockEsc(g.title)+' · YClients</p>')+
    '<div class="stock-form-row">'+stockInput('stockGoodPrice','Цена продажи, ₽',g.local_sale_price,'number','min="0" step="0.01"')+
    (local?stockInput('stockGoodCost','Себестоимость упаковки, ₽',g.actual_cost,'number','min="0" step="0.01"')+stockInput('stockGoodCritical','Критический остаток, упаковок',g.critical_amount,'number','min="0" step="any"'):'')+'</div>'+
    (local?stockInput('stockGoodBarcode','Штрихкод',g.barcode,'text','maxlength="64"'):'')+
    `<label>Заметка<textarea id="stockGoodNote" maxlength="1000">${stockEsc(g.local_note)}</textarea></label><label class="stock-check"><input type="checkbox" id="stockGoodActive" ${g.stock_active===false?'':'checked'}> Активен</label>`;
}
function stockGoodFormDraft() {
  const val=id=>stockEl(id).value, num=id=>val(id)===''?null:Number(val(id));
  const body={salePrice:num('stockGoodPrice'),note:val('stockGoodNote')||null,stockActive:stockEl('stockGoodActive').checked};
  if(_stock.good?.source!=='yclients')Object.assign(body,{title:val('stockGoodTitle').trim(),localCategory:val('stockGoodCategory')||null,unitId:num('stockGoodUnit'),serviceUnitId:num('stockGoodServiceUnit'),unitEquals:num('stockGoodRatio'),actualCost:num('stockGoodCost'),criticalAmount:num('stockGoodCritical'),barcode:val('stockGoodBarcode')||null});
  return body;
}
function stockNewGood() {
  if(_stock.busy)return;
  ++_stock.cardRequest;_stock.good=null; stockEl('stockGoodTitleText').textContent='Новый товар';stockEl('stockGoodFields').innerHTML=stockGoodFields();
  stockEl('stockGoodDetails').innerHTML='';stockEl('stockGoodError').textContent='';stockEl('stockGoodModal').showModal();
}
async function stockOpenGood(id) {
  if(_stock.busy)return;
  const request=++_stock.cardRequest;
  try {
    const card=await stockApi('/goods/'+Number(id));if(request!==_stock.cardRequest)return;
    _stock.good=card.good;stockEl('stockGoodTitleText').textContent=card.good.title;
    stockEl('stockGoodFields').innerHTML=stockGoodFields(card.good);stockEl('stockGoodError').textContent='';
    stockEl('stockGoodDetails').innerHTML=stockGoodDetailsHtml(card);stockEl('stockGoodModal').showModal();
  }catch(e){if(request===_stock.cardRequest)stockEl('stockStatus').textContent=e.message;}
}
function stockGoodDetailsHtml(card) {
  const g=card.good, qty=n=>stockEsc(stockFmtQty(n,g.unit_equals,g.unit,g.service_unit));
  return (card.unitPrice?'<p>Себестоимость единицы списания: '+stockMoney(card.unitPrice.price)+'</p>':'')+'<h3>Остатки</h3>'+card.balances.map(b=>`<p>${stockEsc(b.storage_title)}: ${qty(b.qty_base)}</p>`).join('')+
    '<h3>YClients на снимке</h3>'+card.openings.map(b=>`<p>${stockEsc(b.storage_title)}: ${qty(b.yc_qty_base)} · ${stockDate(b.taken_at)}</p>`).join('')+
    '<h3>Приходы</h3>'+card.receipts.map(r=>`<p>${stockDate(r.occurred_at)} · ${stockEsc(r.storage_title)} · ${qty(r.qty_base)} · ${stockMoney(r.cost)} · ${stockEsc(r.origin)}</p>`).join('')+
    '<h3>Техкарты</h3><p>'+card.techCards.map(c=>stockEsc(c.title)).join(', ')+'</p><h3>Движения</h3><div id="stockGoodMovements">'+stockMovementsHtml(card.movements,g)+'</div>';
}
function stockMovementsHtml(data,g) {
  const page=Number(data.page)||1,limit=Number(data.limit)||50;
  return '<table class="stock-table"><thead><tr><th>Дата</th><th>Операция</th><th>Количество</th><th>Сумма</th></tr></thead><tbody>'+data.movements.map(m=>`<tr><td data-label="Дата">${stockDate(m.occurred_at)}</td><td data-label="Операция">${stockEsc(m.kind)} · ${stockEsc(m.origin)}${m.deleted_at?' · Отменено':''}</td><td data-label="Количество">${stockEsc(stockFmtQty(m.qty_base,g.unit_equals,g.unit,g.service_unit))}</td><td data-label="Сумма">${stockMoney(m.cost)}</td></tr>`).join('')+`</tbody></table><div class="stock-toolbar"><button type="button" ${page<=1?'disabled':''} onclick="stockGoodMovements(${page-1})">Назад</button><span>Страница ${page}</span><button type="button" ${page*limit>=data.total?'disabled':''} onclick="stockGoodMovements(${page+1})">Далее</button></div>`;
}
async function stockGoodMovements(page) {
  const g=_stock.good,request=++_stock.cardRequest;if(!g)return;
  try{const data=await stockApi('/goods/'+Number(g.id)+'/movements?page='+page);if(request===_stock.cardRequest)stockEl('stockGoodMovements').innerHTML=stockMovementsHtml(data,g);}catch(e){if(request===_stock.cardRequest)stockEl('stockGoodError').textContent=e.message;}
}
async function stockSaveGood(event) {
  event.preventDefault();if(_stock.busy)return;
  _stock.busy=true;stockEl('stockGoodSave').disabled=true;stockEl('stockGoodError').textContent='';
  try {
    const id=_stock.good?.id, body=stockGoodFormDraft();
    const result=await stockApi('/goods'+(id?'/'+Number(id):''),body,id?'PUT':'POST');
    stockEl('stockGoodModal').close();++_stock.cardRequest;await stockLoadGoods();await stockLoadCounters();
    stockEl('stockStatus').textContent=(result.warnings||[]).join(' ');
  }catch(e){stockEl('stockGoodError').textContent=e.message;}finally{_stock.busy=false;stockEl('stockGoodSave').disabled=false;}
}
stockEl('stockGoodModal').addEventListener('cancel',event=>{event.preventDefault();stockCloseGood();});
