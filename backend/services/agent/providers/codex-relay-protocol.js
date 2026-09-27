'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const MODEL = 'gpt-6-sol';
const MAX_BYTES = 2 * 1024 * 1024;
const ROUTE = '/api/mila-codex/v1/message';

function signature(secret, timestamp, id, body) {
  return createHmac('sha256', secret).update(`POST\n${ROUTE}\n${timestamp}\n${id}\n`).update(body).digest('hex');
}
function authorized(secret, headers, body, now = Date.now()) {
  const timestamp = headers['x-mila-timestamp'];
  const id = headers['x-mila-request-id'];
  const supplied = headers['x-mila-signature'];
  if (!secret || secret.length < 32 || !/^\d{13}$/.test(timestamp || '')
      || Math.abs(now - Number(timestamp)) > 60000
      || !/^[a-f0-9-]{36}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(supplied || '')) return false;
  return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(secret, timestamp, id, body), 'hex'));
}
function validRequest(data) {
  return !!data && typeof data.system === 'string' && Array.isArray(data.messages)
    && data.messages.length > 0 && data.messages.length <= 500
    && data.messages.every(m => m && ['user', 'assistant', 'tool'].includes(m.role))
    && Array.isArray(data.tools) && data.tools.length <= 100
    && data.tools.every(t => t && typeof t.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(t.name)
      && t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema))
    && Object.keys(data).every(k => ['system', 'messages', 'tools'].includes(k));
}
function failure(code) {
  const e = new Error(`Codex relay: ${code}`);
  e.code = code;
  return e;
}
module.exports = { MODEL, MAX_BYTES, ROUTE, signature, authorized, validRequest, failure };
