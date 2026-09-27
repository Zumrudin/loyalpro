'use strict';

// Standalone transport: no app config, database, CRM, dispatcher or message sender.
const http = require('node:http');
const { MODEL, MAX_BYTES, ROUTE, authorized, validRequest } = require('./agent/providers/codex-relay-protocol');

function createBridge({ secret, generate, concurrency = 2, maxQueue = 8, queueMs = 20000,
  maxPerMinute = 60, now = Date.now } = {}) {
  if (!secret || secret.length < 32 || typeof generate !== 'function') throw new Error('BRIDGE_CONFIG');
  let active = 0, count = 0, windowStart = now();
  const seen = new Map(), queue = [];
  function release() {
    active--;
    const next = queue.shift();
    if (next) { clearTimeout(next.timer); active++; next.resolve(); }
  }
  function acquire() {
    if (active < concurrency) { active++; return Promise.resolve(); }
    if (queue.length >= maxQueue) return Promise.reject(new Error('BUSY'));
    return new Promise((resolve, reject) => {
      const item = { resolve };
      item.timer = setTimeout(() => { queue.splice(queue.indexOf(item), 1); reject(new Error('BUSY')); }, queueMs);
      queue.push(item);
    });
  }
  function reply(res, status, data) {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, model: MODEL });
    if (req.method !== 'POST' || req.url !== ROUTE) return reply(res, 404, { error: 'NOT_FOUND' });
    if (!/^[a-f0-9]{64}$/.test(req.headers['x-mila-signature'] || '')) return reply(res, 401, { error: 'UNAUTHORIZED' });
    if (req.headers['content-type'] !== 'application/json') return reply(res, 415, { error: 'CONTENT_TYPE' });
    if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return reply(res, 413, { error: 'TOO_LARGE' });
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { reply(res, 413, { error: 'TOO_LARGE' }); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!authorized(secret, req.headers, body, now())) return reply(res, 401, { error: 'UNAUTHORIZED' });
      const id = req.headers['x-mila-request-id'];
      for (const [key, expires] of seen) if (expires <= now()) seen.delete(key);
      if (seen.has(id)) return reply(res, 409, { error: 'DUPLICATE' });
      if (now() - windowStart >= 60000) { count = 0; windowStart = now(); }
      if (count >= maxPerMinute) return reply(res, 429, { error: 'RATE_LIMIT' });
      count++; seen.set(id, now() + 125000);
      let data;
      try { data = JSON.parse(body); } catch (_) { return reply(res, 400, { error: 'BAD_REQUEST' }); }
      if (!validRequest(data)) return reply(res, 400, { error: 'BAD_REQUEST' });
      try { await acquire(); } catch (_) { return reply(res, 429, { error: 'BUSY' }); }
      try {
        if (res.destroyed) return;
        const result = await generate(data);
        const output = { text: result.text, toolCalls: result.toolCalls.map(t => ({ name: t.name, arguments: JSON.stringify(t.input) })) };
        const payload = { requestId: id, model: MODEL, output };
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) throw new Error('TOO_LARGE');
        reply(res, 200, payload);
      } finally { release(); }
    } catch (_) { reply(res, 502, { error: 'GENERATION_FAILED' }); }
  });
  server.requestTimeout = 15000; // Body upload deadline; generation has its own timeout.
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createBridge };
