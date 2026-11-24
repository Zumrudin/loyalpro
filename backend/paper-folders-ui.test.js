'use strict';
const fs = require('fs');
const vm = require('vm');
const workday = require('../frontend/js/pages/workday.js');
function ui(file, extras = {}) {
  const elements = new Map();
  const document = { getElementById: id => elements.get(id) || null, addEventListener() {} };
  const context = vm.createContext({ document, console, Date, Number, URLSearchParams,
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    api: jest.fn(), notify: jest.fn(), confirm: jest.fn(() => true), ...extras });
  vm.runInContext(fs.readFileSync(`${__dirname}/../frontend/js/pages/${file}.js`, 'utf8'), context);
  return { context, elements };
}

test('tomorrow follows the Moscow calendar across UTC midnight and year boundary', () => {
  expect(workday.wdTomorrowMsk(new Date('2026-12-31T21:30:00Z'))).toBe('2027-01-02');
  expect(workday.wdTomorrowMsk(new Date('2026-11-24T20:30:00Z'))).toBe('2026-11-25');
});
test('folder picking is numeric, unique per client, and unassigned clients remain visible', () => {
  const items = workday.wdFolderItems([
    { clientId: 1, number: 100 }, { clientId: '1', number: 100 },
    { clientId: 2, number: 9 }, { clientId: 3, number: null, needsNumber: true },
  ]);
  expect(items.map(i => Number(i.clientId))).toEqual([2, 1, 3]);
});
test('folder rows escape names and tasks and show archive/new package information', () => {
  const { context } = ui('workday');
  const html = context.wdFolderListHtml([{ clientId: 4, name: '<img src=x>', task: '<script>', archived: true }]);
  expect(html).toContain('&lt;img src=x>');
  expect(html).toContain('&lt;script>');
  expect(html).toContain('Архив');
  expect(html).toContain('disabled');
  expect(html).toContain('Пакет создан');
  expect(html).not.toContain('<img');
});
test('archive cancellation sends no request and failed archive restores checkbox', async () => {
  const { context } = ui('clients');
  const checkbox = { checked: true, disabled: false };
  context.confirm.mockReturnValue(false);
  await context.cdSetPaperArchive(7, checkbox);
  expect(checkbox.checked).toBe(false);
  expect(context.api).not.toHaveBeenCalled();
  context.confirm.mockReturnValue(true);
  context.api.mockRejectedValue(new Error('Недоступно'));
  checkbox.checked = true;
  await context.cdSetPaperArchive(7, checkbox);
  expect(context.api).toHaveBeenCalledWith('PATCH', '/api/clients/7/paper-folder', { archived: true });
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(false);
  expect(context.notify).toHaveBeenCalledWith('Недоступно', 'err');
});
test('folder day request ignores an outdated response after date selection changes', async () => {
  let resolveFirst;
  const api = jest.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ occupied: 10, free: 1990, items: [{ clientId: 7, name: 'Новая дата', number: 2 }] });
  const { context, elements } = ui('workday', { api });
  elements.set('wdFolderDate', { value: '2026-11-25' });
  elements.set('wdFolderCounts', { innerHTML: '' });
  elements.set('wdFolderList', { innerHTML: '' });
  const first = context.wdLoadFolders();
  elements.get('wdFolderDate').value = '2026-11-26';
  await context.wdLoadFolders();
  resolveFirst({ items: [{ clientId: 8, name: 'Старая дата', number: 1 }] });
  await first;
  expect(elements.get('wdFolderList').innerHTML).toContain('Новая дата');
  expect(elements.get('wdFolderList').innerHTML).not.toContain('Старая дата');
  expect(elements.get('wdFolderCounts').innerHTML).toContain('Свободно: 1990');
});
test('preparation update only changes physical package status', async () => {
  const { context } = ui('workday', { api: jest.fn(async () => ({})) });
  const checkbox = { checked: true, disabled: false, dataset: { folderPrepared: '7' } };
  await context.wdSetFolderPrepared(checkbox);
  expect(context.api).toHaveBeenCalledWith('PATCH', '/api/clients/7/paper-folder', { prepared: true });
  expect(checkbox.disabled).toBe(false);
});

test('archived patient can have a prepared newly assigned folder until completed paid attendance', () => {
  const { context } = ui('workday');
  const html = context.wdFolderListHtml([{ clientId: 4, name: 'Пациент', number: 24, archived: true, prepared: true }]);
  expect(html).toContain('Архив');
  expect(html).toContain('checked');
  expect(html).not.toContain('disabled');
  const client = ui('clients').context;
  const card = client.cdPaperFolderHtml(4, { number: 24, archived: true });
  expect(card).toContain('checked disabled');
  expect(card).toContain('полностью оплаченного визита');
  expect(card).toContain('Убрать подготовленный пакет');
});
test('manual registration validates the fixed pool and preserves conflict feedback', async () => {
  const { context, elements } = ui('clients');
  const input = { value: '2001' };
  elements.set('cdPaperNumber', input);
  const button = { disabled: false };
  await context.cdRegisterPaperNumber(7, button);
  expect(context.api).not.toHaveBeenCalled();
  input.value = '2.5';
  await context.cdRegisterPaperNumber(7, button);
  expect(context.api).not.toHaveBeenCalled();
  input.value = '24';
  context.api.mockRejectedValue(new Error('Номер занят'));
  await context.cdRegisterPaperNumber(7, button);
  expect(context.api).toHaveBeenCalledWith('PATCH', '/api/clients/7/paper-folder', { number: 24 });
  expect(context.notify).toHaveBeenLastCalledWith('Номер занят', 'err');
  expect(button.disabled).toBe(false);
});
test('returning an archived prepared package requires physical removal confirmation', async () => {
  const { context } = ui('clients');
  const button = { disabled: false };
  context.confirm.mockReturnValue(false);
  await context.cdReturnPaperFolder(7, button);
  expect(context.api).not.toHaveBeenCalled();
  context.confirm.mockReturnValue(true);
  await context.cdReturnPaperFolder(7, button);
  expect(context.api).toHaveBeenCalledWith('PATCH', '/api/clients/7/paper-folder', { archived: true });
  expect(button.disabled).toBe(false);
});

test('provisional bookings remain visible and deduplicate using stable patient key', () => {
  const items = workday.wdFolderItems([
    { key: 'pending:synthetic', clientId: null, outboxId: 12, number: 3 },
    { key: 'pending:synthetic', clientId: null, outboxId: 13, number: 3 },
    { clientId: null, outboxId: 14, number: 2 },
    { clientId: 7, number: 1 },
  ]);
  expect(items).toHaveLength(3);
  expect(items.map(item => item.number)).toEqual([1, 2, 3]);
  const { context } = ui('workday');
  expect(context.wdFolderListHtml(items)).toContain('data-folder-outbox="12"');
  expect(context.wdFolderListHtml([{ clientId: 8, number: null }])).toContain('Номер не назначен');
});
test('physical preparation for a provisional booking uses the outbox endpoint', async () => {
  const { context } = ui('workday', { api: jest.fn(async () => ({})) });
  const checkbox = { checked: true, disabled: false, dataset: { folderOutbox: '12' } };
  await context.wdSetFolderPrepared(checkbox);
  expect(context.api).toHaveBeenCalledWith('PATCH', '/api/paper-folders/outbox/12', { prepared: true });
});
test('day summary includes server refresh time explicitly in Moscow timezone', async () => {
  const { context, elements } = ui('workday', { api: jest.fn(async () => ({ items: [], updatedAt: '2030-01-02T09:30:00Z' })) });
  elements.set('wdFolderDate', { value: '2030-01-02' });
  elements.set('wdFolderCounts', { innerHTML: '' });
  elements.set('wdFolderList', { innerHTML: '' });
  await context.wdLoadFolders();
  expect(elements.get('wdFolderCounts').innerHTML).toContain('Обновлено:');
  expect(elements.get('wdFolderCounts').innerHTML).toContain('12:30 МСК');
});
