'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const nav = fs.readFileSync(path.join(__dirname, '../core/nav.js'), 'utf8');
for (const role of ['owner', 'admin', 'specialist', 'admin_cashier', 'unknown']) {
  test(`module menus and direct-link visibility for ${role}`, () => {
    const items = [...html.matchAll(/class="tn" data-p="(economics|broadcasts)" data-roles="([^"]+)"/g)].map(m => ({ dataset: { p: m[1], roles: m[2] }, style: {}, classList: { add() {}, remove() {} } }));
    assert.equal(items.filter(x => x.dataset.p === 'economics').length, 2);
    assert.equal(items.filter(x => x.dataset.p === 'broadcasts').length, 2);
    const ctx = vm.createContext({ window: { addEventListener() {} }, document: { addEventListener() {},
      querySelectorAll: () => items,
      querySelector: s => items.find(x => s.includes(`data-p="${x.dataset.p}"`)),
    } });
    vm.runInContext(nav, ctx);
    ctx.applyRoleNav(role);
    const allowed = ['owner', 'admin'].includes(role);
    for (const item of items) assert.equal(item.style.display !== 'none', allowed);
    for (const page of ['economics', 'broadcasts']) assert.equal(ctx._navAllowed(page), allowed);
  });
}
