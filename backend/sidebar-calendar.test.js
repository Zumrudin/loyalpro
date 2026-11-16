'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/js/core/sidebar-calendar.js'), 'utf8');

function harness({ allowed = true, page = 'journal', date = '2026-11-16' } = {}) {
  const input = { value: date };
  const panel = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({
    Date,
    document: {
      body: { dataset: { page } },
      getElementById: id => id === 'jrDate' ? input : null,
      querySelectorAll: selector => selector === '.side-calendar-panel' ? [panel] : [],
      addEventListener: jest.fn(),
    },
    window: { addEventListener: jest.fn() },
    _navAllowed: jest.fn(() => allowed),
    jrToday: () => '2026-11-16',
    loadJournal: jest.fn(),
    navTo: jest.fn(),
    fetch: jest.fn(),
  });
  vm.runInContext(source, context, { filename: 'sidebar-calendar.js' });
  return { context, input, panel, run: expression => vm.runInContext(expression, context) };
}

test.each([
  ['2024-02', '2024-01-29', '2024-03-10', true],
  ['2025-02', '2025-01-27', '2025-03-09', false],
  ['2026-11', '2026-10-26', '2026-12-06', false],
  ['2026-12', '2026-11-30', '2027-01-10', false],
])('month %s has six complete Monday-first weeks across boundaries', (month, first, last, leapDay) => {
  const { context } = harness();
  const cells = context.sideCalendarCells(month);
  expect(cells).toHaveLength(42);
  expect(cells[0].date).toBe(first);
  expect(cells[41].date).toBe(last);
  expect(cells.some(cell => cell.date === '2024-02-29')).toBe(leapDay);
  for (let i = 0; i < cells.length; i++) {
    const date = new Date(cells[i].date + 'T12:00:00Z');
    expect(date.getUTCDay()).toBe((i + 1) % 7);
    expect(cells[i].day).toBe(date.getUTCDate());
    if (i) expect(+date - +new Date(cells[i - 1].date + 'T12:00:00Z')).toBe(86400000);
  }
});

test.each(['', '2026-00', '2026-13', '2026-1', 'invalid'])('rejects invalid month %s', month => {
  expect(harness().context.sideCalendarCells(month)).toEqual([]);
});

test('browsing across December and January leaves selection unchanged and makes no request', () => {
  const h = harness({ date: '2026-12-31' });
  h.context.sideCalendarSync();
  h.context.sideCalendarShift(1);
  expect(h.run('sideCalendarMonth')).toBe('2027-01');
  expect(h.input.value).toBe('2026-12-31');
  expect(h.run('sideCalendarSelected')).toBe('2026-12-31');
  h.context.sideCalendarShift(-1);
  expect(h.run('sideCalendarMonth')).toBe('2026-12');
  expect(h.context.loadJournal).not.toHaveBeenCalled();
  expect(h.context.navTo).not.toHaveBeenCalled();
  expect(h.context.fetch).not.toHaveBeenCalled();
});

test('silent same-date sync preserves browsed month; changed journal date brings its month into view', () => {
  const h = harness();
  h.context.sideCalendarSync();
  h.context.sideCalendarShift(1);
  h.context.sideCalendarSync();
  expect(h.run('sideCalendarMonth')).toBe('2026-12');
  h.input.value = '2027-01-04';
  h.context.sideCalendarSync();
  expect(h.run('sideCalendarMonth')).toBe('2027-01');
  expect(h.run('sideCalendarSelected')).toBe('2027-01-04');
});

test('initial empty journal date uses the Moscow today helper and exposes today and selection', () => {
  const h = harness({ date: '' });
  h.context.sideCalendarSync();
  expect(h.run('sideCalendarSelected')).toBe('2026-11-16');
  expect(h.panel.innerHTML).toContain('data-date="2026-11-16" class="selected today"');
  expect(h.panel.innerHTML).toContain('aria-pressed="true" aria-current="date"');
});

test('Today recenters the calendar even when today was already selected before browsing', () => {
  const h = harness();
  h.context.sideCalendarSync();
  h.context.sideCalendarShift(1);
  expect(h.run('sideCalendarMonth')).toBe('2026-12');
  h.context.sideCalendarSync(true);
  expect(h.input.value).toBe('2026-11-16');
  expect(h.run('sideCalendarMonth')).toBe('2026-11');
  expect(h.panel.innerHTML).toContain('data-date="2026-11-16" class="selected today"');
  expect(h.context.loadJournal).not.toHaveBeenCalled();
});

test('unauthorized date selection cannot change the journal date or trigger navigation/loading', () => {
  const h = harness({ allowed: false });
  h.context.sideCalendarSelect('2026-12-01');
  expect(h.context._navAllowed).toHaveBeenCalledWith('journal');
  expect(h.input.value).toBe('2026-11-16');
  expect(h.context.loadJournal).not.toHaveBeenCalled();
  expect(h.context.navTo).not.toHaveBeenCalled();
});

test.each(['journal', 'dashboard'])('authorized selection from %s uses exactly one loading entry point', page => {
  const h = harness({ page });
  h.context.sideCalendarSync();
  h.context.sideCalendarSelect('2026-12-01');
  expect(h.input.value).toBe('2026-12-01');
  expect(h.run('sideCalendarSelected')).toBe('2026-12-01');
  if (page === 'journal') {
    expect(h.context.loadJournal).toHaveBeenCalledTimes(1);
    expect(h.context.navTo).not.toHaveBeenCalled();
  } else {
    expect(h.context.navTo).toHaveBeenCalledTimes(1);
    expect(h.context.navTo).toHaveBeenCalledWith('journal', { reset: true });
    expect(h.context.loadJournal).not.toHaveBeenCalled();
  }
  expect(h.context.fetch).not.toHaveBeenCalled();
});
