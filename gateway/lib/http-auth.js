'use strict';
// Авторизация HTTP-API шлюза: Bearer (публичный, токен аккаунта) и
// X-Gateway-Secret (внутренний, сравнение без утечки по времени).
const crypto = require('crypto');

function bearerOf(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  return mm ? mm[1].trim() : null;
}

function internalOk(req, secret) {
  const got = String((req.headers && req.headers['x-gateway-secret']) || '');
  if (!got || !secret) return false;
  const a = Buffer.from(got), b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Тело ошибки в форме Chatpush — бэкенд (chatpush.apiError) логирует его как есть.
function chatpushError(message) { return { meta: { status: 'error', message } }; }

module.exports = { bearerOf, internalOk, chatpushError };
