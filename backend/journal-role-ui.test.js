'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UIEvents = require('../frontend/js/core/ui-events');
const files = ['journal.js', 'journal-toolbar.js', 'journal-grid.js', 'journal-staff-menu.js', 'journal-card.js', 'journal-forms.js', 'journal-dispatch.js'];
function harness(role) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      open: true, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {},
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => null });
    return nodes.get(id);
  };
  const context = vm.createContext({ document: { getElementById: get, addEventListener() {}, readyState: 'loading' },
    UIEvents, Date, URLSearchParams, AbortController, setTimeout, clearTimeout, crypto: { randomUUID: () => 'synthetic' },
    TOKEN: 'synthetic', ...(role === undefined ? {} : { ME: { role } }),
    fetch: jest.fn(async () => ({ ok: true, json: async () => ({}) })), notify: jest.fn() });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/pages', file), 'utf8'), context);
  return { context, get, run: code => vm.runInContext(code, context) };
}
const record = { id: 1, staffId: 1, clientName: 'Синтетический пациент', clientPhone: '70000000000',
  date: '2030-04-02', time: '11:00', duration: 60, attendance: 0, services: [{ title: 'Услуга', cost: 100 }], comment: 'Синтетический комментарий' };

test.each(['owner', 'admin', 'admin_cashier', 'specialist', 'unknown', undefined])('journal capabilities fail closed for role %s', role => {
  const { context } = harness(role);
  const editor = ['owner', 'admin', 'admin_cashier'].includes(role);
  expect(context.jrCanEditJournal()).toBe(editor);
  expect(context.jrCanViewPhones()).toBe(editor);
  expect(context.jrCanUseClientTools()).toBe(editor);
  expect(context.jrCanOpenClientCard()).toBe(['owner', 'admin'].includes(role));
  expect(context.jrCanManageSchedule()).toBe(['owner', 'admin'].includes(role));
});
test('server capabilities can restrict an otherwise authorized editor', () => {
  const h = harness('admin');
  h.run('journal.data = {capabilities:{canEdit:false,canViewPhones:false,canUseClientTools:false}}');
  expect(h.context.jrCanEditJournal()).toBe(false);
  expect(h.context.jrPhoneHtml(record)).toBe('');
});
test('specialist card only renders detail and history without client tools, phone or mutations', () => {
  const h = harness('specialist');
  const html = h.context.jrAppointmentCard(record);
  expect(html).toContain('Только просмотр');
  expect(html).toContain('История изменений');
  expect(html).toContain('Синтетический комментарий');
  expect(html).not.toContain('70000000000');
  for (const forbidden of ['tel:', 'data-phone', 'jrPaymentOpen', 'jrTabChat', 'jrMove', 'jrRebook', 'jrSaveChanges', 'jrChangeClient']) expect(html).not.toContain(forbidden);
  h.context.jrRenderRecord(record);
  expect(h.get('jrHistoryOpen').onclick).toEqual(expect.any(Function));
  expect(h.context.jrDragAllowed(record)).toBe(false);
  expect(h.context.jrResizeAllowed(record)).toBe(false);
});
test('specialist mutation entry points stay inert even when invoked directly', async () => {
  const h = harness('specialist');
  for (const invoke of [() => h.context.jrForm(), () => h.context.jrGridCreate(), () => h.context.jrDeleteRecord(record),
    () => h.context.jrRebook(record), () => h.context.jrScheduleAddOpen(), () => h.context.jrScheduleChangesOpen(),
    () => h.context.jrStaffScheduleSave(), () => h.context.jrDispatchOpen(), () => h.context.jrSave({}),
    () => h.context.jrPayFromCard(1), () => h.context.jrOpenClientCard(record), () => h.context.jrLoadClients('synthetic')]) await invoke();
  expect(h.context.fetch).not.toHaveBeenCalled();
  h.context.jrApplyPermissions();
  for (const id of ['jrNew', 'jrSummaryPlus', 'jrScheduleAdd', 'jrScheduleChanges', 'jrDispatch']) {
    expect(h.get(id).hidden).toBe(true);
    expect(h.get(id).disabled).toBe(true);
  }
});
test('specialist API reads are limited to schedule, detail and history; writes and client lookup never leave browser', async () => {
  const h = harness('specialist');
  for (const url of ['day?date=2030-04-02', 'day-summary?date=2030-04-02', 'week', 'month', 'records/1', 'records/-2/history']) await h.context.jrApi(url);
  expect(h.context.fetch).toHaveBeenCalledTimes(6);
  for (const [url, body] of [['sessions', {}], ['records/1', {}], ['clients/summary?phone=70000000000'], ['dispatch/summary'], ['staff-schedule/changes']]) {
    await expect(h.context.jrApi(url, body)).rejects.toMatchObject({ status: 403 });
  }
  expect(h.context.fetch).toHaveBeenCalledTimes(6);
});
test('cashier keeps phone but cannot open global client card, stock or staff schedule', async () => {
  const h = harness('admin_cashier');
  expect(h.context.jrPhoneHtml(record)).toContain('70000000000');
  expect(h.context.jrClientPanel(record, false, true)).not.toContain('id="jrClientLink"');
  expect(h.context.jrStaffMenuButton({ id: 1, name: 'Сотрудник' }, record.date, 'Сотрудник')).not.toContain('data-staff-action');
  await h.context.jrOpenClientCard(record);
  await h.context.jrLoadClients('synthetic');
  expect(h.context.fetch).not.toHaveBeenCalled();
  expect(h.context.jrCanUseStock()).toBe(false);
});
