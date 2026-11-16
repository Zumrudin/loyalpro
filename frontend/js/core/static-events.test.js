'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'static-events.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
function idFor(body) {
  const line = source.split('\n').find(line => line.includes('function (event) { ' + body + ' }'));
  assert.ok(line, 'known callback exists: ' + body);
  return line.trim().split(':')[0];
}
function element(type, body, parentNode = null) {
  const id = idFor(body);
  return {
    nodeType: 1, parentNode, listeners: {},
    matches: () => true, querySelectorAll: () => [],
    getAttribute: name => name === 'data-static-on' + type ? id : null,
    addEventListener(type, callback) {
      assert.equal(this.listeners[type], undefined, 'must not attach duplicate callbacks');
      this.listeners[type] = callback;
    }
  };
}
function setup(elements, globals = {}) {
  const capture = {};
  let observer, ready;
  const document = {
    documentElement: {}, querySelectorAll: () => elements,
    addEventListener(type, callback, options) {
      if (options === true) capture[type] = callback;
      else if (type === 'DOMContentLoaded') ready = callback;
    }
  };
  vm.runInNewContext(source, {
    document,
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    ...globals
  });
  return { document, capture, ready, mutate: nodes => observer([{ addedNodes: nodes }]) };
}

test('every static markup handler resolves to a compiled callback; scripts are external', () => {
  const references = [...index.matchAll(/data-static-on\w+="(s\d+)"/g)];
  assert.ok(references.length > 400, 'inventory covers staff UI');
  for (const [, id] of references) assert.ok(source.includes(id + ': function (event)'), id);
  for (const file of ['index.html', 'cert-request.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.doesNotMatch(html, /\son\w+\s*=/i);
    assert.doesNotMatch(html, /<script\s*>/i);
  }
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(/);
});

test('element context, event filtering and return-false cancellation survive extraction', () => {
  const nav = element('click', 'nav(this)');
  const link = element('click', "navTo('records',{reset:true});return false");
  const key = element('keydown', "if(event.key==='Enter')doLogin()");
  let navElement, destination, logins = 0, prevented = false;
  setup([nav, link, key], { nav: value => { navElement = value; }, navTo: value => { destination = value; }, doLogin: () => logins++ });
  nav.listeners.click.call(nav, {});
  assert.equal(navElement, nav);
  link.listeners.click.call(link, { preventDefault() { prevented = true; } });
  assert.equal(destination, 'records');
  assert.equal(prevented, true);
  key.listeners.keydown.call(key, { key: 'Escape' });
  assert.equal(logins, 0);
  key.listeners.keydown.call(key, { key: 'Enter' });
  assert.equal(logins, 1);
});

test('observer binds clones only once and ignores text nodes', () => {
  const button = element('click', 'doLogin()');
  let calls = 0;
  const runtime = setup([button], { doLogin: () => calls++ });
  runtime.ready();
  const clone = element('click', 'doLogin()');
  runtime.mutate([clone, { nodeType: 3 }]);
  runtime.mutate([clone]);
  clone.listeners.click.call(clone, {});
  assert.equal(calls, 1);
});

test('capture binds a synchronously inserted control and ancestors without executing callbacks early', () => {
  let calls = 0;
  const runtime = setup([], { doLogin: () => calls++ });
  const parent = element('click', 'doLogin()', runtime.document);
  const child = element('click', 'doLogin()', parent);
  runtime.capture.click({ target: child });
  assert.equal(calls, 0);
  assert.equal(typeof parent.listeners.click, 'function');
  child.listeners.click.call(child, {});
  assert.equal(calls, 1);
  runtime.mutate([child, parent]);
});

test('form callbacks receive the original event and can prevent submission', () => {
  const form = element('submit', 'event.preventDefault();stockLoadGoods()');
  let prevented = false, calls = 0;
  setup([form], { stockLoadGoods: () => calls++ });
  form.listeners.submit.call(form, { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(calls, 1);
});
