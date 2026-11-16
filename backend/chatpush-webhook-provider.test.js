'use strict';
jest.mock('./config', () => ({
  CHATPUSH: { webhookSecret: 'cpsecret', agentEnabled: false, salonId: 1, customerId: 777 },
  MESSAGING_GATEWAY: { webhookSecret: 'gwsecret' },
}));
// Роутер тянет БД/диспетчер/SSE — в юнит-тесте нужны только чистые помощники.
jest.mock('./db', () => ({ db: { query: jest.fn(), one: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
const { verifySecret, providerOf } = require('./routes/chatpush-webhook');

const req = (baseUrl, key) => ({ baseUrl, query: key === undefined ? {} : { key } });

test('providerOf: /gateway → gateway, иначе chatpush', () => {
  expect(providerOf({ baseUrl: '/gateway' })).toBe('gateway');
  expect(providerOf({ baseUrl: '/chatpush' })).toBe('chatpush');
  expect(providerOf({ baseUrl: '' })).toBe('chatpush');
});

test('verifySecret сверяет ключ СВОЕГО провайдера', () => {
  expect(verifySecret(req('/chatpush', 'cpsecret')).ok).toBe(true);
  expect(verifySecret(req('/chatpush', 'gwsecret')).ok).toBe(false);
  expect(verifySecret(req('/gateway', 'gwsecret')).ok).toBe(true);
  expect(verifySecret(req('/gateway', 'cpsecret')).ok).toBe(false);
  expect(verifySecret(req('/gateway')).ok).toBe(false);
});

test('у шлюза нет legacy-режима: пустой секрет шлюза → отказ', () => {
  const config = require('./config');
  const prev = config.MESSAGING_GATEWAY.webhookSecret;
  config.MESSAGING_GATEWAY.webhookSecret = '';
  try { expect(verifySecret(req('/gateway', 'x')).ok).toBe(false); }
  finally { config.MESSAGING_GATEWAY.webhookSecret = prev; }
});

test('у Chatpush пустой секрет → 503, legacy-приёма нет', () => {
  const config = require('./config');
  const prev = config.CHATPUSH.webhookSecret;
  config.CHATPUSH.webhookSecret = '';
  try {
    expect(verifySecret(req('/chatpush'))).toEqual({ ok: false, status: 503, reason: 'chatpush secret not configured' });
    expect(verifySecret(req('/chatpush', 'anything'))).toEqual({ ok: false, status: 503, reason: 'chatpush secret not configured' });
  } finally { config.CHATPUSH.webhookSecret = prev; }
});

test('webhookSummary исключает URL и остальной provider payload', () => {
  const marker = 'synthetic-webhook-secret';
  const summary = require('./services/chatpush').webhookSummary({
    id: 57,
    url: `https://example.invalid/chatpush/webhook?key=${marker}`,
    types: ['tdlib_incoming_msg', `https://example.invalid/?key=${marker}`],
    secret: marker,
    meta: { response: marker },
  });
  expect(summary).toEqual({ id: 57, types: ['tdlib_incoming_msg'] });
  expect(JSON.stringify(summary)).not.toContain(marker);
});

test('registration CLI использует sanitized summary и safeErrorCode вместо raw response', () => {
  const source = require('fs').readFileSync(`${__dirname}/chatpush-register-webhook.js`, 'utf8');
  expect(source).toContain('all.map(chatpush.webhookSummary)');
  expect(source).toContain('JSON.stringify(chatpush.webhookSummary(wh)');
  expect(source).toContain('safeErrorCode(e)');
  expect(source).not.toContain('JSON.stringify(all,');
  expect(source).not.toContain('JSON.stringify(wh,');
  expect(source).not.toContain('JSON.stringify(meta)');
  expect(source).not.toContain('e.response?.data');
  expect(source).not.toContain("console.log('Регистрирую webhook →', URL)");
});
