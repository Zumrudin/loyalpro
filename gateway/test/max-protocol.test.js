'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/max/protocol');

test('опкоды веб-протокола MAX (сверены с max-account-api/PyMax)', () => {
  assert.equal(p.PROTOCOL_VERSION, 11);
  assert.deepEqual(p.CMD, { REQUEST: 0, RESPONSE: 1, ERROR: 3 });
  assert.equal(p.Op.HELLO, 6); assert.equal(p.Op.LOGIN, 19); assert.equal(p.Op.MSG_SEND, 64);
  assert.equal(p.Op.NOTIF_MESSAGE, 128); assert.equal(p.Op.QR_START, 288); assert.equal(p.Op.QR_LOGIN, 291);
  assert.equal(p.Op.AUTH_CHECK_PASSWORD, 115); assert.equal(p.Op.CONTACT_INFO_BY_PHONE, 46); assert.equal(p.Op.CHAT_HISTORY, 49);
});

test('webUserAgent: WEB-профиль с переданной версией, дефолт 26.5.5', () => {
  const ua = p.webUserAgent('27.1.0');
  assert.equal(ua.deviceType, 'WEB'); assert.equal(ua.appVersion, '27.1.0'); assert.equal(ua.timezone, 'Europe/Moscow');
  assert.equal(p.webUserAgent().appVersion, '26.5.5');
  assert.match(p.HEADER_USER_AGENT, /Chrome/);
});

test('isTokenRevoked: FAIL_LOGIN_TOKEN / FAIL_LOGOUT_ALL в code или serverMessage', () => {
  assert.equal(p.isTokenRevoked({ code: 'FAIL_LOGIN_TOKEN' }), true);
  assert.equal(p.isTokenRevoked({ code: 'x', serverMessage: 'FAIL_LOGOUT_ALL' }), true);
  assert.equal(p.isTokenRevoked({ code: 'timeout' }), false);
  assert.equal(p.isTokenRevoked(null), false);
});
