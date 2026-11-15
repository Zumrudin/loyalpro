'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const readPage = file => fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8');
const SOURCES = ['journal.js', 'journal-grid.js'].map(file => ({ file, code: readPage(file) }));

function harness({ storedStep = null, visible = r => r.attendance !== -1 } = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false,
      scrollTop: 0, scrollLeft: 0, classList: { toggle: jest.fn() },
      addEventListener: jest.fn(), setAttribute: jest.fn(), querySelectorAll: () => [], insertAdjacentHTML: jest.fn(),
      querySelector(selector) {
        if (selector !== '.jr-calendar') return null;
        const match = /class="[^"]*jr-calendar[^"]*" data-start="(\d+)"/.exec(this.innerHTML);
        return match ? { dataset: { start: match[1] } } : null;
      },
    });
    return nodes.get(id);
  };
  const storage = { getItem: jest.fn(() => storedStep), setItem: jest.fn() };
  const context = vm.createContext({
    document: { getElementById: get, body: { dataset: {} } }, Date, URLSearchParams, AbortController,
    setTimeout, clearTimeout, encodeURIComponent, crypto: { randomUUID: () => 'synthetic-uuid' },
    TOKEN: 'synthetic-token', ME: { role: 'owner' }, localStorage: storage,
    fetch: jest.fn(), notify: jest.fn(), confirm: jest.fn(), jrRecordVisible: visible,
    jrToolbarSync: jest.fn(), jrBindStaffMenus: jest.fn(), jrStaffMenuButton: (_s, _d, label) => String(label || ''),
    jrCanEdit: () => false, jrOpen: jest.fn(), jrForm: jest.fn(), jrUpdateDispatchButton: jest.fn(),
  });
  for (const source of SOURCES) vm.runInContext(source.code, context, { filename: source.file });
  return { context, get, storage, run: expression => vm.runInContext(expression, context) };
}

const record = (id, time, attendance, name, duration = 30) => ({
  id, staffId: 1, time, attendance, duration, clientName: name, services: [],
});

test.each([5, 10, 15])('%i-minute scale uses 24px cells and exact non-overlap busy boundaries', step => {
  const h = harness({ storedStep: String(step) });
  const staff = { id: 1, workRanges: [{ start: 480, end: 720 }] };
  const busy = record(1, '09:10', 0, 'Busy', 10);
  h.context.scaleStaff = staff;
  h.context.scaleBusy = busy;
  expect(h.run('jrGridStep() * jrPxPerMin()')).toBe(24);
  expect(h.run(`jrCellState(scaleStaff, ${550 - step}, '2030-04-01', [scaleBusy], 0, ${step})`)).toBe('free');
  expect(h.run(`jrCellState(scaleStaff, 550, '2030-04-01', [scaleBusy], 0, ${step})`)).toBe('busy');
  expect(h.run(`jrCellState(scaleStaff, 560, '2030-04-01', [scaleBusy], 0, ${step})`)).toBe('free');
});

test('day scale renders 24px cells, keeps real duration, and hidden records still set bounds and busy cells', () => {
  const h = harness({ storedStep: '5' });
  h.get('jrWorkingOnly').checked = true;
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,name:'Test',working:true,workRanges:[{start:480,end:1260}]}],records:[
    {id:1,staffId:1,time:'09:00',attendance:0,duration:60,clientName:'Visible',services:[]},
    {id:2,staffId:1,time:'06:30',attendance:-1,duration:30,clientName:'Hidden early',services:[]},
    {id:3,staffId:1,time:'10:00',attendance:-1,duration:30,clientName:'Hidden busy',services:[]}
  ]}; jrRender()`);

  const html = h.get('jrGrid').innerHTML;
  expect(h.run('jrGridStep()')).toBe(5);
  expect(h.run('jrPxPerMin()')).toBe(4.8);
  expect(html).toContain('data-start="360"');
  expect(html).toContain('data-time="08:05"');
  expect(html).toContain('height:24px');
  expect(html).toContain('data-record="1"');
  expect(html).toContain('height:286px');
  expect(html).not.toContain('Hidden early');
  expect(html).not.toContain('Hidden busy');
  expect(html).not.toContain('data-time="10:00"');
  expect(h.run('journal.data.records[0].duration')).toBe(60);
});

test('week status filtering hides cards while preserving late bounds and occupied cells', () => {
  const h = harness({ storedStep: '10' });
  h.run(`journal.data = {date:'2030-04-01',staff:[],records:[]}; journal.view='week'; journal.week={staff:{id:1,name:'Test'},days:[
    {date:'2030-04-01',working:true,workRanges:[{start:480,end:1260}],records:[
      {id:1,staffId:1,time:'09:00',attendance:0,duration:30,clientName:'Visible',services:[]},
      {id:2,staffId:1,time:'22:10',attendance:-1,duration:30,clientName:'Hidden late',services:[]}
    ]}
  ]}; jrRender()`);

  const html = h.get('jrGrid').innerHTML;
  expect(html).toContain('data-record="1"');
  expect(html).not.toContain('Hidden late');
  expect(html).not.toContain('data-time="22:10"');
  expect(html).toContain('--jr-height:2160px'); // 08:00–23:00 at 2.4 px/min
});

test('scale change persists safely, preserves the visible time, cancels drag, and keeps five-minute snapping', () => {
  const h = harness();
  h.get('jrWorkingOnly').checked = true;
  h.run(`journal.data = {date:'2030-04-01',staff:[{id:1,name:'Test',working:true,workRanges:[{start:480,end:1260}]}],records:[
    {id:1,staffId:1,time:'09:00',attendance:0,duration:60,clientName:'Visible',services:[]}
  ]}; jrRender()`);
  const grid = h.get('jrGrid');
  grid.scrollTop = 240; // 10:30 at the default 1.6 px/min scale.
  const dragOff = jest.fn();
  const dragEl = { style: { pointerEvents: 'none', transform: 'x', height: '99px' }, classList: { remove: jest.fn() } };
  h.context.dragOff = dragOff;
  h.context.dragEl = dragEl;
  h.run(`journal.dragOff=dragOff; journal.drag={record:journal.data.records[0],mode:'move',x:0,y:0,el:dragEl,height0:'94px'}`);

  expect(h.context.jrSetGridStep(5)).toBe(true);
  expect(h.storage.setItem).toHaveBeenCalledWith('loyalpro.journal.gridStep', '5');
  expect(grid.scrollTop).toBe(720);
  expect(dragOff).toHaveBeenCalledTimes(1);
  expect(h.run('journal.drag')).toBeNull();
  expect(dragEl.style.height).toBe('94px');
  expect(h.get('jrGrid').innerHTML).toContain('height:286px');

  h.run(`journal.drag={record:journal.data.records[0],mode:'move',x:0,y:100}; document.elementFromPoint=()=>({closest:()=>({dataset:{staff:'1',date:'2030-04-01'}})})`);
  expect(h.context.jrDragTarget({ clientX: 0, clientY: 124 }).minute).toBe(545); // one 5-minute/24px cell
  h.run('journal.gridStep=10');
  expect(h.context.jrDragTarget({ clientX: 0, clientY: 124 }).minute).toBe(550);
  h.run('journal.gridStep=15');
  expect(h.context.jrDragTarget({ clientX: 0, clientY: 124 }).minute).toBe(555);
  expect(h.run('jrSnap(547)')).toBe(545);
  expect(h.run('journal.data.records[0].duration')).toBe(60);
  expect(h.context.jrSetGridStep(7)).toBe(false);
});

test('load synchronizes the toolbar before and after a successful response', async () => {
  const h = harness();
  h.get('jrDate').value = '2030-04-01';
  h.context.jrApi = jest.fn().mockResolvedValue({ date: '2030-04-01', fetchedAt: '2030-04-01T06:00:00Z', staff: [], records: [] });
  await h.context.loadJournal();
  expect(h.context.jrToolbarSync).toHaveBeenCalledTimes(2);
});
