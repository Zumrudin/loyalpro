'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeSender, makeSafe } = require('../lib/webhook-sender');

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

test('4xx кроме 408/429 не повторяются', async () => {
  for (const st of [401, 404]) {
    let n = 0;
    const send = makeSender({ url: 'u', post: async () => { n++; const e = new Error(String(st)); e.response = { status: st }; throw e; }, sleep: async () => {}, attempts: 3 });
    await assert.rejects(send({}), new RegExp(String(st)));
    assert.equal(n, 1);
  }
});

test('503 (бэкенд просит повторить) → повтор', async () => {
  let n = 0;
  const send = makeSender({ url: 'u', post: async () => { n++; if (n < 2) { const e = new Error('503'); e.response = { status: 503 }; throw e; } return { status: 200 }; }, sleep: async () => {}, attempts: 3 });
  await send({});
  assert.equal(n, 2);
});

test('makeSafe глотает ошибку и логирует идентификаторы события', async () => {
  const lines = [];
  const safe = makeSafe(async () => { const e = new Error('down'); e.response = { status: 503 }; throw e; }, { error: (m) => lines.push(m) });
  await safe({ type: 't', payload: { customer_id: 42, direction: 'incoming', message: { id: '5:1' } } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /acc=42/);
  assert.match(lines[0], /msg=5:1/);
  assert.match(lines[0], /status=503/);
});

test('расписание повторов растёт до 30 с и переживает рестарт бэкенда (~2,5 мин суммарно)', async () => {
  const { RETRY_DELAYS_MS, DEFAULT_ATTEMPTS } = require('../lib/webhook-sender');
  const sleeps = [];
  const send = makeSender({ url: 'u', post: async () => { const e = new Error('503'); e.response = { status: 503 }; throw e; }, sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(send({}), /503/);
  assert.equal(sleeps.length, DEFAULT_ATTEMPTS - 1);
  assert.deepEqual(sleeps, RETRY_DELAYS_MS);
  assert.ok(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) >= 120000, 'не меньше двух минут');
});
