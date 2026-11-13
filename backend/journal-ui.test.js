'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
// All journal files share ONE global scope in the browser (classic <script>s,
// index.html order). The harness runs them the same way, one script each.
const JR_FILES = ['journal.js', 'journal-grid.js', 'journal-card.js', 'journal-forms.js', 'journal-payment.js', 'journal-dispatch.js'];
const readJr = file => fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8');
const JR_SOURCES = JR_FILES.map(file => ({ file, code: readJr(file) }));
const JR_ALL = JR_SOURCES.map(s => s.code).join('\n');
function harness() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false,
      get options() { return Array.from({ length: (this.innerHTML.match(/<option/g) || []).length }); }, selectedOptions: [],
      addEventListener: jest.fn(), querySelectorAll: () => [], insertAdjacentHTML: jest.fn(), showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  let uuid = 0;
  const context = vm.createContext({ document: { getElementById: get }, Date, URLSearchParams, AbortController, setTimeout, clearTimeout, encodeURIComponent, crypto: { randomUUID: () => 'synthetic-uuid-' + (++uuid) }, TOKEN: 'synthetic-token', ME: { role: 'owner' }, notify: jest.fn(), fetch: jest.fn(), confirm: jest.fn(() => false) });
  for (const s of JR_SOURCES) vm.runInContext(s.code, context, { filename: s.file });
  return { context, get, run: expression => vm.runInContext(expression, context) };
}
// Top-level names of a classic script: a duplicate const/let across files is a
// SyntaxError that kills the whole page; a duplicate function silently wins.
function jrTopLevelNames(code) {
  const out = [];
  for (const m of code.matchAll(/^(?:async\s+function|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.push(m[1]);
  return out;
}
test('journal files: no top-level name is declared twice across files', () => {
  const seen = new Map();
  for (const s of JR_SOURCES) for (const name of jrTopLevelNames(s.code)) {
    expect({ name, file: s.file, other: seen.get(name) || null }).toEqual({ name, file: s.file, other: null });
    seen.set(name, s.file);
  }
  expect(seen.size).toBeGreaterThan(90);
});
test('index.html loads every journal file in order, after the dialog, with a cache buster', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  let last = html.indexOf('id="jrModal"');
  for (const file of JR_FILES) {
    const at = html.search(new RegExp(`src="js/pages/${file.replace('.', '\\.')}\\?v=[^"]+"`));
    expect({ file, found: at > last }).toEqual({ file, found: true });
    last = at;
  }
});
test('overlapping visits use lanes and adjacent visits reclaim a lane', () => {
  const h = harness();
  const records = [{ id: 1, time: '09:00', duration: 60 }, { id: 2, time: '09:30', duration: 60 }, { id: 3, time: '10:00', duration: 30 }, { id: 4, time: '12:00', duration: 60 }];
  const out = h.context.jrLayout(records);
  expect(out.map(r => [r.lane, r.lanes])).toEqual([[0,2],[1,2],[0,2],[0,1]]);
});
test('rendering escapes all patient and catalog text', () => {
  const h = harness();
  h.run(`journal.data = { staff: [{id:1,name:'<img src=x onerror=alert(1)>'}], records: [{id:8,staffId:1,clientName:'<script>bad()</script>',time:'10:00',duration:60,attendance:0,services:[{title:'<svg onload=alert(1)>'}]}] }; jrRender();`);
  expect(h.get('jrGrid').innerHTML).not.toContain('<script>');
  expect(h.get('jrGrid').innerHTML).not.toContain('<img');
  expect(h.get('jrGrid').innerHTML).toContain('&lt;script&gt;');
});
test('old date response cannot overwrite newer date', async () => {
  const h = harness(); let resolveFirst;
  h.context.jrApi = jest.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValueOnce({ date: '2030-04-02', fetchedAt: '2030-04-02T06:00:00Z', staff: [], records: [] });
  h.get('jrDate').value = '2030-04-01'; const first = h.context.loadJournal();
  h.get('jrDate').value = '2030-04-02'; await h.context.loadJournal();
  resolveFirst({ date: '2030-04-01', fetchedAt: '2030-04-01T06:00:00Z', staff: [], records: [] }); await first;
  expect(h.run('journal.data.date')).toBe('2030-04-02');
});
test('old card response cannot reopen closed modal', async () => {
  const h = harness(); let resolve;
  h.context.jrApi = jest.fn(() => new Promise(r => { resolve = r; }));
  const open = h.context.jrOpen(8); h.context.jrClose();
  resolve({ id: 8, clientName: 'STALE', services: [] }); await open;
  expect(h.get('jrModal').open).toBe(false);
  expect(h.get('jrModalBody').innerHTML).not.toContain('STALE');
});
test('double submit performs one request; lost response keeps the session key, a rejection renews it', async () => {
  const h = harness(); let reject;
  h.context.jrApi = jest.fn(() => new Promise((_, r) => { reject = r; }));
  h.run(`journal.session = {sessionId:'synthetic-session',recordId:8}`);
  const body = { sessionId: 'synthetic-session', recordId: 8, status: 'confirm' };
  const first = h.context.jrSave(body); await h.context.jrSave(body);
  expect(h.context.jrApi).toHaveBeenCalledTimes(1);
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', body);
  reject(new Error('synthetic timeout')); await first;
  expect(h.run('journal.session.sessionId')).toBe('synthetic-session');
  expect(h.get('jrModalError').textContent).toBe('synthetic timeout');
  const rejected = Object.assign(new Error('Время занято'), { status: 409, code: 'busy' });
  h.context.jrApi.mockRejectedValueOnce(rejected); await h.context.jrSave(body);
  expect(h.run('journal.session.sessionId')).not.toBe('synthetic-session');
  expect(h.get('jrModalError').textContent).toBe('Время занято');
});
test('journal is mounted separately, in both navigation menus, with script after dialog', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  expect((html.match(/data-p="journal"/g) || [])).toHaveLength(2);
  expect(html).toContain('id="page-records"');
  expect(html.indexOf('id="jrModal"')).toBeLessThan(html.indexOf('src="js/pages/journal.js'));
});

test('default filter shows only working specialists and never resurrects removed staff from records', () => {
  const h = harness(); h.get('jrWorkingOnly').checked = true;
  h.run(`journal.data = {staff:[{id:1,working:true},{id:2,working:false}],records:[{staffId:99,staffName:'Excluded'}]}`);
  expect(h.context.jrStaffList().map(s => s.id)).toEqual([1]);
  h.get('jrWorkingOnly').checked = false;
  expect(h.context.jrStaffList().map(s => s.id)).toEqual([1,2]);
});
test('quarter cells respect breaks, past time and appointments hidden by search', () => {
  const h = harness();
  const staff = {id:1,workRanges:[{start:540,end:600},{start:660,end:720}]};
  const record = {staffId:1,time:'09:30',duration:30};
  expect(h.context.jrCellState(staff,540,'2030-04-01',[record],0)).toBe('free');
  expect(h.context.jrCellState(staff,570,'2030-04-01',[record],0)).toBe('busy');
  expect(h.context.jrCellState(staff,600,'2030-04-01',[],0)).toBe('break');
  expect(h.context.jrCellState(staff,720,'2030-04-01',[],0)).toBe('off');
  expect(h.context.jrCellState(staff,525,'2030-04-01',[],0)).toBe('off');
  expect(h.context.jrCellState(staff,540,'2030-04-01',[],Date.parse('2030-04-01T10:00:00+03:00'))).toBe('past');
});
test('grid click passes exact staff, date and quarter-hour into creation form', () => {
  const h = harness();
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,working:true,workRanges:[{start:540,end:720}]}],records:[]}`);
  h.context.jrForm = jest.fn(); h.context.jrGridCreate(1,'09:15');
  expect(h.context.jrForm).toHaveBeenCalledWith(null,{staffId:1,time:'09:15',date:'2030-04-01'});
  h.context.jrGridCreate(1,'08:00'); expect(h.context.jrForm).toHaveBeenCalledTimes(1);
});
test('grid renders 15-minute cells and a hidden booking does not become clickable', () => {
  const h = harness(); h.get('jrSearch').value = 'no match';
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,name:'Test',working:true,workRanges:[{start:540,end:720}]}],records:[{id:8,staffId:1,time:'09:30',duration:30,clientName:'Test',services:[]}]};jrRender()`);
  expect(h.get('jrGrid').innerHTML).toContain('data-time="09:15"');
  expect(h.get('jrGrid').innerHTML).toContain('data-time="10:00"');
  expect(h.get('jrGrid').innerHTML).not.toContain('data-time="09:30"');
  expect(h.get('jrGrid').innerHTML).not.toContain('data-time="09:45"');
});
test('clicked time stays unconfirmed until server checks the selected services', async () => {
  const h = harness();
  h.run(`journal.data = {staff:[{id:1,name:'Test'}],services:[{id:7,title:'Test',staffIds:[1],duration:60}]};jrForm(null,{staffId:1,time:'09:15',date:'2030-04-01'})`);
  expect(h.get('jrStaff').value).toBe('1');
  expect(h.get('jrFormDate').value).toBe('2030-04-01');
  // Real DOM reflects the disabled attribute; assert it is present in markup.
  expect(h.get('jrModalBody').innerHTML).toContain('id="jrApply" disabled');
  h.get('jrServices').selectedOptions = [{value:'7'}];
  h.context.jrApi = jest.fn().mockResolvedValue({duration:60,slots:['09:15','09:30']});
  await h.context.jrFindSlots();
  expect(h.get('jrTime').value).toBe('09:15'); expect(h.get('jrApply').disabled).toBe(false);
  h.context.jrApi.mockResolvedValue({duration:60,slots:['09:30']});
  await h.context.jrFindSlots();
  expect(h.get('jrApply').disabled).toBe(true);
  expect(h.get('jrSlotInfo').textContent).toContain('09:15 недоступно');
});

test('appointment card preserves real actions and exposes unavailable features as disabled placeholders', () => {
  const h = harness();
  const html = h.context.jrAppointmentCard({id:8,staffId:1,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[{title:'Test service',cost:500}],comment:''});
  expect(html).toContain('id="jrMove"');
  expect(html).toContain('data-attendance="2"');
  expect(html).toContain('id="jrCancel"');
  const placeholders = html.match(/<button[^>]*class="jr-placeholder[^>]*>/g);
  expect(placeholders.length).toBeGreaterThan(10);
  expect(placeholders.every(button => button.includes(' disabled') && button.includes('type="button"'))).toBe(true);
  expect(html).not.toContain('Оплачено 0');
});
test('card escapes notes inside textarea and never re-enables arrived/paid visit editing', () => {
  const h = harness();
  const html = h.context.jrAppointmentCard({staffName:'Test',clientName:'<img src=x>',attendance:1,paid:true,services:[],comment:'</textarea><script>bad()</script>'});
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;/textarea&gt;');
  expect(html).not.toContain('id="jrMove"');
  expect(html).not.toContain('id="jrConfirm"');
  expect(html).not.toContain('id="jrCancel"');
});
test('wide card action callbacks still go through confirmation and existing move flow', async () => {
  const h = harness();
  const record = {id:8,staffId:1,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[],version:'test'};
  h.context.jrApi = jest.fn().mockResolvedValue(record);
  await h.context.jrOpen(8);
  expect(h.get('jrModal').className).toContain('jr-dialog-wide');
  h.context.jrForm = jest.fn(); h.get('jrMove').onclick();
  expect(h.context.jrForm).toHaveBeenCalledWith(record,{carry:null});
  h.get('jrCancel').onclick();
  expect(h.run('journal.draft.action')).toBe('cancel');
  expect(h.get('jrModal').className).toBe('jr-dialog');
  expect(h.context.jrApi).toHaveBeenCalledTimes(1); // opening/confirming UI never writes
});
test('create form contains one form with client fields, comment and real submit action', () => {
  const h = harness();
  h.run(`journal.data = {staff:[{id:1,name:'Test'}],services:[]};jrForm(null,{staffId:1,time:'09:15',date:'2030-04-01'})`);
  const html = h.get('jrModalBody').innerHTML;
  expect((html.match(/<form /g)||[])).toHaveLength(1);
  for (const id of ['jrName','jrPhone','jrComment','jrStaff','jrFormDate','jrServices','jrApply']) {
    expect((html.match(new RegExp('id="'+id+'"','g'))||[])).toHaveLength(1);
  }
  expect(html).toContain('type="submit"');
  expect(h.get('jrModal').className).toContain('jr-dialog-wide');
});
test('deleted record does not claim to be waiting or offer status changes', () => {
  const h = harness();
  const html = h.context.jrStatusBar({deleted:true,attendance:0},false);
  expect(html).toContain('Запись удалена'); expect(html).not.toContain('Ожидание');
});

test('selected existing client keeps exact full name and phone on booking submission', () => {
  const h = harness();
  h.run(`journal.data={staff:[{id:1,name:'Test'}],services:[]}; jrForm(null,{staffId:1,date:'2030-04-01'})`);
  h.context.jrSelectClient({name:'Synthetic Family Given Middle',phone:'70000000000',email:'test@example.invalid',visits_count:4});
  h.context.jrSave = jest.fn();
  h.get('jrForm').onsubmit({preventDefault(){}});
  expect(h.context.jrSave.mock.calls[0][0].create).toMatchObject({clientName:'Synthetic Family Given Middle',clientPhone:'70000000000'});
  expect(h.get('jrName').readOnly).toBe(true);
  expect(h.get('jrEmail').value).toBe('test@example.invalid');
  h.context.jrSelectClient(null);
  expect(h.get('jrName').value).toBe('');
  expect(h.get('jrPhone').readOnly).toBe(false);
});
test('new client name fields compose full name without blank components', () => {
  const h=harness();
  h.run(`journal.data={staff:[],services:[]};jrForm(null)`);
  h.get('jrSurname').value=' Synthetic '; h.get('jrName').value=' Test '; h.get('jrPhone').value='70000000000';
  h.context.jrSave=jest.fn();h.get('jrForm').onsubmit({preventDefault(){}});
  expect(h.context.jrSave.mock.calls[0][0].create.clientName).toBe('Synthetic Test');
});
test('late client search response cannot overwrite newer search or a closed modal', async () => {
  const h=harness();let resolve;
  h.context.fetch.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce({ok:true,json:async()=>({clients:[{name:'LATEST',phone:''}]})});
  const first=h.context.jrLoadClients('first'); await h.context.jrLoadClients('latest');
  resolve({ok:true,json:async()=>({clients:[{name:'STALE',phone:''}]})});await first;
  expect(h.get('jrClientResults').innerHTML).toContain('LATEST');
  expect(h.get('jrClientResults').innerHTML).not.toContain('STALE');
  h.context.fetch.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));
  const closed=h.context.jrLoadClients();h.context.jrClose();h.get('jrClientResults').innerHTML='CLOSED';
  resolve({ok:true,json:async()=>({clients:[{name:'STALE'}]})});await closed;
  expect(h.get('jrClientResults').innerHTML).toBe('CLOSED');
});
test('client search escapes untrusted data and handles API failure without patient output', async () => {
  const h=harness();
  h.context.fetch.mockResolvedValueOnce({ok:true,json:async()=>({clients:[{name:'<script>bad()</script>',phone:'<img>'}]})});
  await h.context.jrLoadClients();
  expect(h.get('jrClientResults').innerHTML).toContain('&lt;script&gt;');
  expect(h.get('jrClientResults').innerHTML).not.toContain('<img>');
  h.context.fetch.mockResolvedValueOnce({ok:false});await h.context.jrLoadClients();
  expect(h.get('jrClientResults').textContent).toContain('Не удалось');
});
test('service tiles filter by specialist/search and display staff duration/price', () => {
  const h=harness();h.get('jrStaff').value='1';
  h.run(`journal.data={services:[{id:7,title:'Synthetic service',duration:60,priceMin:500,staffIds:[1],staffDetails:[{id:1,duration:30,priceMin:700}]},{id:8,title:'Foreign specialist service',staffIds:[2]}]}`);
  h.context.jrRenderServiceChoices();
  expect(h.get('jrQuickServices').innerHTML).toContain('30 мин · 700 ₽');
  expect(h.get('jrQuickServices').innerHTML).not.toContain('Foreign');
  h.get('jrServiceSearch').value='missing';h.context.jrRenderServiceChoices();
  expect(h.get('jrQuickServices').innerHTML).toContain('Услуги не найдены');
});
test('end time follows verified service duration', () => {
  const h=harness();h.get('jrTime').value='09:15';h.run('journal.duration=90');h.context.jrUpdateEndTime();
  expect(h.get('jrEndTime').value).toBe('10:45');expect(h.get('jrDuration').value).toBe('90 мин');
});

test('all services renders nested local categories and keeps uncategorized services accessible', () => {
  const h = harness();
  h.run(`journal.data={categories:[{id:10,title:'Parent'},{id:11,parent_id:10,title:'Child'},{id:12,title:'Empty'}]}`);
  const html = h.context.jrServiceCategoryTree([{id:1,title:'Nested service',categoryId:11},{id:2,title:'No category'}],s=>`<button>${s.title}</button>`,'');
  expect(html).toMatch(/Parent[\s\S]*Child[\s\S]*Nested service/);
  expect(html).not.toContain('Empty');expect(html).toContain('Без категории');expect(html).toContain('No category');
});
test('category search includes descendants, opens matching paths and escapes category names', () => {
  const h = harness();
  h.run(`journal.data={categories:[{id:10,title:'<img> Parent'},{id:11,parent_id:10,title:'Child'}]}`);
  const choices=[{id:1,title:'Needle',categoryId:11},{id:2,title:'Other'}];
  const html=h.context.jrServiceCategoryTree(choices,s=>s.title,'parent');
  expect(html).toContain('Needle');expect(html).not.toContain('Other');expect(html).toContain('&lt;img&gt;');expect(html).not.toContain('<img>');
  expect((html.match(/ open>/g)||[])).toHaveLength(2);
  const retained=h.context.jrServiceCategoryTree(choices,s=>s.title,'',new Set(['10','11']));
  expect((retained.match(/ open>/g)||[])).toHaveLength(2);
});
test('category service buttons preserve selection and remain scoped to selected specialist', () => {
  const h=harness();h.get('jrStaff').value='1';
  h.run(`journal.data={categories:[{id:10,title:'Visible'},{id:20,title:'Other specialist'}],services:[{id:7,title:'Selected service',categoryId:10,staffIds:[1]},{id:8,title:'Excluded service',categoryId:20,staffIds:[2]}]}`);
  h.get('jrServices').selectedOptions=[{value:'7'}];h.context.jrRenderServiceChoices();
  const html=h.get('jrAllServices').innerHTML;
  expect(html).toContain('data-service-id="7"');expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain('Excluded service');expect(html).not.toContain('Other specialist');
});

test('line totals use quantity, discount and manual total without trusting impossible totals', () => {
 const h=harness();
 expect(h.context.jrLineCalculation({quantity:2,unitPrice:100.01,discount:10,mode:'discount'})).toMatchObject({total:180.02,gross:200.02});
 expect(h.context.jrLineCalculation({quantity:2,unitPrice:100,discount:0,total:150,mode:'total'})).toMatchObject({total:150,discount:25});
 expect(h.context.jrLineCalculation({quantity:1,unitPrice:100,total:101,mode:'total'})).toBe(null);
});
test('editable line state survives catalog search and is submitted with internal service IDs', () => {
 const h=harness();h.run(`journal.data={serviceSource:'internal',staff:[{id:1,name:'Synthetic'}],services:[{id:70,title:'Synthetic',staffIds:[1],priceMin:100,duration:30}]};jrForm(null,{staffId:1,date:'2030-04-01'})`);
 h.get('jrServices').selectedOptions=[{value:'70'}];h.context.jrRenderServiceChoices();
 h.run(`journal.lines[70].quantity=2;journal.lines[70].unitPrice=200;journal.lines[70].discount=10`);
 h.get('jrServiceSearch').value='missing';h.context.jrRenderServiceChoices();
 expect(h.get('jrServiceSelection').innerHTML).toContain('value="360"');
 h.context.jrSave=jest.fn();h.get('jrForm').onsubmit({preventDefault(){}});
 expect(h.context.jrSave.mock.calls[0][0].create.lines).toEqual([expect.objectContaining({serviceId:70,quantity:2,unitPrice:200,discount:10})]);
});
test('stalled fetch exits with a bounded error and clears timer',async()=>{
 jest.useFakeTimers();try{
 const h=harness();h.context.fetch.mockImplementation((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{const e=new Error();e.name='AbortError';reject(e)})));
 const request=h.context.jrApi('payments/8');const result=expect(request).rejects.toThrow('Время ожидания');
 await jest.advanceTimersByTimeAsync(45000);await result;expect(jest.getTimerCount()).toBe(0);
 }finally{jest.useRealTimers();}
});
test('unavailable buttons use ordinary disabled cursor, only active requests show wait',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../frontend/css/journal.css'),'utf8');
 expect(css).not.toContain('.jr-dialog button:disabled{opacity:.5;cursor:wait}');
 expect(css).toContain('.jr-dialog.jr-payment-busy .jr-pay-method:disabled{cursor:wait}');
 for (const cls of ['.jr-visit-syncing','.jr-visit-failed','.jr-sync-alert','.jr-pay-queued']) expect(css).toContain(cls);
});
test('index bumps journal stylesheet cache buster',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
 expect(html).toMatch(/css\/journal\.css\?v=[^"]+"/);
});

// ---- Local-first sessions (2026-11-10) ----
function createForm(h) {
 h.run(`journal.data={serviceSource:'internal',staff:[{id:1,name:'Synthetic'}],services:[{id:70,title:'Synthetic',staffIds:[1],priceMin:100,duration:30}]};jrForm(null,{staffId:1,date:'2030-04-01'})`);
 h.get('jrServices').selectedOptions=[{value:'70'}];h.context.jrRenderServiceChoices();
 h.get('jrTime').value='09:15';h.run(`journal.slots=['09:15']`);
 h.get('jrName').value='Synthetic';h.get('jrPhone').value='70000000000';
 h.context.loadJournal=jest.fn();
}
function createOptions(extra={}) {
 return {local:true,recordId:null,items:[{title:'Synthetic',quantity:1,total:100}],due:100,paid:[],pending:[],history:[],version:null,
  methods:[{method:'account',id:9,title:'Synthetic bank',cash:false,available:true,limit:100,requiresArrivalConfirmation:false,unavailableReason:null,balance:null},
   {method:'account',id:5,title:'Synthetic cash',cash:true,available:true,limit:100,requiresArrivalConfirmation:false,unavailableReason:null,balance:null},
   {method:'loyalty_card',id:10,title:'Бонусы',cash:false,available:true,limit:30,requiresArrivalConfirmation:false,unavailableReason:null,balance:200}],...extra};
}
test('create without payment sends exactly one session and closes the form at once',async()=>{
 const h=harness();createForm(h);
 h.context.jrApi=jest.fn().mockResolvedValue({outboxId:5,recordId:-3,status:'queued'});
 await h.get('jrForm').onsubmit({preventDefault(){}});
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);
 const [url,body]=h.context.jrApi.mock.calls[0];
 expect(url).toBe('sessions');
 expect(body.sessionId).toEqual(expect.any(String));
 expect(body.create).toMatchObject({date:'2030-04-01',time:'09:15',staffId:1,clientName:'Synthetic',clientPhone:'70000000000',serviceIds:[70]});
 expect(body).not.toHaveProperty('payments');expect(body).not.toHaveProperty('recordId');
 expect(h.get('jrModal').open).toBe(false);
 expect(h.context.loadJournal).toHaveBeenCalledWith({silent:true});
 expect(h.context.notify).toHaveBeenCalledWith('Сохранено в журнале. В YClients — кнопкой «Отправить в YClients».');
});
test('create form no longer promises a synchronous YClients check',()=>{
 const h=harness();createForm(h);
 expect(h.get('jrModalBody').innerHTML).not.toContain('Перед сохранением повторно проверим');
});
test('rejected create keeps the form open with the server message',async()=>{
 const h=harness();createForm(h);
 h.context.jrApi=jest.fn().mockRejectedValue(Object.assign(new Error('Время уже занято'),{status:409,code:'busy'}));
 await h.get('jrForm').onsubmit({preventDefault(){}});
 expect(h.get('jrModal').open).toBe(true);expect(h.get('jrModalError').textContent).toBe('Время уже занято');
 expect(h.context.loadJournal).not.toHaveBeenCalled();
});
test('create with «Карта» validates once, chooses methods locally and «Готово» sends create + payments',async()=>{
 const h=harness();createForm(h);
 h.context.jrApi=jest.fn().mockResolvedValueOnce({ok:true,options:createOptions(),overlay:null}).mockResolvedValueOnce({outboxId:6,recordId:-4,status:'queued'});
 h.run(`journal.payAfterCreate='card'`);
 await h.get('jrForm').onsubmit({preventDefault(){}});
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);
 expect(h.context.jrApi.mock.calls[0][0]).toBe('sessions/validate');
 expect(h.context.jrApi.mock.calls[0][1].create).toMatchObject({time:'09:15',staffId:1});
 expect(h.get('jrModalBody').innerHTML).toContain('id="jrPayDone"');
 h.get('jrPayPartial').value='';h.context.jrPayMethod(2);  // bonuses 30
 h.get('jrPayPartial').value='';h.context.jrPayMethod(0);  // rest by card
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);
 const html=h.get('jrModalBody').innerHTML;
 expect(html).toContain('будет передано');expect(html).toContain('Будет оплачено полностью');
 expect(h.run('journal.payment.data.due')).toBe(0);
 await h.get('jrPayDone').onclick();
 expect(h.context.jrApi).toHaveBeenCalledTimes(2);
 const [url,body]=h.context.jrApi.mock.calls[1];
 expect(url).toBe('sessions');
 expect(body.create).toMatchObject({time:'09:15',staffId:1});
 expect(body.payments).toEqual([{method:'loyalty_card',methodId:10,amount:30},{method:'account',methodId:9,amount:70}]);
 expect(body.sessionId).toBe(h.context.jrApi.mock.calls[0][1].sessionId);
 expect(h.get('jrModal').open).toBe(false);
});
test('local recompute reduces due and limits, bonus limit by its own spend, and a queued payment can be dropped',async()=>{
 const h=harness();h.run(`journal.session={sessionId:'s',create:{},payments:[],removePayments:[]};journal.modalRequest=1`);
 h.context.jrPaymentShow(createOptions());
 h.get('jrPayPartial').value='20';h.context.jrPayMethod(2);
 expect(h.run('journal.payment.data.due')).toBe(80);
 expect(h.run('journal.payment.data.methods[2].limit')).toBe(10);
 expect(h.run('journal.payment.data.methods[0].limit')).toBe(80);
 h.get('jrPayPartial').value='';h.context.jrPayMethod(0);
 expect(h.run('journal.payment.data.methods.every(m=>!m.available)')).toBe(true);
 h.context.jrDropPayment(1);
 expect(h.run('journal.payment.data.due')).toBe(80);expect(h.run('journal.session.payments.length')).toBe(1);
});
test('closing a session with unsent payments asks: save sends, discard drops',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session={sessionId:'s',recordId:8,payments:[],removePayments:[]}`);h.get('jrModal').open=true;
 h.context.jrPaymentShow(createOptions());h.context.jrPayMethod(0);
 h.context.jrApi=jest.fn().mockResolvedValue({outboxId:1,recordId:8,status:'queued'});
 h.context.jrClose();
 expect(h.get('jrModal').open).toBe(true);expect(h.get('jrCloseAsk').hidden).toBe(false);
 expect(h.get('jrCloseAsk').innerHTML).toContain('Закрыть без сохранения');
 await h.get('jrCloseSave').onclick();
 expect(h.context.jrApi).toHaveBeenCalledWith('sessions',{sessionId:'s',recordId:8,payments:[{method:'account',methodId:9,amount:100}]});
 expect(h.get('jrModal').open).toBe(false);
 h.run(`journal.session={sessionId:'s2',recordId:8,payments:[],removePayments:[]}`);h.get('jrModal').open=true;
 h.context.jrPaymentShow(createOptions());h.context.jrPayMethod(0);
 h.context.jrClose();h.get('jrCloseDiscard').onclick();
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);expect(h.get('jrModal').open).toBe(false);expect(h.run('journal.session')).toBe(null);
});
function arrivalPaymentData() {
 return {items:[],paid:[],methods:[{method:'account',id:9,available:true,limit:100,title:'Synthetic bank',balance:null,requiresArrivalConfirmation:true},{method:'account',id:5,cash:true,available:true,limit:100,title:'Synthetic cash',balance:null,requiresArrivalConfirmation:true}],due:100,pending:[],history:[],version:null};
}
function paymentApi(local, live) {
 return jest.fn(path=>path.endsWith('?local=1')?Promise.resolve(local):path.startsWith('payments/')?(live instanceof Error?Promise.reject(live):Promise.resolve(live)):Promise.resolve({outboxId:1,status:'queued'}));
}
test('waiting visit: account payment needs the arrival block, then is queued with confirmArrival and later accounts do not ask again',async()=>{
 const h=harness(),data=arrivalPaymentData();data.methods[0].title='<Synthetic bank>';
 h.context.jrApi=paymentApi(data,null);h.context.loadJournal=jest.fn();
 await h.context.jrOpenPayment(8);
 expect(h.get('jrModalBody').innerHTML).toContain('Статус визита станет «Пришёл»');
 h.get('jrPayPartial').value='60';h.context.jrPayMethod(0);
 expect(h.run('journal.session.payments.length')).toBe(0);
 expect(h.get('jrPayArrival').hidden).toBe(false);
 expect(h.get('jrPayArrival').innerHTML).toContain('Оплатить и отметить приход');
 expect(h.get('jrPayArrival').innerHTML).toContain('&lt;Synthetic bank&gt;');
 expect(h.get('jrPayArrival').innerHTML).not.toContain('<Synthetic bank>');
 expect(h.get('jrPayArrival').innerHTML).toContain('60 ₽');
 const confirm=h.get('jrPayArrivalConfirm').onclick;confirm();confirm();
 expect(h.run('JSON.stringify(journal.session.payments)')).toBe(JSON.stringify([{method:'account',methodId:9,amount:60,confirmArrival:true}]));
 expect(h.run('journal.payment.data.methods[1].requiresArrivalConfirmation')).toBe(false);
 h.get('jrPayPartial').value='';h.context.jrPayMethod(1);
 expect(h.run('journal.session.payments[1]')).toEqual({method:'account',methodId:5,amount:40});
 const calls=h.context.jrApi.mock.calls.length;
 await h.get('jrPayDone').onclick();
 expect(h.context.jrApi.mock.calls.length).toBe(calls+1);
 expect(h.context.jrApi.mock.calls[calls]).toEqual(['sessions',expect.objectContaining({recordId:8,payments:[{method:'account',methodId:9,amount:60,confirmArrival:true},{method:'account',methodId:5,amount:40}]})]);
});
test('create session at attendance 0: arrival confirmation lands in the sent payment',async()=>{
 const h=harness();createForm(h);
 const options=createOptions();options.methods[0].requiresArrivalConfirmation=true;
 h.context.jrApi=jest.fn().mockResolvedValueOnce({ok:true,options}).mockResolvedValueOnce({outboxId:7,recordId:-5,status:'queued'});
 h.run(`journal.payAfterCreate='card'`);await h.get('jrForm').onsubmit({preventDefault(){}});
 h.get('jrPayPartial').value='';h.context.jrPayMethod(0);
 expect(h.get('jrPayArrival').innerHTML).toContain('Оплатить и отметить приход');
 h.get('jrPayArrivalConfirm').onclick();
 await h.get('jrPayDone').onclick();
 expect(h.context.jrApi.mock.calls[1][1].payments).toEqual([{method:'account',methodId:9,amount:100,confirmArrival:true}]);
});
test.each(['cancel','input','close'])('%s invalidates a previously displayed arrival approval',async action=>{
 const h=harness();h.context.jrApi=paymentApi(arrivalPaymentData(),null);
 await h.context.jrOpenPayment(8);h.context.jrPayMethod(0);
 const confirm=h.get('jrPayArrivalConfirm').onclick;
 if(action==='cancel')h.get('jrPayArrivalCancel').onclick();
 if(action==='input'){h.get('jrPayPartial').value='50';h.get('jrPayPartial').oninput();}
 if(action==='close')h.context.jrClose();
 confirm();expect(h.run('journal.session?.payments?.length||0')).toBe(0);
});
test('arrival confirmation rechecks the amount before queueing',async()=>{
 const h=harness();h.context.jrApi=paymentApi(arrivalPaymentData(),null);
 await h.context.jrOpenPayment(8);h.context.jrPayMethod(0);
 h.get('jrPayPartial').value='50';h.get('jrPayArrivalConfirm').onclick();
 expect(h.run('journal.session.payments.length')).toBe(0);expect(h.get('jrModalError').textContent).toContain('Сумма изменилась');
});
test('choosing bonuses clears outstanding arrival approval and never consents to a status change',async()=>{
 const h=harness(),data=arrivalPaymentData();data.methods.push({method:'loyalty_card',id:10,available:true,limit:30,title:'Synthetic bonuses'});
 h.context.jrApi=paymentApi(data,null);
 await h.context.jrOpenPayment(8);h.context.jrPayMethod(0);
 const confirm=h.get('jrPayArrivalConfirm').onclick;h.context.jrPayMethod(2);confirm();
 expect(h.run('JSON.stringify(journal.session.payments)')).toBe(JSON.stringify([{method:'loyalty_card',methodId:10,amount:30}]));
});
test('existing record payment form renders from ?local=1 first, then silently takes live data while untouched',async()=>{
 const h=harness();let resolveLive;
 const local={...createOptions(),items:[{title:'LOCAL',quantity:1,total:100}]};
 const live={...createOptions(),items:[{title:'LIVE',quantity:1,total:100}]};
 h.context.jrApi=jest.fn(path=>path.endsWith('?local=1')?Promise.resolve(local):new Promise(r=>{resolveLive=r}));
 const opening=h.context.jrOpenPayment(8);
 expect(h.context.jrApi.mock.calls.map(c=>c[0])).toEqual(['payments/8?local=1','payments/8']);
 await new Promise(r=>setImmediate(r));
 expect(h.get('jrModalBody').innerHTML).toContain('LOCAL');
 resolveLive(live);await opening;
 expect(h.get('jrModalBody').innerHTML).toContain('LIVE');
 expect(h.get('jrModalBody').innerHTML).not.toContain('Повторное проведение заблокировано');
 expect(h.get('jrModalBody').innerHTML).not.toContain('ожидает сверки');
});
test('live data does not replace a form with chosen actions; live failure keeps local silently',async()=>{
 const h=harness();let resolveLive;
 const local={...createOptions(),items:[{title:'LOCAL',quantity:1,total:100}]};
 h.context.jrApi=jest.fn(path=>path.endsWith('?local=1')?Promise.resolve(local):new Promise(r=>{resolveLive=r}));
 const opening=h.context.jrOpenPayment(8);await new Promise(r=>setImmediate(r));
 h.context.jrPayMethod(0);
 resolveLive({...createOptions(),items:[{title:'LIVE',quantity:1,total:100}]});await opening;
 expect(h.get('jrModalBody').innerHTML).toContain('LOCAL');expect(h.run('journal.session.payments.length')).toBe(1);
 const h2=harness();h2.context.jrApi=paymentApi(local,new Error('YClients down'));
 await h2.context.jrOpenPayment(8);
 expect(h2.get('jrModalBody').innerHTML).toContain('LOCAL');expect(h2.get('jrModalError').textContent).toBe('');
});
test('negative (not yet sent) record is paid like any record: methods shown, payment queued for -id (11.11.2026)',async()=>{
 const h=harness();h.context.jrApi=paymentApi(createOptions(),null);h.context.loadJournal=jest.fn();
 await h.context.jrOpenPayment(-3);
 expect(h.context.jrApi.mock.calls.map(c=>c[0])).toEqual(['payments/-3?local=1']);
 const html=h.get('jrModalBody').innerHTML;
 expect(html).not.toContain('Оплата станет доступна после передачи');
 expect(html).toContain('data-method-index');expect(html).toContain('Оплаты визита');
 h.context.jrPayMethod(0);
 expect(h.run('journal.session.payments.length')).toBe(1);
 await h.get('jrPayDone').onclick();
 const call=h.context.jrApi.mock.calls.find(c=>c[0]==='sessions');
 expect(call[1].recordId).toBe(-3);expect(call[1].payments).toEqual([{method:'account',methodId:9,amount:100}]);
});
test('trash on a real paid row queues its removal locally and is sent with «Готово»',async()=>{
 const h=harness();const data={...createOptions(),due:0,paid:[{id:90,method:'account',methodId:9,amount:70,title:'<Cash>'}]};
 h.context.jrApi=paymentApi(data,null);h.context.loadJournal=jest.fn();
 await h.context.jrOpenPayment(8);
 expect(h.get('jrModalBody').innerHTML).toContain('&lt;Cash&gt;');expect(h.get('jrModalBody').innerHTML).toContain('Оплачено полностью');
 const before=h.context.jrApi.mock.calls.length;
 h.context.jrRemovePayment(0);
 expect(h.context.jrApi.mock.calls.length).toBe(before);
 expect(h.get('jrModalBody').innerHTML).toContain('будет удалено');
 expect(h.run('journal.payment.data.due')).toBe(70);
 await h.get('jrPayDone').onclick();
 expect(h.context.jrApi.mock.calls[before]).toEqual(['sessions',{sessionId:expect.any(String),recordId:8,removePayments:[{transactionId:90,method:'account',methodId:9,amount:70}]}]);
});
test('«Готово» without actions just closes; payment markup has no reconciliation or blocking texts',async()=>{
 const h=harness();h.context.jrApi=paymentApi({...createOptions(),pending:[{operation_id:'x',amount:100}],history:[{state:'pending',amount:1,method:'account'}]},null);
 await h.context.jrOpenPayment(8);
 const html=h.get('jrModalBody').innerHTML;
 for(const text of ['Повторное проведение заблокировано','ожидает сверки','Проводим оплату','Оплата проведена в YClients','Проверить результат'])expect(html).not.toContain(text);
 const calls=h.context.jrApi.mock.calls.length;
 h.get('jrPayDone').onclick();
 expect(h.context.jrApi.mock.calls.length).toBe(calls);expect(h.get('jrModal').open).toBe(false);
});
test('payment opening escapes names',async()=>{
 const h=harness();h.context.jrApi=paymentApi({...createOptions(),items:[{title:'<script>bad</script>',quantity:1,total:100}]},null);
 await h.context.jrOpenPayment(8);
 expect(h.get('jrModalBody').innerHTML).toContain('&lt;script&gt;');expect(h.get('jrModalBody').innerHTML).not.toContain('<script>');
});
test('fully paid notice is green sidebar status and includes actual bank transaction',async()=>{
 const h=harness();h.context.jrApi=paymentApi({items:[],methods:[],due:0,pending:[],history:[],paid:[{id:90,method:'account',methodId:9,title:'Банковская карта · Расчетный счет',amount:70},{id:91,method:'loyalty_card',methodId:10,title:'Бонусы',amount:30}]},null);
 await h.context.jrOpenPayment(8);const html=h.get('jrModalBody').innerHTML;
 expect(html).toContain('class="jr-payment-success" role="status"');expect(html.indexOf('Оплачено полностью')).toBeLessThan(html.indexOf('</aside>'));
 expect(html).toContain('Банковская карта · Расчетный счет');
});

function syncDay(sync, id=8) {
 return `journal.data = {date:'2030-04-01',staff:[{id:1,name:'Test',working:true,workRanges:[{start:540,end:720}]}],records:[{id:${id},staffId:1,time:'09:30',duration:30,clientName:'Test',attendance:0,services:[],sync:${JSON.stringify(sync)}}]};jrRender()`;
}
test('grid marks syncing and failed visits; negative ids stay clickable',()=>{
 const h=harness();
 h.run(syncDay({outboxId:1,status:'queued'},-3));
 expect(h.get('jrGrid').innerHTML).toContain('jr-visit-syncing');expect(h.get('jrGrid').innerHTML).toContain('⏳ ');
 expect(h.get('jrGrid').innerHTML).toContain('data-record="-3"');
 h.run(syncDay({outboxId:1,status:'failed',errorText:'<Нет связи>',errorCode:'network'}));
 const html=h.get('jrGrid').innerHTML;
 expect(html).toContain('jr-visit-failed');expect(html).toContain('Не передано в YClients');
 expect(html).toContain('&lt;Нет связи&gt;');expect(html).not.toContain('<Нет связи>');
});
test('failed card shows reason and retry; uncertain hides retry and dismiss; dismiss for any other failed package',async()=>{
 const h=harness();
 const base={id:8,staffId:1,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[]};
 let html=h.context.jrAppointmentCard({...base,sync:{outboxId:4,status:'failed',errorText:'<Сбой>',errorCode:'network'}});
 expect(html).toContain('Не передано в YClients: &lt;Сбой&gt;');expect(html).toContain('id="jrSyncRetry"');
 expect(html).toContain('id="jrSyncDismiss"');expect(html).toContain('Отменить неотправленные изменения');expect(html).not.toContain('Убрать из журнала');
 html=h.context.jrAppointmentCard({...base,sync:{outboxId:4,status:'failed',errorText:'Ответ потерян',errorCode:'uncertain'}});
 expect(html).not.toContain('id="jrSyncRetry"');expect(html).toContain('Нужна сверка в YClients');expect(html).not.toContain('id="jrSyncDismiss"');
 html=h.context.jrAppointmentCard({...base,id:-3,sync:{outboxId:4,status:'failed',errorText:'x',errorCode:'uncertain'}});
 expect(html).not.toContain('id="jrSyncDismiss"');
 html=h.context.jrAppointmentCard({...base,id:-3,sync:{outboxId:4,status:'failed',errorText:'x',errorCode:'busy'}});
 expect(html).toContain('id="jrSyncDismiss"');expect(html).toContain('Убрать из журнала');expect(html).not.toContain('id="jrMove"');expect(html).not.toContain('id="jrCancel"');
 h.context.jrApi=jest.fn().mockResolvedValueOnce({...base,sync:{outboxId:4,status:'failed',errorText:'x',errorCode:'network'}}).mockResolvedValueOnce({ok:true});
 h.context.loadJournal=jest.fn();
 await h.context.jrOpen(8);await h.get('jrSyncRetry').onclick();
 expect(h.context.jrApi.mock.calls[1]).toEqual(['sessions/4/retry',{}]);
 expect(h.get('jrModal').open).toBe(false);expect(h.context.loadJournal).toHaveBeenCalledWith({silent:true});
 h.context.jrApi=jest.fn().mockResolvedValueOnce({...base,sync:{outboxId:5,status:'failed',errorText:'x',errorCode:'rejected'}}).mockResolvedValueOnce({ok:true});
 await h.context.jrOpen(8);await h.get('jrSyncDismiss').onclick();
 expect(h.context.jrApi.mock.calls[1]).toEqual(['sessions/5/dismiss',{}]);
});
test('session key already used (lost response, then edited form): key kept, form closed, journal reloaded',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session = {sessionId:'synthetic-session',recordId:8}`);h.get('jrModal').open=true;
 const used=Object.assign(new Error('Ключ формы уже использован.'),{status:409,code:'session_used'});
 h.context.jrApi=jest.fn().mockRejectedValueOnce(used);
 expect(await h.context.jrSave({sessionId:'synthetic-session',recordId:8,status:'confirm'})).toBe(false);
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);
 expect(h.get('jrModal').open).toBe(false);
 expect(h.context.notify).toHaveBeenCalledWith('Изменения уже сохранены ранее. Проверьте запись в журнале.','err');
 expect(h.context.loadJournal).toHaveBeenCalledWith({silent:true});
 expect(h.run('journal.session')).toBe(null);
});
test('negative record still being sent has no move/confirm/cancel and says so',()=>{
 const h=harness();
 const html=h.context.jrAppointmentCard({id:-3,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[],sync:{outboxId:4,status:'running'}});
 expect(html).toContain('Изменения передаются в YClients');
 for(const id of ['jrMove','jrConfirm','jrCancel'])expect(html).not.toContain(`id="${id}"`);
 expect(html).toContain('id="jrPaymentOpen"');
});
test('unsent new record (manual dispatch) stays editable and says it waits for «Отправить в YClients»',()=>{
 const h=harness();
 const r={id:-3,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[],sync:{outboxId:4,status:'queued',released:false}};
 const html=h.context.jrAppointmentCard(r);
 for(const id of ['jrMove','jrCancel','jrEditServices','jrSaveChanges'])expect(html).toContain(`id="${id}"`);
 expect(html).toContain('ещё не отправлены в YClients');
 expect(html).toContain('data-attendance="1"');
});
test('arrived unsent record: service lines open the editor, note does not say «edit in YClients»',()=>{
 const h=harness();
 const r={id:-3,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:1,paid:false,services:[{id:7,title:'Чистка',cost:3000,quantity:1,unitPrice:3000}],sync:{outboxId:4,status:'queued',released:false}};
 const html=h.context.jrAppointmentCard(r);
 expect(html).toContain('data-service-line');
 expect(html).toContain('id="jrEditServices"');
 expect(html).not.toContain('Изменения этого визита выполняются в YClients');
 expect(html).toContain('Статус, услуги и стоимость можно менять');
 const paid=h.context.jrAppointmentCard({...r,paid:true});
 expect(paid).not.toContain('data-service-line');
});
test('card is tinted by status and follows a status click before saving',()=>{
 const h=harness();
 const modal=h.get('jrModal');modal.dataset={};
 const pills=[0,1,-1,2].map(v=>({dataset:{attendance:String(v)},classList:{add(){},remove(){}},setAttribute(){},removeAttribute(){}}));
 h.get('jrModalBody').querySelectorAll=sel=>sel==='[data-attendance]'||sel==='.jr-state-pill'?pills:[];
 h.context.jrRenderRecord({id:-3,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:1,paid:false,services:[],sync:{outboxId:4,status:'queued',released:false}});
 expect(modal.dataset.status).toBe('1');
 pills[3].onclick();
 expect(modal.dataset.status).toBe('2');
 h.context.jrShowModal('x');
 expect(modal.dataset.status).toBeUndefined();
});
test('released queued package is on its way and locks the card',()=>{
 const h=harness();
 const r={id:42,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[],sync:{outboxId:4,status:'queued',released:true}};
 expect(h.context.jrAppointmentCard(r)).not.toContain('id="jrSaveChanges"');
});
test('confirm and move are sent as one session each',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 const record={id:8,staffId:1,staffName:'Test',date:'2030-04-01',time:'09:15',duration:60,clientName:'Test',attendance:0,paid:false,services:[]};
 h.context.jrApi=jest.fn().mockResolvedValue({outboxId:1,recordId:8,status:'queued'});
 h.context.jrConfirmAction(record,'cancel');await h.get('jrApply').onclick();
 expect(h.context.jrApi.mock.calls[0]).toEqual(['sessions',{sessionId:expect.any(String),recordId:8,status:'cancel'}]);
 h.run(`journal.data={staff:[{id:1,name:'Test'}],services:[]}`);h.context.jrForm(record);
 h.get('jrTime').value='10:00';h.get('jrFormDate').value='2030-04-02';
 await h.get('jrForm').onsubmit({preventDefault(){}});
 expect(h.context.jrApi.mock.calls[1]).toEqual(['sessions',{sessionId:expect.any(String),recordId:8,move:{date:'2030-04-02',time:'10:00',staffId:1}}]);
});
test('polling is scheduled only while a package is queued or running, on the journal page',async()=>{
 const h=harness();h.context.document.body={dataset:{page:'journal'}};
 const day=status=>({date:'2030-04-01',fetchedAt:'2030-04-01T06:00:00Z',staff:[],records:status?[{id:-3,staffId:1,time:'09:00',services:[],sync:{status}}]:[]});
 const timers=[];h.context.setTimeout=jest.fn((fn,ms)=>{timers.push([fn,ms]);return timers.length;});h.context.clearTimeout=jest.fn();
 h.context.jrApi=jest.fn().mockResolvedValue(day('queued'));h.get('jrDate').value='2030-04-01';
 await h.context.loadJournal();
 expect(h.run('journal.pollTimer')).toBeTruthy();expect(timers.at(-1)[1]).toBe(5000);
 h.context.jrApi.mockResolvedValue(day(null));
 await h.context.loadJournal({silent:true});
 expect(h.run('journal.pollTimer')).toBe(null);
 h.context.jrApi.mockResolvedValue(day('running'));h.context.document.body.dataset.page='clients';
 await h.context.loadJournal({silent:true});expect(h.run('journal.pollTimer')).toBe(null);
});
test('silent reload keeps the grid and shows stale mirror freshness',async()=>{
 const h=harness();h.get('jrDate').value='2030-04-01';h.get('jrGrid').innerHTML='OLD GRID';h.get('jrState').textContent='Обновлено 09:00';
 let resolve;h.context.jrApi=jest.fn(()=>new Promise(r=>resolve=r));
 const load=h.context.loadJournal({silent:true});
 expect(h.get('jrGrid').innerHTML).toBe('OLD GRID');expect(h.get('jrState').textContent).toBe('Обновлено 09:00');
 resolve({date:'2030-04-01',fetchedAt:new Date().toISOString(),staff:[],records:[],freshness:{mirrorOkAt:new Date(Date.now()-3600000).toISOString()}});await load;
 expect(h.get('jrState').textContent).toContain('Данные YClients обновлены');
});

test('open syncing card enables editing automatically when its package completes', async () => {
 const h=harness(), timers=[];
 h.context.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
 const r={id:8,attendance:1,services:[],version:'a'.repeat(64),sync:{status:'running'}};
 h.context.jrApi=jest.fn().mockResolvedValueOnce(r).mockResolvedValueOnce({...r,sync:null});
 await h.context.jrOpen(8);
 expect(h.get('jrModalBody').innerHTML).not.toContain('data-attendance=');
 expect(h.get('jrModalBody').innerHTML).toContain('Карточка обновится автоматически');
 expect(timers.at(-1).ms).toBe(2000);
 await timers.at(-1).fn();
 expect(h.get('jrModalBody').innerHTML).toContain('data-attendance="0"');
 expect(h.get('jrModalBody').innerHTML).toContain('id="jrEditServices"');
 expect(h.run('journal.session.recordId')).toBe(8);
 expect(h.run('journal.cardWatch')).toBe(null);
});
test('late syncing card response cannot replace another modal', async () => {
 const h=harness(), timers=[];let resolve;
 h.context.setTimeout=(fn)=>{timers.push(fn);return timers.length;};
 h.context.jrApi=jest.fn().mockResolvedValueOnce({id:8,attendance:1,services:[],sync:{status:'queued'}}).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await h.context.jrOpen(8);
 const refresh=timers.at(-1)();
 h.context.jrShowModal('Другая форма');
 h.get('jrModalBody').innerHTML='NEW FORM';
 resolve({id:8,attendance:1,services:[],sync:null});await refresh;
 expect(h.get('jrModalBody').innerHTML).toBe('NEW FORM');
 expect(h.run('journal.cardWatch')).toBe(null);
});
test('card polling retries a read failure and displays a terminal failure', async () => {
 const h=harness(),timers=[];
 h.context.setTimeout=fn=>{timers.push(fn);return timers.length;};
 const r={id:8,attendance:1,services:[],sync:{status:'queued'}};
 h.context.jrApi=jest.fn().mockResolvedValueOnce(r).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({...r,sync:{status:'failed',outboxId:2,errorText:'Отказ'}});
 await h.context.jrOpen(8);await timers.at(-1)();await timers.at(-1)();
 expect(h.get('jrModalBody').innerHTML).toContain('jrSyncRetry');
 expect(h.run('journal.cardWatch')).toBe(null);
});

test('closing a card with a changed status asks; discard closes without sending (11.11.2026)',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session={sessionId:'s',recordId:8,servicesVersion:'b'.repeat(64),edit:{attendance:1}}`);h.get('jrModal').open=true;
 h.context.jrApi=jest.fn().mockResolvedValue({outboxId:1,recordId:8,status:'queued'});
 h.context.jrClose();
 expect(h.context.jrApi).not.toHaveBeenCalled();expect(h.get('jrModal').open).toBe(true);
 h.get('jrCloseDiscard').onclick();
 expect(h.context.jrApi).not.toHaveBeenCalled();expect(h.get('jrModal').open).toBe(false);expect(h.run('journal.session')).toBe(null);
});
test('closing a card: save sends the edit; keep editing and a second close hide the question',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session={sessionId:'s',recordId:8,servicesVersion:'b'.repeat(64),edit:{attendance:1}}`);h.get('jrModal').open=true;
 h.context.jrApi=jest.fn().mockResolvedValue({outboxId:1,recordId:8,status:'queued'});
 h.context.jrClose();h.get('jrCloseStay').onclick();
 expect(h.get('jrCloseAsk').hidden).toBe(true);expect(h.get('jrModal').open).toBe(true);
 h.context.jrClose();h.context.jrClose();
 expect(h.get('jrCloseAsk').hidden).toBe(true);expect(h.get('jrModal').open).toBe(true);
 h.context.jrClose();await h.get('jrCloseSave').onclick();
 expect(h.context.jrApi).toHaveBeenCalledWith('sessions',{sessionId:'s',recordId:8,edit:{attendance:1,servicesVersion:'b'.repeat(64)}});
 expect(h.get('jrModal').open).toBe(false);
});
test('closing an untouched form closes at once; a touched create form asks',()=>{
 const h=harness();
 h.run(`journal.draft={action:'create'};journal.session={sessionId:'s',create:null,payments:[]};journal.formTouched=false`);h.get('jrModal').open=true;
 h.context.jrClose();expect(h.get('jrModal').open).toBe(false);
 h.run(`journal.draft={action:'create'};journal.session={sessionId:'s',create:null,payments:[]};journal.formTouched=true`);h.get('jrModal').open=true;
 h.get('jrForm');h.get('jrApply').disabled=true;
 h.context.jrClose();
 expect(h.get('jrModal').open).toBe(true);expect(h.get('jrCloseAsk').innerHTML).toContain('Заполнены не все поля');
 expect(h.get('jrCloseAsk').innerHTML).not.toContain('jrCloseSave');
 h.get('jrCloseDiscard').onclick();expect(h.get('jrModal').open).toBe(false);
});

test('visit colours follow the YClients status palette (paid in full = orange, otherwise yellow)',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../frontend/css/journal.css'),'utf8');
 for (const c of ['#9ee5d7','#b3bdfd','#ff8989','#f7c76d','#ffad79','#1ab394']) expect(css).toContain(c);
 expect(css).toMatch(/\.jr-status-1\.jr-paid-full\{--jr-yc:#ffad79/);
 expect(css).toMatch(/data-status="1"\]\[data-paid-full\]/);
 const js=JR_ALL;
 expect(js).toContain("r.paidFull ? ' jr-paid-full' : ''");
 const model=require('./services/journal/model');
 const n=model.normalizeRecord||null;
 if (n) {
  expect(n({id:1,datetime:'2026-11-11T10:00:00+03:00',staff_id:1,attendance:1,paid_full:1}).paidFull).toBe(true);
  expect(n({id:1,datetime:'2026-11-11T10:00:00+03:00',staff_id:1,attendance:1,paid_full:2,paid_amount:500}).paidFull).toBe(false);
 }
});

test('payment from the card after «Пришёл»: the edit is saved first, then the payment form opens (11.11.2026)',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session={sessionId:'s',recordId:8,servicesVersion:'b'.repeat(64),edit:{attendance:1}}`);h.get('jrModal').open=true;
 const calls=[];
 h.context.jrApi=jest.fn(path=>{calls.push(path);return path==='sessions'?Promise.resolve({outboxId:1,recordId:8,status:'queued'}):Promise.resolve({items:[],paid:[],methods:[],due:0,pending:[],history:[],version:null});});
 await h.context.jrPayFromCard(8);
 expect(calls[0]).toBe('sessions');
 expect(h.context.jrApi.mock.calls[0][1]).toEqual({sessionId:'s',recordId:8,edit:{attendance:1,servicesVersion:'b'.repeat(64)}});
 expect(calls).toContain('payments/8?local=1');
 expect(h.get('jrModal').open).toBe(true);
});
test('payment from the card: a failed save keeps the card and does not open payment',async()=>{
 const h=harness();h.context.loadJournal=jest.fn();
 h.run(`journal.session={sessionId:'s',recordId:8,servicesVersion:'b'.repeat(64),edit:{attendance:1}}`);h.get('jrModal').open=true;
 h.context.jrApi=jest.fn().mockRejectedValue(Object.assign(new Error('Конфликт'),{status:409}));
 expect(await h.context.jrPayFromCard(8)).toBe(false);
 expect(h.context.jrApi).toHaveBeenCalledTimes(1);expect(h.get('jrModalError').textContent).toContain('Конфликт');
});
test('payment from the card without changes opens payment directly',async()=>{
 const h=harness();
 h.run(`journal.session={sessionId:'s',recordId:8}`);
 h.context.jrApi=jest.fn().mockResolvedValue({items:[],paid:[],methods:[],due:0,pending:[],history:[],version:null});
 await h.context.jrPayFromCard(8);
 expect(h.context.jrApi.mock.calls.map(c=>c[0])).not.toContain('sessions');
});

test('payment form shows line breakdown, totals, queued payments with badges and escapes HTML',()=>{
 const h=harness();h.run(`journal.session={sessionId:'s',recordId:8,payments:[],removePayments:[]};journal.modalRequest=1`);
 h.context.jrPaymentShow(createOptions({recordId:8,
  items:[{title:'<b>Маска</b>',quantity:3,unitPrice:333.33,gross:999.99,discountPercent:10,discount:100,total:899.99}],
  summary:{gross:999.99,discount:100,total:899.99,paidConfirmed:100,paidQueued:65,bonusSpent:65,due:734.99},due:734.99,
  paid:[{id:1,method:'account',methodId:9,title:'Наличные · <i>Касса</i>',amount:100}],
  payments:[{method:'account',methodId:9,title:'Наличные · <i>Касса</i>',amount:100,status:'confirmed',outboxId:null,kind:'payment'},
   {method:'loyalty_card',methodId:10,title:'Бонусы',amount:65,status:'queued',outboxId:39,kind:'payment'},
   {method:'account',methodId:5,title:'Касса',amount:10,status:'sending',outboxId:40,kind:'payment'},
   {method:'account',methodId:5,title:'Касса',amount:20,status:'failed',outboxId:41,kind:'payment'},
   {method:'account',methodId:9,title:'Касса',amount:30,status:'queued',outboxId:42,kind:'remove_payment'}],
  methods:[{method:'loyalty_card',id:10,title:'Бонусы',cash:false,available:true,limit:30,requiresArrivalConfirmation:false,unavailableReason:null,balance:200,balanceAfter:135}]}));
 const html=h.get('jrModalBody').innerHTML;
 expect(html).toContain('&lt;b&gt;Маска&lt;/b&gt;');expect(html).not.toContain('<b>Маска');expect(html).not.toContain('<i>Касса');
 expect(html).toContain('× 3');expect(html).toContain('скидка −');expect(html).toContain('(10 %)');
 for(const t of ['Без скидки','Скидка','Итого к оплате за визит','Бонусов списано','Остаток к оплате','Баланс бонусов после оплаты','Проведено в YClients','Ждёт отправки в YClients','Передаётся в YClients','Ошибка отправки','Отмена оплаты'])expect(html).toContain(t);
 expect(html).toContain('data-remove-payment="0"');
});
test('payment form falls back to the plain bill for responses without breakdown fields',()=>{
 const h=harness();h.run(`journal.session={sessionId:'s',recordId:8,payments:[],removePayments:[]};journal.modalRequest=1`);
 h.context.jrPaymentShow(createOptions({paid:[{id:1,method:'account',methodId:9,title:'Касса',amount:20}]}));
 const html=h.get('jrModalBody').innerHTML;
 expect(html).toContain('×1');expect(html).toContain('К оплате');expect(html).not.toContain('Без скидки');expect(html).not.toContain('jr-pay-badge');
 expect(html).toContain('data-remove-payment="0"');
});

describe('jrMergeLivePayment',()=>{
 const item={title:'Маска',quantity:3,unitPrice:333.33,gross:999.99,discountPercent:10,discount:100,total:899.99};
 const local=(payments,items=[item])=>({items,payments,paid:[],due:500});
 const live=(over={})=>({items:[{title:'Маска',quantity:3,total:899.99}],paid:[{id:1,method:'loyalty_card',methodId:10,title:'Бонусы',amount:65},{id:2,method:'account',methodId:9,title:'Касса',amount:100}],due:734.99,methods:[],...over});
 test('queued payments keep the local form',()=>{
  const h=harness();const l=local([{status:'queued',kind:'payment',amount:10}]);
  expect(h.context.jrMergeLivePayment(l,live())).toBe(l);
  expect(h.context.jrMergeLivePayment(local([{status:'failed',kind:'remove_payment',amount:1}]),live()).due).toBe(500);
 });
 test('confirmed-only local: live enriched with discount breakdown and mapped paid',()=>{
  const h=harness();const l=local([]);const lv=live();
  const r=h.context.jrMergeLivePayment(l,lv);
  expect(r.items[0].discount).toBe(100);expect(r.paid).toBe(lv.paid);
  expect(JSON.parse(JSON.stringify(r.payments[0]))).toEqual({method:'loyalty_card',methodId:10,title:'Бонусы',amount:65,status:'confirmed',kind:'payment',outboxId:null});
  expect(JSON.parse(JSON.stringify(r.summary))).toEqual({gross:999.99,discount:100,total:899.99,paidConfirmed:165,paidQueued:0,bonusSpent:65,due:734.99});
 });
 test('mismatched items fall back to live items',()=>{
  const h=harness();const r=h.context.jrMergeLivePayment(local([]),live({items:[{title:'Другое',quantity:1,total:50}]}));
  expect(r.items[0].title).toBe('Другое');expect(r.summary.gross).toBe(50);expect(r.summary.discount).toBe(0);
 });
 test('no local: live as is',()=>{const h=harness();const lv=live();expect(h.context.jrMergeLivePayment(null,lv)).toBe(lv);});
});

// ---- Parity grid (12.11.2026) ----
const PARITY_DAY = `journal.data = {date:'2030-04-01',labels:[{id:3,title:'<b>VIP</b>',color:'#ff0000'}],
  staff:[{id:1,name:'Test',working:true,workRanges:[{start:540,end:660},{start:720,end:840}]}],
  records:[{id:8,staffId:1,date:'2030-04-01',time:'09:30',duration:60,clientName:'Анна',attendance:0,services:[{title:'Чистка'}],
    customColor:'#f4a0a0',fontColor:null,labels:[{id:3,title:'',color:''}],online:true,isNew:true,paidFull:false,comment:'Позвонить',technicalBreak:900}]}`;
test('visit block: custom colour wins, contrast text, label dots resolved from the salon list and escaped', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toContain('--jr-yc:#f4a0a0;--jr-yc-bd:#f4a0a0;color:#333');
  expect(html).toContain('class="jr-label-dot" style="background:#ff0000" title="&lt;b&gt;VIP&lt;/b&gt;"');
  expect(html).not.toContain('<b>VIP</b>');
  for (const t of ['Онлайн-запись', 'Новый клиент', 'Есть комментарий']) expect(html).toContain(`title="${t}"`);
  expect(html).not.toContain('title="Оплачено"');
});
test('technical break band under the visit; the break time is busy', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toMatch(/class="jr-break-band"[^>]*title="Технический перерыв 15 мин"/);
  expect(html).not.toContain('data-time="10:30"');   // 09:30 + 60 + 15 → 10:45
  expect(html).toContain('data-time="10:45"');
});
test('break between two shift intervals is its own cell with a label once', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect((html.match(/jr-cell-break/g) || []).length).toBe(4);   // 11:00–12:00 = 4 quarters
  expect((html.match(/>Перерыв</g) || []).length).toBe(1);
});
test('custom colours only as #rrggbb; an injected colour is ignored', () => {
  const h = harness();
  expect(h.context.jrVisitStyle({ customColor: 'red;background:url(x)' })).toBe('');
  expect(h.context.jrVisitStyle({ customColor: '#000000' })).toBe('--jr-yc:#000000;--jr-yc-bd:#000000;color:#fff;');
  expect(h.context.jrVisitStyle({ customColor: '#ffffff', fontColor: '#123456' })).toBe('--jr-yc:#ffffff;--jr-yc-bd:#ffffff;color:#123456;');
  expect(h.context.jrContrastColor('#f7c76d')).toBe('#333');
});
test('columns carry staff and date for drag-and-drop', () => {
  const h = harness(); h.run(PARITY_DAY + ';jrRender()');
  expect(h.get('jrGrid').innerHTML).toContain('<div class="jr-column" data-staff="1" data-date="2030-04-01">');
});
test('print: toolbar button and print stylesheet keep colours', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  expect(html).toContain('id="jrPrint"');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  expect(css).toMatch(/@media print\{[^]*print-color-adjust:exact/);
  expect(css).toContain('.jr-cell-break');
});

test('technical break occupies the lane; paid mark appears with paidFull', () => {
  const h = harness();
  const l = h.context.jrLayout([{ id: 1, time: '10:00', duration: 30, technicalBreak: 1800 }, { id: 2, time: '10:45', duration: 30 }]);
  expect(l[0].lane).not.toBe(l[1].lane);
  expect(h.context.jrVisitMarks({ paidFull: true })).toContain('title="Оплачено"');
  expect(h.context.jrVisitMarks({})).toBe('');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  expect(css).not.toContain('[style*=');
});

const WEEK = { from: '2030-04-01', to: '2030-04-07', staff: { id: 1, name: 'Юлия' }, allStaff: [{ id: 1, name: 'Юлия' }], labels: [],
  days: ['01', '02', '03', '04', '05', '06', '07'].map((d, i) => ({ date: `2030-04-${d}`, working: i === 0, workRanges: i === 0 ? [{ start: 540, end: 720 }] : [],
    records: i === 0 ? [{ id: 8, staffId: 1, date: '2030-04-01', time: '10:00', duration: 60, clientName: 'Анна', attendance: 0, services: [] }] : [] })) };
const DAY = { date: '2030-04-03', fetchedAt: '2030-04-03T06:00:00Z', staff: [{ id: 1, name: 'Юлия', working: true, workRanges: [] }], records: [], services: [], categories: [], labels: [] };
test('week view loads day and week together and renders 7 date columns of one master', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03';
  h.context.jrApi = jest.fn(async p => (p.startsWith('week') ? WEEK : DAY));
  h.context.jrUpdateDispatchButton = jest.fn();   // harness nodes have no classList
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.context.jrApi.mock.calls.map(c => c[0])).toEqual(['day?date=2030-04-03', 'week?date=2030-04-03']);
  const html = h.get('jrGrid').innerHTML;
  expect((html.match(/<div class="jr-column"/g) || []).length).toBe(7);
  expect(html).toContain('пн 01.04');
  expect(html).toContain('data-date="2030-04-07"');
  expect(html).toContain('data-record="8"');
  expect(h.run('journal.data.date')).toBe('2030-04-03');
});
test('week: staff filter is sent; arrows move by 7 days', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03'; h.get('jrStaffFilter').value = '1';
  h.context.jrApi = jest.fn(async p => (p.startsWith('week') ? WEEK : DAY));
  h.context.jrUpdateDispatchButton = jest.fn();   // harness nodes have no classList
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.context.jrApi.mock.calls[1][0]).toBe('week?date=2030-04-03&staffId=1');
  h.context.loadJournal = jest.fn();
  h.context.jrShift(1);
  expect(h.get('jrDate').value).toBe('2030-04-10');
});
test('week: a free cell of another day opens the form on that day', () => {
  const h = harness();
  h.run(`journal.view='week'; journal.data = ${JSON.stringify(DAY)}; journal.week = ${JSON.stringify(WEEK)};`);
  h.context.jrForm = jest.fn();
  h.context.jrGridCreate(1, '09:00', '2030-04-01');
  expect(h.context.jrForm).toHaveBeenCalledWith(null, { staffId: 1, time: '09:00', date: '2030-04-01' });
  h.context.jrGridCreate(1, '09:00', '2030-04-02');   // day off
  expect(h.context.jrForm).toHaveBeenCalledTimes(1);
});
test('month cells start on Monday and carry density', () => {
  const h = harness();
  const cells = h.context.jrMonthCells('2026-11', [{ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 }]);
  expect(cells).toHaveLength(36);                    // 1 Nov 2026 is a Sunday: 6 blanks
  expect(cells.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(cells[7]).toEqual({ date: '2026-11-02', day: 2, records: 12, density: 2 });
  expect(h.context.jrMonthAdd('2026-12', 1)).toBe('2027-01');
});
test('month picker renders days with dots and survives an API error', async () => {
  const h = harness(); h.get('jrDate').value = '2026-11-12';
  h.context.jrApi = jest.fn().mockResolvedValue({ month: '2026-11', days: [{ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 }] });
  await h.context.jrMonthPicker();
  expect(h.context.jrApi).toHaveBeenCalledWith('month?month=2026-11');
  const html = h.get('jrMonth').innerHTML;
  expect(html).toContain('data-month-date="2026-11-02"');
  expect(html).toContain('jr-density-2');
  expect(html).toContain('data-month-date="2026-11-12" title="Записей: 0"');
  expect(h.get('jrMonth').hidden).toBe(false);
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('<b>нет связи</b>'));
  await h.context.jrMonthPicker('2026-12');
  expect(h.get('jrMonth').innerHTML).toContain('&lt;b&gt;нет связи');
});
test('phone (≤700px): one master and chips; week is not offered', async () => {
  const h = harness(); h.context.window = { matchMedia: q => ({ matches: q === '(max-width: 700px)' }) };
  h.get('jrWorkingOnly').checked = false;
  h.run(`journal.data = {date:'2030-04-01',labels:[],staff:[{id:1,name:'Юлия',working:true,workRanges:[]},{id:2,name:'Пери',working:true,workRanges:[]}],records:[]}; jrRender()`);
  expect((h.get('jrGrid').innerHTML.match(/<div class="jr-column"/g) || []).length).toBe(1);
  expect(h.get('jrStaffChips').hidden).toBe(false);
  expect(h.get('jrStaffChips').innerHTML).toContain('data-chip="2"');
  h.context.loadJournal = jest.fn();
  h.context.jrSetView('week');
  expect(h.run('journal.view')).toBe('day');
});
test('the 700px threshold is the same in JS and CSS', () => {
  const h = harness();
  expect(h.run('JR_MOBILE_MAX')).toBe(700);
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  expect(css).toMatch(/@media \(max-width:700px\)\{\s*#jrViewWeek\{display:none\}/);
});

test('month: days without schedule data (density null) render neutral, no dots', async () => {
  const h = harness(); h.get('jrDate').value = '2026-11-12';
  h.context.jrApi = jest.fn().mockResolvedValue({ days: [{ date: '2026-11-02', records: 1, workingStaff: 0, density: null }] });
  expect(h.context.jrMonthCells('2026-11', [{ date: '2026-11-02', records: 1, density: null }])[7].density).toBeNull();
  await h.context.jrMonthPicker();
  expect(h.get('jrMonth').innerHTML).toContain('jr-density-none');
});
test('print rules are scoped to the journal page (no bare .topbar / #app)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/journal.css'), 'utf8');
  const print = css.slice(css.indexOf('@media print{'));
  const block = print.slice(0, print.indexOf('\n}\n') + 3);
  for (const sel of ['.topbar', '.mnav-drawer', '#app', '#app::before', '.content']) {
    const bare = new RegExp('(^|[,\\s{])' + sel.replace(/[.#:]/g, '\\$&') + '(?=[,{\\s])', 'gm');
    for (const mm of block.matchAll(bare)) expect(block.slice(Math.max(0, mm.index - 25), mm.index + 1)).toContain('body[data-page="journal"]');
  }
});

test('week: staff filter is built from week.allStaff and keeps the master across an off-day week', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03'; h.get('jrStaffFilter').value = '2';
  const w = { ...WEEK, staff: { id: 2, name: 'Пери' }, allStaff: [{ id: 1, name: 'Юлия' }, { id: 2, name: 'Пери' }] };
  h.context.jrApi = jest.fn(async p => (p.startsWith('week') ? w : { ...DAY, staff: [{ id: 1, name: 'Юлия', working: true, workRanges: [] }] }));
  h.context.jrUpdateDispatchButton = jest.fn();
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.get('jrStaffFilter').innerHTML).toContain('value="2"');
  expect(h.get('jrStaffFilter').innerHTML).not.toContain('Все сотрудники');
  expect(h.get('jrStaffFilter').value).toBe('2');
  h.context.jrShift(1);
  await new Promise(r => setTimeout(r, 0));
  expect(h.get('jrStaffFilter').value).toBe('2');
  expect(h.context.jrApi.mock.calls.at(-1)[0]).toBe('week?date=2030-04-10&staffId=2');
});
test('forced day on phone syncs the view buttons', async () => {
  const h = harness(); h.context.window = { matchMedia: () => ({ matches: true }) };
  const week = h.get('jrViewWeek'); week.classList = { toggle: jest.fn() }; week.setAttribute = jest.fn();
  h.context.jrApi = jest.fn(async () => DAY); h.context.jrUpdateDispatchButton = jest.fn();
  h.run(`journal.view = 'week'`);
  await h.context.loadJournal();
  expect(h.run('journal.view')).toBe('day');
  expect(week.classList.toggle).toHaveBeenCalledWith('is-active', false);
  expect(week.setAttribute).toHaveBeenCalledWith('aria-pressed', 'false');
});
test('day view makes exactly one request (no week)', async () => {
  const h = harness(); h.get('jrDate').value = '2030-04-03';
  h.context.jrApi = jest.fn(async () => DAY); h.context.jrUpdateDispatchButton = jest.fn();
  await h.context.loadJournal();
  expect(h.context.jrApi.mock.calls.map(c => c[0])).toEqual(['day?date=2030-04-03']);
});
test('month button toggles: second press closes without a request', async () => {
  const h = harness(); h.get('jrDate').value = '2026-11-12';
  h.context.jrApi = jest.fn().mockResolvedValue({ days: [] });
  await h.context.jrMonthPicker();
  await h.context.jrMonthPicker();
  expect(h.context.jrApi).toHaveBeenCalledTimes(1);
  expect(h.get('jrMonth').hidden).toBe(true);
});
test('week: queue polling looks at records of every day of the week', () => {
  const h = harness();
  h.context.document.body = { dataset: { page: 'journal' } };
  h.run(`journal.view='week'; journal.data={records:[]}; journal.week={days:[{records:[]},{records:[{id:1,sync:{status:'queued',released:true}}]}]}; jrSchedulePoll()`);
  expect(h.run('journal.pollTimer')).toBeTruthy();
  h.run('clearTimeout(journal.pollTimer)');
});
test('phone with no staff keeps the chips strip hidden', () => {
  const h = harness(); h.context.window = { matchMedia: () => ({ matches: true }) };
  h.get('jrWorkingOnly').checked = true;
  h.run(`journal.data = {date:'2030-04-01',labels:[],staff:[],records:[]}; jrRender()`);
  expect(h.get('jrStaffChips').hidden).toBe(true);
});
// ---- Drag-and-drop (12.11.2026): synthetic pointer events ----
const DRAG_DAY = `journal.view='day'; journal.data = {date:'2030-04-01',labels:[],
  staff:[{id:1,name:'Юлия',working:true,workRanges:[{start:540,end:1080}]},{id:2,name:'Пери',working:true,workRanges:[{start:540,end:1080}]}],
  records:[{id:8,staffId:1,date:'2030-04-01',time:'10:00',duration:60,clientName:'Анна',attendance:0,services:[]},
           {id:9,staffId:2,date:'2030-04-01',time:'12:00',duration:60,clientName:'Борис',attendance:0,services:[]}]}`;
const columnAt = (staff, date) => () => ({ closest: () => ({ dataset: { staff: String(staff), date } }) });
function dragHarness() {
  const h = harness(); h.run(DRAG_DAY);
  h.context.confirm = jest.fn(() => true);
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 3, recordId: 8, status: 'queued' });
  h.context.loadJournal = jest.fn(); h.context.jrRender = jest.fn();
  return h;
}
test('drag: move to another master, confirmed, sends one move session', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(2, '2030-04-01');
  expect(h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move')).toBe(true);
  h.context.jrDragMove({ clientX: 300, clientY: 100 + 240 * 1.6 });
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 + 240 * 1.6 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 14:00 к специалисту Пери?');
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-1', recordId: 8, move: { date: '2030-04-01', time: '14:00', staffId: 2 } });
  expect(h.context.loadJournal).toHaveBeenCalledWith({ silent: true });
  expect(h.run('journal.drag')).toBe(null);
});
test('drag: 5-minute grid; cancelling the confirmation changes nothing', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.confirm = jest.fn(() => false);
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 37 * 1.6 })).toBe(false);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 10:35 к специалисту Юлия?');
  expect(h.context.jrApi).not.toHaveBeenCalled();
  expect(h.context.jrRender).toHaveBeenCalled();
});
test('drag: over another visit of that master is refused before asking', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(2, '2030-04-01');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 + 120 * 1.6 })).toBe(false);   // 12:00 at Пери = Борис
  expect(h.context.notify).toHaveBeenCalledWith('Время занято другой записью.', 'err');
  expect(h.context.confirm).not.toHaveBeenCalled();
  expect(h.context.jrApi).not.toHaveBeenCalled();
});
test('drag: outside the shift is refused', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 450 * 1.6 })).toBe(false);   // 17:30 + 60 > 18:00
  expect(h.context.notify).toHaveBeenCalledWith('Это время вне рабочего графика специалиста.', 'err');
});
test('resize: confirmed new length goes as edit.seanceLength', async () => {
  const h = dragHarness();
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'resize');
  h.context.jrDragMove({ clientX: 100, clientY: 100 + 15 * 1.6 });
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 15 * 1.6 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Длительность 60 → 75 мин?');
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-1', recordId: 8, edit: { seanceLength: 75 } });
});
test('server refusal: message shown, block returns', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  h.context.jrApi = jest.fn().mockRejectedValue(Object.assign(new Error('Время уже занято. Выберите другое.'), { status: 409, code: 'slot_taken' }));
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 60 * 1.6 })).toBe(false);
  expect(h.context.notify).toHaveBeenCalledWith('Время уже занято. Выберите другое.', 'err');
  expect(h.context.jrRender).toHaveBeenCalled();
  expect(h.context.loadJournal).not.toHaveBeenCalled();
});
test('a tiny movement is a click; locked records do not start a drag', async () => {
  const h = dragHarness();
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 101, clientY: 102 })).toBe(false);
  expect(h.context.confirm).not.toHaveBeenCalled();
  const base = { id: 1, time: '10:00', attendance: 0 };
  expect(h.context.jrDragAllowed(base)).toBe(true);
  for (const r of [{ ...base, continued: true }, { ...base, paid: true }, { ...base, deleted: true }, { ...base, attendance: 1 }, { ...base, attendance: -1 },
    { ...base, sync: { status: 'running', released: true } }, { ...base, sync: { status: 'failed' } }]) expect(h.context.jrDragAllowed(r)).toBe(false);
  expect(h.context.jrDragAllowed({ ...base, sync: { status: 'queued', released: false } })).toBe(true);
  expect(h.context.jrDragStart({ button: 2, clientX: 0, clientY: 0 }, 8, 'move')).toBe(false);
});
test('week: dropping on another day of the same master', async () => {
  const h = dragHarness();
  h.run(`journal.view='week'; journal.week = {staff:{id:1,name:'Юлия'},days:[
    {date:'2030-04-01',workRanges:[{start:540,end:1080}],records:[{id:8,staffId:1,date:'2030-04-01',time:'10:00',duration:60,clientName:'Анна',attendance:0,services:[]}]},
    {date:'2030-04-02',workRanges:[{start:540,end:1080}],records:[]}]}`);
  h.context.document.elementFromPoint = columnAt(1, '2030-04-02');
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  expect(await h.context.jrDragEnd({ clientX: 300, clientY: 100 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Перенести запись Анна на 02.04 10:00 к специалисту Юлия?');
  expect(h.context.jrApi.mock.calls[0][1].move).toEqual({ date: '2030-04-02', time: '10:00', staffId: 1 });
});
test('draggable blocks get the resize handle', () => {
  const h = harness(); h.run(DRAG_DAY + ';jrRender()');
  const html = h.get('jrGrid').innerHTML;
  expect(html).toContain('jr-draggable" data-record="8"');
  expect(html).toContain('<i class="jr-resize" data-resize="1" aria-hidden="true"></i>');
});
test('jrDropCheck: past time refused; the technical break of a neighbour counts as busy', () => {
  const h = harness();
  const staff = { id: 1, workRanges: [{ start: 540, end: 1080 }] };
  const record = { id: 8, staffId: 1, time: '10:00', duration: 60 };
  const now = Date.parse('2030-04-01T12:00:00+03:00');
  expect(h.context.jrDropCheck({ record, staff, date: '2030-04-01', minute: 660, duration: 60, records: [], now }).reason).toBe('Это время уже прошло.');
  const neighbour = { id: 9, staffId: 1, date: '2030-04-01', time: '13:00', duration: 60, technicalBreak: 900 };   // busy till 14:15
  expect(h.context.jrDropCheck({ record, staff, date: '2030-04-01', minute: 840, duration: 60, records: [neighbour], now: 0 }).ok).toBe(false);
  expect(h.context.jrDropCheck({ record, staff, date: '2030-04-01', minute: 855, duration: 60, records: [neighbour], now: 0 }).ok).toBe(true);
  // Another master's visit at the same time does not block.
  expect(h.context.jrDropCheck({ record, staff, date: '2030-04-01', minute: 780, duration: 60, records: [{ ...neighbour, staffId: 2 }], now: 0 }).ok).toBe(true);
});
test('phone: no drag handle and no drag start; a background render waits for the drop', () => {
  const h = harness(); h.context.window = { matchMedia: () => ({ matches: true }) };
  h.run(DRAG_DAY + ';jrRender()');
  expect(h.get('jrGrid').innerHTML).not.toContain('jr-resize');
  const el = { dataset: { record: '8' } };
  h.context.jrDragBegin(el, { button: 0, clientX: 0, clientY: 0, target: {} });
  expect(h.run('journal.drag')).toBeFalsy();
  const d = harness(); d.run(DRAG_DAY + ';jrRender()');
  d.run(`journal.drag = {moved:true}`); d.get('jrGrid').innerHTML = 'kept';
  d.context.jrRender();
  expect(d.get('jrGrid').innerHTML).toBe('kept');
});
// ---- Drag review fixes (13.11.2026) ----
function dragDom(h) {
  const on = { doc: {}, win: {} };
  const add = box => jest.fn((type, fn) => { (box[type] = box[type] || []).push(fn); });
  const remove = box => jest.fn((type, fn) => { box[type] = (box[type] || []).filter(x => x !== fn); });
  Object.assign(h.context.document, { addEventListener: add(on.doc), removeEventListener: remove(on.doc) });
  h.context.window = { addEventListener: add(on.win), removeEventListener: remove(on.win) };
  const fire = (box, type, ev) => (box[type] || []).slice().forEach(fn => fn(ev));
  return { on, fire };
}
const dragEl = (record, date, draggable = true) => ({ dataset: { record: String(record) }, style: {},
  classList: { contains: c => draggable && c === 'jr-draggable', add: jest.fn(), remove: jest.fn() },
  closest: () => ({ dataset: { date } }) });
test('drag review: week «continuation» with the same id never starts a drag; non-draggable blocks are ignored', () => {
  const h = dragHarness(); dragDom(h);
  h.run(`journal.view='week'; journal.week = {staff:{id:1,name:'Юлия'},days:[
    {date:'2030-04-01',workRanges:[{start:540,end:1440}],records:[{id:8,staffId:1,date:'2030-04-01',time:'22:00',duration:240,clientName:'Анна',attendance:0,services:[]}]},
    {date:'2030-04-02',workRanges:[{start:0,end:1080}],records:[{id:8,staffId:1,date:'2030-04-02',time:'00:00',duration:120,continued:true,clientName:'Анна',attendance:0,services:[]}]}]}`);
  expect(h.context.jrDragStart({ button: 0, clientX: 0, clientY: 0 }, 8, 'move', '2030-04-02')).toBe(false);
  expect(h.context.jrDragStart({ button: 0, clientX: 0, clientY: 0 }, 8, 'move', '2030-04-01')).toBe(true);
  h.run('journal.drag = null');
  h.context.jrDragBegin(dragEl(8, '2030-04-02', false), { button: 0, clientX: 0, clientY: 0, target: {} });
  expect(h.run('journal.drag')).toBeFalsy();
  h.context.jrDragBegin(dragEl(8, '2030-04-02', true), { button: 0, clientX: 0, clientY: 0, target: {} });
  expect(h.run('journal.drag')).toBeFalsy();
  h.context.jrDragBegin(dragEl(8, '2030-04-01', true), { button: 0, clientX: 0, clientY: 0, target: {} });
  expect(h.run('journal.drag.record.continued')).toBeFalsy();
});
test('drag review: lost pointerup — blur, Escape or a move without buttons cancels and restores the block', () => {
  for (const lose of ['blur', 'escape', 'buttons']) {
    const h = dragHarness(); const { on, fire } = dragDom(h);
    h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
    const el = dragEl(8, '2030-04-01');
    h.context.jrDragBegin(el, { button: 0, clientX: 100, clientY: 100, target: {} });
    fire(on.doc, 'pointermove', { clientX: 100, clientY: 160, buttons: 1 });
    expect(el.style.pointerEvents).toBe('none');
    if (lose === 'blur') fire(on.win, 'blur', {});
    else if (lose === 'escape') fire(on.doc, 'keydown', { key: 'Escape' });
    else fire(on.doc, 'pointermove', { clientX: 100, clientY: 170, buttons: 0 });
    expect({ lose, drag: h.run('journal.drag'), pe: el.style.pointerEvents, tr: el.style.transform }).toEqual({ lose, drag: null, pe: '', tr: '' });
    expect(h.context.jrRender).toHaveBeenCalled();
    expect([...Object.values(on.doc), ...Object.values(on.win)].every(list => list.length === 0)).toBe(true);
    fire(on.doc, 'pointerup', { clientX: 100, clientY: 200 });
    expect(h.context.confirm).not.toHaveBeenCalled();
  }
});
test('drag review: a new drag removes the listeners of an unfinished one', () => {
  const h = dragHarness(); const { on } = dragDom(h);
  h.context.jrDragBegin(dragEl(8, '2030-04-01'), { button: 0, clientX: 0, clientY: 0, target: {} });
  h.context.jrDragBegin(dragEl(8, '2030-04-01'), { button: 0, clientX: 0, clientY: 0, target: {} });
  expect(on.doc.pointerup.length).toBe(1);
  expect(on.win.blur.length).toBe(1);
});
test('drag review: jrDragAllowed follows the card rule; resize of a visit without length starts from 15', async () => {
  const h = dragHarness();
  const base = { id: 1, time: '10:00', attendance: 0 };
  expect(h.context.jrDragAllowed({ ...base, attendance: 2 })).toBe(true);
  expect(h.context.jrDragAllowed({ ...base, time: '' })).toBe(false);
  h.run(`journal.data.records[0].duration = 0`);
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'resize');
  expect(await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 15 * 1.6 })).toBe(true);
  expect(h.context.confirm).toHaveBeenCalledWith('Длительность 15 → 30 мин?');
});
test('drag review: click suppression is armed after the confirmation, not before it', async () => {
  const h = dragHarness(); h.context.document.elementFromPoint = columnAt(1, '2030-04-01');
  let armedAtConfirm = null;
  h.context.confirm = jest.fn(() => { armedAtConfirm = h.run('journal.suppressClickUntil || 0'); return false; });
  h.context.jrDragStart({ button: 0, clientX: 100, clientY: 100 }, 8, 'move');
  const before = Date.now();
  await h.context.jrDragEnd({ clientX: 100, clientY: 100 + 60 * 1.6 });
  expect(armedAtConfirm).toBe(0);
  expect(h.run('journal.suppressClickUntil')).toBeGreaterThanOrEqual(before + 400);
});
test('drag review: a plain click and a cancelled resize keep the rendered block height', async () => {
  const h = dragHarness(); const { on, fire } = dragDom(h);
  const el = dragEl(8, '2030-04-01'); el.style.height = '94px';
  h.context.jrDragBegin(el, { button: 0, clientX: 100, clientY: 100, target: {} });
  fire(on.doc, 'pointerup', { clientX: 100, clientY: 101 });
  await Promise.resolve();
  expect(el.style.height).toBe('94px');
  h.context.confirm = jest.fn(() => false);
  h.context.jrDragBegin(el, { button: 0, clientX: 100, clientY: 100, target: { dataset: { resize: '1' } } });
  fire(on.doc, 'pointermove', { clientX: 100, clientY: 124, buttons: 1 });
  expect(el.style.height).not.toBe('94px');
  fire(on.doc, 'pointerup', { clientX: 100, clientY: 124 });
  await Promise.resolve();
  expect(h.context.confirm).toHaveBeenCalledWith('Длительность 60 → 75 мин?');
  expect(el.style.height).toBe('94px');
});
// ---- Card parity (12.11.2026) ----
const CARD = { id: 8, staffId: 1, staffName: 'Юлия', date: '2030-04-01', time: '09:15', duration: 60, clientName: 'Анна', clientPhone: '79200255591',
  attendance: 0, paid: false, services: [{ id: 900, title: 'Чистка', cost: 3000 }], comment: '', labels: [{ id: 3, title: '', color: '' }],
  customColor: '#f4a0a0', technicalBreak: 600, notifyClient: false };
const cardHarness = () => {
  const h = harness();
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,name:'Юлия'}],services:[{id:70,yclientsId:900,title:'Чистка',staffIds:[1]}],labels:[{id:3,title:'<i>VIP</i>',color:'#ff0000'},{id:4,title:'Важно',color:'#00ff00'}]}`);
  return h;
};
test('card shows phone, editable comment, duration, break, palette, labels and the notify flag', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard(CARD);
  expect(html).toContain('<a href="tel:+79200255591">+79200255591</a>');
  expect(html).toContain('id="jrCopyPhone"');
  expect(html).toMatch(/<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан">/);
  expect(html).toMatch(/id="jrDurationEdit" type="number" min="5" max="720" step="5" value="60">/);
  expect(html).toContain('<option value="10" selected>10 мин</option>');
  expect((html.match(/data-color="/g) || []).length).toBe(9);
  expect(html).toContain('class="jr-color is-current" data-color="#f4a0a0"');
  expect(html).toContain('data-label="3" checked');
  expect(html).toContain('&lt;i&gt;VIP&lt;/i&gt;');
  expect(html).toContain('id="jrNoNotify" checked');
  expect(html).toContain('id="jrDelete"');
  expect(html).toContain('id="jrRebook"');
  expect(html).toContain('id="jrChangeClient"');
});
test('arrived unpaid visit: comment/colour editable; duration, client and delete are not', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard({ ...CARD, attendance: 1 });
  expect(html).toContain('<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан">');
  expect(html).toMatch(/id="jrDurationEdit"[^>]* disabled>/);
  expect(html).not.toContain('id="jrDelete"');
  expect(html).not.toContain('id="jrChangeClient"');
  const paid = h.context.jrAppointmentCard({ ...CARD, paid: true });
  expect(paid).toContain('<textarea id="jrCommentEdit" rows="4" maxlength="1000" placeholder="Комментарий не указан" readonly>');
});
test('card edits go into one session: comment, duration, break, colour, labels, notify', async () => {
  const h = cardHarness();
  h.context.jrRenderRecord({ ...CARD, notifyClient: true, customColor: null, labels: [] });
  h.get('jrCommentEdit').value = 'Позвонить'; h.get('jrCommentEdit').oninput();
  h.get('jrDurationEdit').value = '75'; h.get('jrDurationEdit').onchange();
  h.get('jrBreakEdit').value = '10'; h.get('jrBreakEdit').onchange();
  h.get('jrNoNotify').checked = true; h.get('jrNoNotify').onchange();
  h.context.jrCardEdit('customColor', '#f4a0a0');
  h.context.jrCardEdit('labelIds', [3]);
  expect(h.get('jrSaveChanges').disabled).toBe(false);
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 1, recordId: 8, status: 'queued' }); h.context.loadJournal = jest.fn();
  await h.get('jrSaveChanges').onclick();
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', expect.objectContaining({ recordId: 8,
    edit: { comment: 'Позвонить', seanceLength: 75, technicalBreak: 600, notifyClient: false, customColor: '#f4a0a0', labelIds: [3] } }));
});
test('an invalid duration is not put into the session', () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.get('jrDurationEdit').value = '7'; h.get('jrDurationEdit').onchange();
  expect(h.run('journal.session.edit')).toBeFalsy();
  expect(h.get('jrModalError').textContent).toContain('кратно 5');
});
test('change client: the card search picks a client into edit.client', () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.context.jrLoadClients = jest.fn();
  h.get('jrChangeClient').onclick();
  expect(h.get('jrChangeClientBox').hidden).toBe(false);
  const pick = h.context.jrLoadClients.mock.calls[0][1];
  pick({ name: '<b>Борис</b>', phone: '+79000000001' });
  expect(h.run('journal.session.edit.client')).toEqual({ name: '<b>Борис</b>', phone: '79000000001' });
  expect(h.get('jrClientName').textContent).toContain('Борис');
  pick({ name: 'Без телефона', phone: '' });
  expect(h.context.notify).toHaveBeenCalledWith(expect.stringContaining('телефона'), 'err');
});
test('delete: own confirmation explains the difference from cancel; unsaved edits travel with it', async () => {
  const h = cardHarness();
  h.context.jrRenderRecord(CARD);
  h.context.jrCardEdit('notifyClient', true);
  h.context.jrDeleteRecord(CARD);
  expect(h.get('jrModalBody').innerHTML).toContain('отличие от отмены');
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 2, recordId: 8, status: 'queued' }); h.context.loadJournal = jest.fn();
  await h.get('jrApply').onclick();
  expect(h.context.jrApi).toHaveBeenCalledWith('sessions', { sessionId: 'synthetic-uuid-2', recordId: 8, status: 'delete', edit: { notifyClient: true } });
});
test('rebook opens the create form with the same client and services and no date', () => {
  const h = cardHarness();
  h.context.jrForm = jest.fn();
  h.context.jrRebook(CARD);
  expect(h.context.jrForm).toHaveBeenCalledWith(null, { staffId: 1, date: '', serviceIds: [70], client: { name: 'Анна', phone: '79200255591' } });
});
test('create form: «не уведомлять» goes into create.notifyClient', () => {
  const h = harness(); createForm(h);
  expect(h.context.jrFormDraft(null)).not.toHaveProperty('notifyClient');
  h.get('jrCreateNoNotify').checked = true;
  expect(h.context.jrFormDraft(null).notifyClient).toBe(false);
});
test('a record deleted locally says it waits for sending', () => {
  const h = harness();
  expect(h.context.jrStatusBar({ deleted: true, sync: { status: 'queued', released: false } })).toContain('Удалена (ждёт отправки)');
  expect(h.context.jrStatusBar({ deleted: true })).toContain('Запись удалена');
});
// ---- Task 12 review fixes ----
test('jrSave: a local cancel (status cancelled) says the record was removed from the journal', async () => {
  const h = cardHarness(); h.context.jrRenderRecord(CARD);
  h.context.loadJournal = jest.fn(); h.context.notify.mockClear();
  h.context.jrApi = jest.fn().mockResolvedValue({ outboxId: 0, recordId: -3, status: 'cancelled' });
  expect(await h.context.jrSave({ sessionId: 's', recordId: -3, status: 'delete' })).toBe(true);
  expect(h.context.notify).toHaveBeenCalledWith(expect.stringContaining('в YClients она ещё не уходила'));
  expect(h.context.loadJournal).toHaveBeenCalled();
  h.context.notify.mockClear();
  h.context.jrApi = jest.fn().mockResolvedValue({ status: 'queued' });
  await h.context.jrSave({ sessionId: 's2', recordId: 8, edit: {} });
  expect(h.context.notify).toHaveBeenCalledWith(expect.stringContaining('Сохранено в журнале'));
});
test('rebook: unsaved edits ask first; a preset form counts as touched; no stats line for a preset client', () => {
  const h = cardHarness(); h.context.jrRenderRecord(CARD);
  h.context.jrForm = jest.fn();
  h.context.jrCardEdit('comment', 'x');
  h.context.jrRebook(CARD);
  expect(h.context.jrForm).not.toHaveBeenCalled();
  expect(h.get('jrCloseAsk').innerHTML).toContain('Есть несохранённые изменения');
  const h2 = cardHarness(); h2.context.jrRenderRecord(CARD); h2.context.jrForm = jest.fn();
  h2.context.jrRebook(CARD);
  expect(h2.context.jrForm).toHaveBeenCalled();
  expect(h2.run('journal.formTouched')).toBe(true);
  const h3 = harness(); createForm(h3);
  h3.context.jrSelectClient({ name: 'Анна', phone: '79200255591' });
  expect(h3.get('jrClientSummary').textContent).toBe('');
  h3.context.jrSelectClient({ name: 'Анна', phone: '79200255591', visits_count: 2, bonus_balance: 5 });
  expect(h3.get('jrClientSummary').textContent).toContain('Визитов: 2');
});
test('change client: invalid phone or name is rejected before the session', () => {
  const h = cardHarness(); h.context.jrRenderRecord(CARD); h.context.jrLoadClients = jest.fn();
  h.get('jrChangeClient').onclick();
  const pick = h.context.jrLoadClients.mock.calls[0][1];
  h.context.notify.mockClear();
  pick({ name: 'Борис', phone: '12345' });
  pick({ name: '  ', phone: '79000000001' });
  pick({ name: 'x'.repeat(121), phone: '79000000001' });
  expect(h.context.notify).toHaveBeenCalledTimes(3);
  expect(h.run('journal.session.edit')).toBeFalsy();
  pick({ name: 'Борис', phone: '89000000001' });
  expect(h.run('journal.session.edit.client.name')).toBe('Борис');
});
test('colour outside the palette, off-grid break and unknown labels are kept visible', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard({ ...CARD, customColor: '#123456', technicalBreak: 420, labels: [{ id: 99, title: '', color: '' }] });
  expect(html).toContain('class="jr-color is-current" data-color="#123456"');
  expect(html).toContain('<option value="7" selected>7 мин</option>');
  expect(html).not.toContain('<option value="0" selected>');
  expect(html).toContain('data-label="99" checked disabled');
  expect(html).toContain('нет в справочнике');
  h.context.jrRenderRecord({ ...CARD, labels: [{ id: 99, title: '', color: '' }] });
  h.context.jrCardEdit('labelIds', [99]);
  expect(h.run('journal.session.edit.labelIds')).toEqual([99]);
});
test('deleting status text and cancelled (-1) record fields', () => {
  const h = cardHarness();
  expect(h.context.jrStatusBar({ deleted: true, sync: { status: 'running' } })).toContain('Удаляется…');
  const html = h.context.jrAppointmentCard({ ...CARD, attendance: -1 });
  expect(html).not.toMatch(/id="jrCommentEdit"[^>]* readonly>/);
  expect(html).toMatch(/id="jrDurationEdit"[^>]*value="60">/);
  expect(html).toContain('id="jrDelete"');
});
test('unsaved card edit with new fields: kind is edit and closing asks', () => {
  const h = cardHarness(); h.context.jrRenderRecord(CARD);
  h.context.jrCardEdit('customColor', '#f4a0a0');
  expect(h.context.jrUnsavedKind()).toBe('edit');
  h.context.jrClose();
  expect(h.get('jrCloseAsk').hidden).toBe(false);
  expect(h.get('jrCloseAsk').innerHTML).toContain('Есть несохранённые изменения');
});

// ---- History and client panel (12.11.2026) ----
const SUMMARY = { name: 'Анна', phone: '79200255591', visits: { success: 7, fail: 2 }, bonusBalance: 650, loyaltyLevel: 'Золото', totalSpent: 42000,
  lastVisits: [{ date: '2026-11-01', staffName: '<b>Юлия</b>', services: ['Чистка'], attendance: 1 }], abonements: null, bonusesSource: 'card' };
test('card has a live history button and the client panel box', () => {
  const h = cardHarness();
  const html = h.context.jrAppointmentCard(CARD);
  expect(html).toContain('class="jr-tool-live jr-placeholder" id="jrHistoryOpen"');
  expect(html).toContain('<div id="jrHistory" class="jr-history-box" hidden></div>');
  expect(html).toContain('<div id="jrClientSummaryBox">');
  expect(h.context.jrClientPanel(CARD)).not.toContain('jrClientSummaryBox');
});
test('history: lazy load, escaped changes, package errors, empty state', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn().mockResolvedValue({ recordId: 8, events: [
    { at: '2026-11-12T07:10:00Z', source: 'yclients', author: 'YClients', title: 'Изменена в YClients', changes: [{ field: 'comment', label: 'Комментарий', from: null, to: '<script>x</script>' }] },
    { at: '2026-11-12T07:07:00Z', source: 'journal', author: 'LoyalPro: Мария', title: 'перенос — ошибка', changes: [], error: 'Время занято', errorCode: 'slot_taken' },
  ] });
  await h.context.jrLoadHistory(8);
  expect(h.context.jrApi).toHaveBeenCalledWith('records/8/history');
  const html = h.get('jrHistory').innerHTML;
  expect(h.get('jrHistory').hidden).toBe(false);
  expect(html).toContain('Комментарий: — → &lt;script&gt;x&lt;/script&gt;');
  expect(html).toContain('LoyalPro: Мария');
  expect(html).toContain('Время занято (slot_taken)');
  expect(html).toContain('12.11, 10:10');
  expect(h.context.jrHistoryHtml([])).toContain('Изменений не зафиксировано');
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('Нет связи'));
  await h.context.jrLoadHistory(8);
  expect(h.get('jrHistory').innerHTML).toContain('Нет связи');
});
test('client panel: visits, no-shows, bonuses, abonements, last visits escaped', () => {
  const h = harness();
  const html = h.context.jrClientSummaryHtml(SUMMARY);
  for (const s of ['Визитов<span>7</span>', 'Неявок<span>2</span>', 'Бонусы<span>650</span>', 'Уровень<span>Золото</span>', 'не удалось прочитать', 'по карте YClients']) expect(html).toContain(s);
  expect(html).toContain('&lt;b&gt;Юлия&lt;/b&gt;');
  expect(h.context.jrClientSummaryHtml({ ...SUMMARY, abonements: [] })).toContain('Абонементов нет');
  const ab = h.context.jrClientSummaryHtml({ ...SUMMARY, abonements: [{ title: 'Чистка <x>', balance: 3, expires: '2027-01-01T00:00:00', frozen: true }] });
  expect(ab).toContain('Чистка &lt;x&gt; · осталось 3 · до 2027-01-01 · заморожен');
});
test('client panel loads once per opened card; failure stays inside the panel', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn().mockResolvedValue(SUMMARY);
  await h.context.jrLoadClientSummary(CARD);
  await h.context.jrLoadClientSummary(CARD);
  expect(h.context.jrApi).toHaveBeenCalledTimes(1);
  expect(h.context.jrApi).toHaveBeenCalledWith('clients/summary?phone=79200255591');
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Визитов<span>7</span>');
  h.run('journal.modalRequest++');
  h.context.jrApi = jest.fn().mockRejectedValue(new Error('YClients недоступен'));
  await h.context.jrLoadClientSummary(CARD);
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Не удалось загрузить данные клиента: YClients недоступен');
});
test('client panel: stale answer after the card changed is not drawn', async () => {
  const h = cardHarness();
  let resolve;
  h.context.jrApi = jest.fn(() => new Promise(r => { resolve = r; }));
  const p = h.context.jrLoadClientSummary(CARD);
  h.run('journal.modalRequest++');
  resolve(SUMMARY);
  await p;
  expect(h.get('jrClientSummaryBox').innerHTML).not.toContain('Визитов');
});
test('no phone: the panel says so and does not call the server', async () => {
  const h = cardHarness();
  h.context.jrApi = jest.fn();
  await h.context.jrLoadClientSummary({ ...CARD, clientPhone: '' });
  expect(h.context.jrApi).not.toHaveBeenCalled();
  expect(h.get('jrClientSummaryBox').innerHTML).toContain('Телефон клиента неизвестен');
});
