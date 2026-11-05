'use strict';

const { randomUUID } = require('node:crypto');
const { MODEL, GPT_MODELS, SOL_MODEL, CLAUDE_MODEL, ENGINES, MAX_BYTES, signature, validRequest, failure, ROUTE } = require('./codex-relay-protocol');
const codex = require('./codex');

function createProvider({ env = process.env, fetchImpl = globalThis.fetch, allowLoopback = false, engine = 'gpt' } = {}) {
  if (!ENGINES.includes(engine)) throw failure('RELAY_CONFIG');
  const model = { gpt: MODEL, sol: SOL_MODEL, claude: CLAUDE_MODEL }[engine];
  const accepted = { gpt: GPT_MODELS, sol: [SOL_MODEL], claude: [CLAUDE_MODEL] }[engine];
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
      if (engine !== 'gpt') data.engine = engine;
      if (!validRequest(data)) throw failure('RELAY_INPUT');
      const body = JSON.stringify(data);
      if (Buffer.byteLength(body) > MAX_BYTES) throw failure('RELAY_INPUT_TOO_LARGE');
      const id = randomUUID(), timestamp = String(Date.now());
      const controller = new AbortController();
      const started = Date.now();
      // Diagnostics for the caller's journal (resilient.js): request id to match
      // the bridge journal, HTTP status, the bridge's own failure code, timing.
      const fail = (code, extra = {}) => Object.assign(failure(code), { requestId: id, engine, ...extra });
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
              if (bytes > 1024) { controller.abort(); throw fail('RELAY_UPSTREAM', { httpStatus: 502 }); }
              chunks.push(Buffer.from(chunk));
            }
            let error, cause = null;
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString());
              error = parsed.error;
              if (/^[A-Z][A-Z0-9_]{2,40}$/.test(parsed.cause || '')) cause = parsed.cause;
            } catch (_) { /* proxy error */ }
            if (error === 'GENERATION_FAILED') throw fail('RELAY_MODEL_FAILED', { httpStatus: 502, bridgeCause: cause });
            throw fail('RELAY_UPSTREAM', { httpStatus: 502 });
          }
          // Bridge errors are tiny JSON ({error:"BUSY"}); proxy pages are not
          // worth reading past 1 KB. The code only labels the journal line.
          let bridgeError = null;
          try {
            let bytes = 0; const chunks = [];
            if (response.body) {
              for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > 1024) break;
                chunks.push(Buffer.from(chunk));
              }
            }
            const parsed = bytes <= 1024 ? JSON.parse(Buffer.concat(chunks).toString()).error : null;
            if (/^[A-Z][A-Z_]{2,40}$/.test(parsed || '')) bridgeError = parsed;
          } catch (_) { /* proxy page or empty body */ }
          throw fail(response.status === 429 ? 'RELAY_BUSY' : response.status === 401 ? 'RELAY_AUTH' : 'RELAY_UPSTREAM',
            { httpStatus: response.status, bridgeCause: bridgeError });
        }
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { controller.abort(); throw fail('RELAY_RESPONSE_TOO_LARGE'); }
          chunks.push(Buffer.from(chunk));
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!accepted.includes(result.model) || result.requestId !== id) {
          throw fail('RELAY_RESPONSE', { bridgeCause: result.requestId !== id ? 'REQUEST_ID_MISMATCH' : 'MODEL_MISMATCH' });
        }
        // Revalidate the tool names/arguments on the caller against its own schemas.
        // Fresh tool IDs are generated here and remain local to the caller's dialog.
        let parsed;
        try { parsed = codex.parseResponse([
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result.output) } },
          { type: 'turn.completed' },
        ].map(e => JSON.stringify(e)).join('\n'), tools); }
        catch (e) { throw fail('RELAY_MODEL_FAILED', { bridgeCause: 'RELAY_REVALIDATE', reason: e.detail?.reason || null }); }
        return { ...parsed, model: result.model };
      } catch (e) {
        if (/^RELAY_[A-Z_]+$/.test(e.code || '')) { e.ms = Date.now() - started; throw e; }
        // Network-level reason (ECONNRESET, UND_ERR_CONNECT_TIMEOUT…): a code, never a message.
        const net = [e?.cause?.code, e?.code].find(c => /^[A-Z][A-Z0-9_]{2,40}$/.test(c || '')) || null;
        throw fail(controller.signal.aborted ? 'RELAY_TIMEOUT' : 'RELAY_FAILED', { netCause: net, ms: Date.now() - started });
      } finally { clearTimeout(timer); }
    },
    toolResultMessages: codex.toolResultMessages,
  };
}
module.exports = { ...createProvider(), createProvider };
