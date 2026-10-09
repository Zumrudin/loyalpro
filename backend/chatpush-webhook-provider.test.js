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

test('у Chatpush пустой секрет → legacy (принимаем без проверки), как раньше', () => {
  const config = require('./config');
  const prev = config.CHATPUSH.webhookSecret;
  config.CHATPUSH.webhookSecret = '';
  try { expect(verifySecret(req('/chatpush'))).toEqual({ ok: true, mode: 'legacy' }); }
  finally { config.CHATPUSH.webhookSecret = prev; }
});
