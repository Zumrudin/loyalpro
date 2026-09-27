'use strict';

const { randomUUID } = require('node:crypto');
const { MODEL, CLAUDE_MODEL, MAX_BYTES, signature, validRequest, failure, ROUTE } = require('./codex-relay-protocol');
const codex = require('./codex');

function createProvider({ env = process.env, fetchImpl = globalThis.fetch, allowLoopback = false, engine = 'gpt' } = {}) {
  if (!['gpt', 'claude'].includes(engine)) throw failure('RELAY_CONFIG');
  const model = engine === 'claude' ? CLAUDE_MODEL : MODEL;
  return {
    MODEL: model,
    async createMessage({ system, messages, tools = [] }) {
      const secret = env.MILA_CODEX_RELAY_SECRET;
      let url;
      try { url = new URL(env.MILA_CODEX_RELAY_URL); } catch (_) { throw failure('RELAY_CONFIG'); }
      if ((!allowLoopback || url.hostname !== '127.0.0.1') && url.protocol !== 'https:') throw failure('RELAY_CONFIG');
      if (url.pathname !== ROUTE || url.username || url.password || url.search || url.hash
          || !secret || secret.length < 32) throw failure('RELAY_CONFIG');
      const data = { system, messages, tools };
      if (engine === 'claude') data.engine = engine;
      if (!validRequest(data)) throw failure('RELAY_INPUT');
      const body = JSON.stringify(data);
      if (Buffer.byteLength(body) > MAX_BYTES) throw failure('RELAY_INPUT_TOO_LARGE');
      const id = randomUUID(), timestamp = String(Date.now());
      const controller = new AbortController();
      // Includes the bounded queue (20 s), login (10 s) and CLI (90 s).
      const timer = setTimeout(() => controller.abort(), 125000);
      try {
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-mila-request-id': id,
            'x-mila-timestamp': timestamp, 'x-mila-signature': signature(secret, timestamp, id, body) }, body });
        if (!response.ok) {
          // Only this bounded bridge error proves that the model, not the
          // transport/proxy, failed. Do not retry a dead bridge with Claude.
          if (response.status === 502) {
            let bytes = 0; const chunks = [];
            for await (const chunk of response.body) {
              bytes += chunk.length;
              if (bytes > 1024) { controller.abort(); throw failure('RELAY_UPSTREAM'); }
              chunks.push(Buffer.from(chunk));
            }
            let error;
            try { error = JSON.parse(Buffer.concat(chunks).toString()).error; } catch (_) { /* proxy error */ }
            if (error === 'GENERATION_FAILED') throw failure('RELAY_MODEL_FAILED');
            throw failure('RELAY_UPSTREAM');
          }
          if (response.body) await response.body.cancel();
          throw failure(response.status === 429 ? 'RELAY_BUSY' : response.status === 401 ? 'RELAY_AUTH' : 'RELAY_UPSTREAM');
        }
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { controller.abort(); throw failure('RELAY_RESPONSE_TOO_LARGE'); }
          chunks.push(Buffer.from(chunk));
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.model !== model || result.requestId !== id) throw failure('RELAY_RESPONSE');
        // Revalidate the tool names/arguments on the caller against its own schemas.
        // Fresh tool IDs are generated here and remain local to the caller's dialog.
        let parsed;
        try { parsed = codex.parseResponse([
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result.output) } },
          { type: 'turn.completed' },
        ].map(e => JSON.stringify(e)).join('\n'), tools); }
        catch (_) { throw failure('RELAY_MODEL_FAILED'); }
        return { ...parsed, model };
      } catch (e) {
        if (/^RELAY_[A-Z_]+$/.test(e.code || '')) throw e;
        throw failure(controller.signal.aborted ? 'RELAY_TIMEOUT' : 'RELAY_FAILED');
      } finally { clearTimeout(timer); }
    },
    toolResultMessages: codex.toolResultMessages,
  };
}
module.exports = { ...createProvider(), createProvider };
