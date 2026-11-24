'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/pages/journal-staff-menu.js'), 'utf8');

function button(dataset = {}) {
  const classes = new Set();
  return {
    dataset, disabled: false, onclick: null,
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
    setAttribute: jest.fn(),
  };
}

function harness() {
  const nodes = new Map();
  const breakRows = [];
  const presets = [
    button({ schedulePreset: '', start: '10:00', end: '22:00' }),
    button({ schedulePreset: '', start: '11:00', end: '20:00' }),
  ];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, hidden: false,
      querySelectorAll: () => [], classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  get('jrScheduleForm').querySelectorAll = selector => selector === '[data-schedule-preset]' ? presets : [];
  get('jrScheduleBreakList').querySelectorAll = selector => selector === '.jr-schedule-break-row' ? breakRows : [];
  get('jrScheduleBreakAdd').onclick = null;
  get('jrDate').value = '2030-04-01';
  const journal = { data: null, busy: false, modalRequest: 0, slotRequest: 0 };
  let uuid = 0;
  const context = vm.createContext({ jrCanManageSchedule: () => true, UIEvents: require('../frontend/js/core/ui-events.js'),
    journal, crypto: { randomUUID: () => `session-${++uuid}` },
    document: { addEventListener: jest.fn(), activeElement: null },
    jrEl: get,
    jrEscape: value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])),
    jrShowModal: jest.fn(), jrClose: jest.fn(), jrMessage: message => { get('jrModalError').textContent = message; },
    jrApi: jest.fn(), notify: jest.fn(), loadJournal: jest.fn(), confirm: jest.fn(() => true),
    jrWithBusy: async (_message, fn) => {
      if (journal.busy) return;
      journal.busy = true;
      try { return await fn(); } finally { journal.busy = false; }
    },
  });
  vm.runInContext(source, context, { filename: 'journal-staff-menu.js' });
  const setBreaks = values => {
    breakRows.splice(0, breakRows.length, ...values.map(item => ({
      querySelector: selector => selector === '[data-schedule-break-start]' ? { value: item.start } : { value: item.end },
    })));
  };
  return { context, journal, get, presets, setBreaks };
}

test('add form requires the loaded selected date and freezes non-working staff options', () => {
  const h = harness();
  expect(h.context.jrScheduleAddOpen()).toBe(false);
  expect(h.context.notify).toHaveBeenCalledWith('Дождитесь загрузки журнала для выбранной даты.', 'err');

  h.journal.data = { date: '2030-04-02', staff: [] };
  expect(h.context.jrScheduleAddOpen()).toBe(false);

  const staff = [{ id: 1, name: 'Working', working: true }, { id: 2, name: 'Off A', working: false }, { id: 3, name: 'Off B', working: false }];
  h.journal.data = { date: '2030-04-01', staff };
  expect(h.context.jrScheduleAddOpen()).toBe(true);
  expect(h.get('jrModalBody').innerHTML).not.toContain('Working');
  expect(h.get('jrModalBody').innerHTML).toContain('Off A');
  expect(h.get('jrModalBody').innerHTML).toContain('Off B');
  expect(h.context.jrScheduleAddOpen).toBeDefined();
  expect(h.context.journal.scheduleForm.context.date).toBe('2030-04-01');
  expect(Array.from(h.context.journal.scheduleForm.staffOptions, s => [s.id, s.name])).toEqual([[2, 'Off A'], [3, 'Off B']]);

  staff[1].name = 'Changed after open';
  h.get('jrDate').value = '2030-04-03';
  expect(h.context.journal.scheduleForm.context.date).toBe('2030-04-01');
  expect(h.context.journal.scheduleForm.staffOptions[0].name).toBe('Off A');
});

test('selected employee, frozen date and all breaks are submitted in one request', async () => {
  const h = harness();
  h.journal.data = { date: '2030-04-01', staff: [{ id: 2, name: 'Off A', working: false }, { id: 3, name: 'Off B', working: false }] };
  h.context.jrScheduleAddOpen();
  h.get('jrScheduleStaff').value = '3';
  h.get('jrScheduleStart').value = '11:00';
  h.get('jrScheduleEnd').value = '20:30';
  h.setBreaks([{ start: '13:00', end: '13:30' }, { start: '17:00', end: '18:00' }]);
  h.get('jrDate').value = '2030-04-02';
  h.context.jrApi.mockResolvedValue({ outboxId: 7 });

  await h.context.jrStaffScheduleSave();
  expect(h.context.jrApi).toHaveBeenCalledWith('staff-schedule', {
    sessionId: 'session-1', action: 'add', staffId: 3, date: '2030-04-01', start: '11:00', end: '20:30',
    breaks: [{ start: '13:00', end: '13:30' }, { start: '17:00', end: '18:00' }],
  });
});

test('timeout preserves the session key and entered fields for a safe retry', async () => {
  const h = harness();
  h.journal.data = { date: '2030-04-01', staff: [{ id: 2, name: 'Off A', working: false }] };
  h.context.jrScheduleAddOpen();
  h.get('jrScheduleStaff').value = '2';
  h.get('jrScheduleStart').value = '10:00'; h.get('jrScheduleEnd').value = '22:05';
  h.setBreaks([{ start: '14:00', end: '15:00' }]);
  const key = h.context.journal.scheduleForm.sessionId;
  h.context.jrApi.mockRejectedValue(new Error('timeout'));

  await h.context.jrStaffScheduleSave();
  expect(h.context.journal.scheduleForm.sessionId).toBe(key);
  expect(h.get('jrScheduleStart').value).toBe('10:00');
  expect(h.get('jrScheduleEnd').value).toBe('22:05');
  expect(h.context.jrScheduleBreakValues()).toEqual([{ start: '14:00', end: '15:00' }]);
  expect(h.get('jrModalError').textContent).toBe('timeout');
});

test('double submit while the request is pending issues one API call', async () => {
  const h = harness(); let resolve;
  h.journal.data = { date: '2030-04-01', staff: [{ id: 2, name: 'Off A', working: false }] };
  h.context.jrScheduleAddOpen();
  h.get('jrScheduleStaff').value = '2'; h.get('jrScheduleStart').value = '10:00'; h.get('jrScheduleEnd').value = '22:00';
  h.context.jrApi.mockImplementation(() => new Promise(r => { resolve = r; }));

  const first = h.context.jrStaffScheduleSave();
  await h.context.jrStaffScheduleSave();
  expect(h.context.jrApi).toHaveBeenCalledTimes(1);
  resolve({ outboxId: 7 });
  await first;
});
