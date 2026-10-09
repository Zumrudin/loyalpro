'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bearerOf, internalOk, chatpushError } = require('../lib/http-auth');

test('bearerOf', () => {
  assert.equal(bearerOf({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerOf({ headers: { authorization: 'bearer  abc ' } }), 'abc');
  assert.equal(bearerOf({ headers: {} }), null);
});
test('internalOk — timing-safe сравнение секрета', () => {
  assert.equal(internalOk({ headers: { 'x-gateway-secret': 's3' } }, 's3'), true);
  assert.equal(internalOk({ headers: { 'x-gateway-secret': 'x' } }, 's3'), false);
  assert.equal(internalOk({ headers: {} }, 's3'), false);
  assert.equal(internalOk({ headers: { 'x-gateway-secret': '' } }, ''), false);
});
test('chatpushError — форма тела как у Chatpush', () => {
  assert.deepEqual(chatpushError('нет получателя'), { meta: { status: 'error', message: 'нет получателя' } });
});
