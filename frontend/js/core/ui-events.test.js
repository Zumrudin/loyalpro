const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UIEvents = require('./ui-events.js');
const registrySource = fs.readFileSync(path.join(__dirname, 'dynamic-events.js'), 'utf8');
function registry(extra = {}) {
  let entries;
  vm.runInNewContext(registrySource, { UIEvents: { register(value) { entries = value; } }, ...extra });
  return entries;
}
const decode = value => value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function element(markup) {
  const attributes = Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
  const listeners = {};
  return { attributes, listeners, value: 'field', checked: true,
    hasAttribute(name) { return Object.hasOwn(attributes, name); },
    getAttribute(name) { return attributes[name] ?? null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll() { return []; },
    fire(type, event = {}) { for (const fn of listeners[type] || []) fn.call(this, event); }
  };
}

test('every generated action reference is unique, registered and its event is supported', () => {
  const entries = registry();
  const ids = [];
  const pages = path.join(__dirname, '../pages');
  for (const file of fs.readdirSync(pages).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(pages, file), 'utf8');
    for (const match of source.matchAll(/UIEvents\.attrs\("([a-z]+)","([^"]+)"/g)) {
      ids.push(match[2]);
      assert.equal(typeof entries[match[2]], 'function', file + ': ' + match[2]);
      const node = element(UIEvents.attrs(match[1], match[2]));
      UIEvents.bind(node);
      assert.equal(node.listeners[match[1]].length, 1);
    }
  }
  assert.ok(ids.length > 300);
  assert.equal(ids.length, new Set(ids).size, 'an action ID must not alias a different callback');
});

test('hostile argument text is encoded data and roundtrips without changing attributes', () => {
  const hostile = `x'\");globalThis.compromised=true;//<img src=x onerror=alert(1)>\n&amp;\\`;
  const markup = UIEvents.attrs('click', 'test-argument', [hostile, 42, false, null]);
  const node = element(markup);
  assert.deepEqual(Object.keys(node.attributes), ['data-ui-click', 'data-ui-click-args']);
  assert.deepEqual(JSON.parse(node.attributes['data-ui-click-args']), [hostile, 42, false, null]);
  let observed;
  UIEvents.register({ 'test-argument': function (event, args) { observed = { self: this, event, args }; return false; } });
  UIEvents.bind(node); UIEvents.bind(node);
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  node.fire('click', event);
  assert.equal(node.listeners.click.length, 1);
  assert.equal(observed.self, node);
  assert.equal(observed.event, event);
  assert.deepEqual(observed.args, [hostile, 42, false, null]);
  assert.equal(prevented, 1);
  assert.equal(globalThis.compromised, undefined);
});

test('malformed JSON and unknown IDs fail closed; runtime never compiles source', () => {
  let calls = 0;
  UIEvents.register({ 'test-malformed': () => calls++ });
  const node = element(UIEvents.attrs('click', 'test-malformed'));
  UIEvents.bind(node);
  node.attributes['data-ui-click-args'] = 'not JSON'; node.fire('click');
  node.attributes['data-ui-click-args'] = '{}'; node.fire('click');
  node.attributes['data-ui-click-args'] = '[]'; node.attributes['data-ui-click'] = 'constructor'; node.fire('click');
  assert.equal(calls, 0);
  assert.throws(() => UIEvents.attrs('click', 'x" onclick="evil()'));
  for (const name of ['ui-events.js', 'dynamic-events.js', 'static-events.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, name), 'utf8'), /\beval\s*\(|new\s+Function\s*\(/);
  }
});

test('client nested button stops propagation and opens the intended numeric client', () => {
  let opened, stopped = 0;
  const entries = registry({ openCD(id) { opened = id; } });
  const action = Object.values(entries).find(fn => /stopPropagation/.test(fn.toString()) && /openCD/.test(fn.toString()));
  action.call({}, { stopPropagation() { stopped++; } }, [UIEvents.value('42')]);
  assert.equal(opened, 42); assert.equal(stopped, 1);
});

test('segment conditional action and quoted homecare title retain behavior without code parsing', () => {
  const calls = [];
  const entries = registry({ segOpenDrawer(key) { calls.push(key); }, hcAcSelect(event, uid, title) { calls.push([uid, title]); } });
  entries['segments-1']({}, [true, 'vip']);
  entries['segments-1']({}, [false, 'vip']);
  const action = Object.values(entries).find(fn => /hcAcSelect/.test(fn.toString()));
  action({}, ['item-1', `D'"<b>&\\\n`]);
  assert.deepEqual(calls, ['vip', ['item-1', `D'"<b>&\\\n`]]);
});

test('legacy numeric and boolean literal coercion does not execute arbitrary strings', () => {
  assert.equal(UIEvents.value('12'), 12);
  assert.equal(UIEvents.value('false'), false);
  assert.equal(UIEvents.value('null'), null);
  assert.equal(UIEvents.value('1e3'), 1000);
  assert.equal(UIEvents.value('alert(1)'), 'alert(1)');
});
