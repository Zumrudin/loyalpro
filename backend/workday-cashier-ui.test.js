'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../frontend');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const nav = fs.readFileSync(path.join(root, 'js/core/nav.js'), 'utf8');
const workday = fs.readFileSync(path.join(root, 'js/pages/workday.js'), 'utf8');

function navigation(role) {
  const items = [...html.matchAll(/class="tn" data-p="([^"]+)" data-roles="([^"]+)"/g)]
    .map(match => ({ dataset: { p: match[1], roles: match[2] }, style: {}, classList: { add() {}, remove() {} } }));
  const context = vm.createContext({ window: { addEventListener() {} }, document: {
    addEventListener() {},
    querySelectorAll(selector) {
      if (/nav-grp|nav-sec-t/.test(selector)) return [];
      const requested = selector.match(/data-p="([^"]+)"/);
      return requested ? items.filter(item => item.dataset.p === requested[1]) : items;
    },
  } });
  vm.runInContext(nav, context);
  return { context, items, start: context.applyRoleNav(role) };
}

test.each(['owner', 'admin', 'admin_cashier'])('%s can open Workday in desktop and mobile navigation', role => {
  const { context, items, start } = navigation(role);
  expect(context._navAllowed('workday')).toBe(true);
  expect(items.filter(item => item.dataset.p === 'workday' && item.style.display !== 'none')).toHaveLength(2);
  if (role !== 'owner') expect(start).toBe('workday');
});
test.each(['specialist', 'unknown'])('%s has no Workday navigation access', role => {
  expect(navigation(role).context._navAllowed('workday')).toBe(false);
});

test.each(['owner', 'admin', 'admin_cashier'])('Workday care card follows %s role without sending requests to care', async role => {
  const care = { style: {} };
  const context = vm.createContext({ ME: { role }, document: {
    getElementById: id => id === 'wdCareCard' ? care : null, addEventListener() {},
  }, api: jest.fn(async () => ({})), Date, URLSearchParams, console });
  vm.runInContext(workday, context);
  await context.loadWorkday();
  expect(care.style.display).toBe(role === 'admin_cashier' ? 'none' : '');
  const event = { target: { closest: () => care }, preventDefault: jest.fn(), stopImmediatePropagation: jest.fn() };
  context.wdGuardCare(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(role === 'admin_cashier' ? 1 : 0);
  expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(role === 'admin_cashier' ? 1 : 0);
  expect(context.api.mock.calls.every(([, url]) => !url.startsWith('/api/care'))).toBe(true);
});

test('cashier password change opens Workday and does not request the dashboard', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'cpCur' ? 'synthetic-current' : 'synthetic-new', style: {}, classList: { add: jest.fn(), remove: jest.fn() } });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: get, querySelectorAll: () => [] },
    api: jest.fn(async () => ({})), applyRoleNav: jest.fn(() => 'workday'),
    loadWorkday: jest.fn(), loadDashboard: jest.fn(), loadLs: jest.fn() });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/core/auth.js'), 'utf8'), context);
  vm.runInContext('ME = { role: "admin_cashier" };', context);
  await context.doChangePw();
  expect(context.applyRoleNav).toHaveBeenCalledWith('admin_cashier');
  expect(context.loadWorkday).toHaveBeenCalledTimes(1);
  expect(context.loadDashboard).not.toHaveBeenCalled();
  expect(context.loadLs).not.toHaveBeenCalled();
  expect(get('page-workday').classList.add).toHaveBeenCalledWith('active');
});
