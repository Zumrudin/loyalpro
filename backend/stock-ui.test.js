'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const files = ['stock.js', 'stock-balances.js', 'stock-docs.js', 'stock-sale.js', 'stock-inventory.js', 'stock-refs.js'];
function harness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {value:'', checked:false, innerHTML:'', textContent:'', hidden:false, disabled:false, open:false,
      classList:{toggle:jest.fn()}, addEventListener:jest.fn(), querySelectorAll:()=>[], showModal(){this.open=true;}, close(){this.open=false;}});
    return nodes.get(id);
  };
  const ctx = vm.createContext({document:{getElementById:get}, api:jest.fn(), ME:{role:'owner'}, location:{hash:'#stock'}, URLSearchParams, Date, setTimeout, clearTimeout});
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/js/pages',file),'utf8'),ctx,{filename:file});
  return {ctx,get,run:s=>vm.runInContext(s,ctx)};
}
test('quantities preserve fractional base units and negative signs',()=>{
 const {ctx}=harness();
 expect(ctx.stockFmtQty(941,500,'шт','мл')).toBe('1 шт + 441 мл');
 expect(ctx.stockFmtQty(-4059,500,'шт','мл')).toBe('−9 шт + 441 мл');
 expect(ctx.stockFmtQty(7,1,'шт','шт')).toBe('7 шт');
 expect(ctx.stockFmtQty(-941,500,'шт','мл')).toBe('−2 шт + 59 мл');
 expect(ctx.stockFmtQty(0.25,1,'мл','мл')).toBe('0,25 мл');
});
test('balance filters and rendering escape catalog and storage titles',()=>{
 const {ctx}=harness();
 const goods=[{id:1,title:'<script>x</script>',unit_equals:1,unit:'шт',balances:[{storage_id:3,qty_base:-2,negative:true,critical:true}]},{id:2,title:'Normal',balances:[]}];
 expect(ctx.stockBalanceRows(goods,[],{onlyNegative:true})).toHaveLength(1);
 const html=ctx.stockBalancesHtml(goods,[{id:3,title:'<img>'}],{});
 expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('&lt;img&gt;');
 expect(html).toContain('stock-neg');
});
test('stale catalog response cannot overwrite the newest filters',async()=>{
 const h=harness(); let resolve;
 h.ctx.stockApi=jest.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce({goods:[{id:2,title:'new',balances:[]}]});
 const first=h.ctx.stockLoadGoods(); await h.ctx.stockLoadGoods(); resolve({goods:[{id:1,title:'old',balances:[]}]});await first;
 expect(h.run('_stock.goods[0].title')).toBe('new');
});
test('good draft maps empty optional values to null and preserves zero prices',()=>{
 const h=harness(); h.get('stockGoodTitle').value='Local';h.get('stockGoodUnit').value='1';h.get('stockGoodRatio').value='1';h.get('stockGoodPrice').value='0';h.get('stockGoodActive').checked=true;
 expect(h.ctx.stockGoodFormDraft()).toMatchObject({title:'Local',unitId:1,unitEquals:1,salePrice:0,actualCost:null,stockActive:true});
});
test('closed good card cannot be reopened by a late response',async()=>{
 const h=harness();let resolve;h.ctx.stockApi=()=>new Promise(r=>resolve=r);
 const pending=h.ctx.stockOpenGood(3);h.ctx.stockCloseGood();resolve({good:{id:3,title:'late'},balances:[],openings:[],receipts:[],techCards:[],movements:{movements:[],total:0}});await pending;
 expect(h.get('stockGoodModal').open).toBe(false);
});
test('stock scripts share global scope with all application scripts and are versioned',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
 for(const file of files) expect(html).toMatch(new RegExp('pages/'+file.replace('.','\\.')+'\\?v='));
 const all=[...html.matchAll(/<script src="(js\/[^"?]+)\?[^\"]*"/g)].map(m=>m[1]);
 const names=new Map();
 for(const file of all) {
  const code=fs.readFileSync(path.join(__dirname,'../frontend',file),'utf8');
  for(const m of code.matchAll(/^(?:async\s+function|function|const|let|var)\s+((?:stock|STOCK_|_stock)[\w$]*)/gm)){
   expect({name:m[1],previous:names.get(m[1])}).toEqual({name:m[1],previous:undefined});names.set(m[1],file);
  }
 }
 expect((html.match(/data-p="stock"/g)||[])).toHaveLength(2);
});
