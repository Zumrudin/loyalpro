'use strict';

// Standalone transport: no app config, database, CRM, dispatcher or message sender.
const http = require('node:http');
const { MODEL, SOL_MODEL, CLAUDE_MODEL, MAX_BYTES, ROUTE, authorized, validRequest } = require('./agent/providers/codex-relay-protocol');

// Only fixed-form codes leave the bridge (502 body `cause`, journal `error`).
const safeCode = code => (/^[A-Z][A-Z0-9_]{2,40}$/.test(code || '') ? code : 'UNKNOWN');

// `log` receives one flat object per request outcome. It must never carry
// prompts, history or model output: ids, engine, status, timings, codes and the
// providers' own diagnostic `detail` (API/CLI error text, already cut).
function createBridge({ secret, generate, generateSol, generateClaude, concurrency = 2, maxQueue = 8, queueMs = 20000,
  maxPerMinute = 60, now = Date.now, log = () => {} } = {}) {
  if (!secret || secret.length < 32 || typeof generate !== 'function') throw new Error('BRIDGE_CONFIG');
  const engines = {
    gpt: { fn: generate, model: MODEL },
    sol: { fn: generateSol, model: SOL_MODEL },
    claude: { fn: generateClaude, model: CLAUDE_MODEL },
  };
  let active = 0, count = 0, windowStart = now();
  const seen = new Map(), queue = [];
  const journal = entry => { try { log({ event: 'request', ...entry }); } catch (_) { /* logging never breaks a reply */ } };
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
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, model: MODEL, sol: SOL_MODEL });
    if (req.method !== 'POST' || req.url !== ROUTE) return reply(res, 404, { error: 'NOT_FOUND' });
    const started = now();
    const out = (status, data, extra = {}) => {
      journal({ status, ms: now() - started, ...extra });
      reply(res, status, data);
    };
    if (!/^[a-f0-9]{64}$/.test(req.headers['x-mila-signature'] || '')) return out(401, { error: 'UNAUTHORIZED' }, { error: 'NO_SIGNATURE' });
    if (req.headers['content-type'] !== 'application/json') return out(415, { error: 'CONTENT_TYPE' }, { error: 'CONTENT_TYPE' });
    if (Number(req.headers['content-length'] || 0) > MAX_BYTES) return out(413, { error: 'TOO_LARGE' }, { error: 'TOO_LARGE' });
    let id = null, engine = null;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { out(413, { error: 'TOO_LARGE' }, { error: 'TOO_LARGE' }); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      // Timestamp skew is the one auth failure worth telling apart in the journal.
      if (!authorized(secret, req.headers, body, now())) {
        const skew = Math.round((now() - Number(req.headers['x-mila-timestamp'])) / 1000);
        return out(401, { error: 'UNAUTHORIZED' }, { error: 'BAD_SIGNATURE', skewS: Number.isFinite(skew) ? skew : null });
      }
      id = req.headers['x-mila-request-id'];
      for (const [key, expires] of seen) if (expires <= now()) seen.delete(key);
      if (seen.has(id)) return out(409, { error: 'DUPLICATE' }, { id, error: 'DUPLICATE' });
      if (now() - windowStart >= 60000) { count = 0; windowStart = now(); }
      if (count >= maxPerMinute) return out(429, { error: 'RATE_LIMIT' }, { id, error: 'RATE_LIMIT', perMinute: count });
      count++; seen.set(id, now() + 125000);
      let data;
      try { data = JSON.parse(body); } catch (_) { return out(400, { error: 'BAD_REQUEST' }, { id, error: 'BAD_JSON' }); }
      if (!validRequest(data)) return out(400, { error: 'BAD_REQUEST' }, { id, error: 'BAD_REQUEST' });
      engine = data.engine || 'gpt';
      const queuedAt = now();
      try { await acquire(); } catch (_) {
        return out(429, { error: 'BUSY' }, { id, engine, error: 'BUSY', active, queued: queue.length, queueMs: now() - queuedAt });
      }
      const queueWait = now() - queuedAt;
      try {
        if (res.destroyed) return journal({ id, engine, status: 499, ms: now() - started, error: 'CLIENT_GONE' });
        const { fn, model } = engines[engine];
        if (!fn) throw Object.assign(new Error('ENGINE_UNAVAILABLE'), { code: 'ENGINE_UNAVAILABLE' });
        const { engine: _engine, ...input } = data;
        const genStarted = now();
        const result = await fn(input);
        const output = { text: result.text, toolCalls: result.toolCalls.map(t => ({ name: t.name, arguments: JSON.stringify(t.input) })) };
        const payload = { requestId: id, model, output };
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) throw Object.assign(new Error('TOO_LARGE'), { code: 'OUTPUT_TOO_LARGE' });
        out(200, payload, { id, engine, model, queueMs: queueWait, genMs: now() - genStarted, toolCalls: output.toolCalls.length });
      } finally { release(); }
    } catch (e) {
      // `cause` is a fixed code so the caller can log WHY without any content.
      const cause = safeCode(e?.code);
      out(502, { error: 'GENERATION_FAILED', cause }, { id, engine, error: cause, detail: e?.detail || null });
    }
  });
  server.requestTimeout = 15000; // Body upload deadline; generation has its own timeout.
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createBridge };
