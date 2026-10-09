'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeSender } = require('../lib/webhook-sender');

test('успех с первой попытки', async () => {
  const calls = [];
  const send = makeSender({ url: 'http://x/gateway/webhook?key=k', post: async (url, body) => { calls.push([url, body]); return { status: 200 }; }, sleep: async () => {} });
  await send({ type: 't' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://x/gateway/webhook?key=k');
  assert.deepEqual(calls[0][1], { type: 't' });
});

test('повторяет до 3 раз с растущей паузой, потом бросает', async () => {
  let n = 0; const sleeps = [];
  const send = makeSender({ url: 'u', post: async () => { n++; throw new Error('down'); }, sleep: async (ms) => { sleeps.push(ms); }, attempts: 3 });
  await assert.rejects(send({}), /down/);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('401 от бэкенда не повторяется (неверный секрет)', async () => {
  let n = 0;
  const send = makeSender({ url: 'u', post: async () => { n++; const e = new Error('401'); e.response = { status: 401 }; throw e; }, sleep: async () => {}, attempts: 3 });
  await assert.rejects(send({}), /401/);
  assert.equal(n, 1);
});

test('503 (бэкенд просит повторить) → повтор', async () => {
  let n = 0;
  const send = makeSender({ url: 'u', post: async () => { n++; if (n < 2) { const e = new Error('503'); e.response = { status: 503 }; throw e; } return { status: 200 }; }, sleep: async () => {}, attempts: 3 });
  await send({});
  assert.equal(n, 2);
});
