'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const s = require('../lib/max/session');

test('load: нет файла → свежий deviceId (uuid), save атомарно, повторный load отдаёт то же', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-s-')) + '/max';
  const fresh = s.load(dir);
  assert.match(fresh.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.loginToken, undefined);
  s.save(dir, { ...fresh, loginToken: 'T', ownerId: 10001, phone: '79200255591', displayName: 'Тест' });
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);       // tmp-файла не осталось
  assert.deepEqual(s.load(dir), { deviceId: fresh.deviceId, loginToken: 'T', ownerId: 10001, phone: '79200255591', displayName: 'Тест' });
  assert.equal(s.hasToken(dir), true);
  s.remove(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(s.hasToken(dir), false);
});

test('load: битый JSON или без deviceId → свежая сессия', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-s-'));
  fs.writeFileSync(path.join(dir, 'session.json'), '{bad');
  assert.match(s.load(dir).deviceId, /^[0-9a-f-]{36}$/);
  fs.writeFileSync(path.join(dir, 'session.json'), '{"loginToken":"T"}');
  assert.equal(s.load(dir).loginToken, undefined);
});
