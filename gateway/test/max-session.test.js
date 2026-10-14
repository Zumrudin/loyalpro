'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const s = require('../lib/max/session');

const TMP = [];
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); });
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-s-')); TMP.push(d); return d; };

test('load: нет файла → свежий deviceId (uuid), save атомарно, повторный load отдаёт то же', () => {
  const dir = tmpdir() + '/max';
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
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'session.json'), '{bad');
  assert.match(s.load(dir).deviceId, /^[0-9a-f-]{36}$/);
  fs.writeFileSync(path.join(dir, 'session.json'), '{"loginToken":"T"}');
  assert.equal(s.load(dir).loginToken, undefined);
});

test('save: файл сессии (в нём токен входа) доступен только владельцу — 0600, и после перезаписи', () => {
  const dir = tmpdir() + '/max';
  s.save(dir, { deviceId: 'd', loginToken: 'T' });
  assert.equal(fs.statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
  s.save(dir, { deviceId: 'd', loginToken: 'T2' });
  assert.equal(fs.statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
});
