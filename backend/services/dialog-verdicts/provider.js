// backend/services/dialog-verdicts/provider.js
'use strict';
// ============================================================
// Цепочка провайдеров для анализа переписок. Те же звенья, что у Милы
// (providers/resilient.js): прод — GPT через мост dev → Claude через тот же мост →
// Польза; дев (AGENT_PROVIDER=codex) — локальный Codex → Польза. ОТЛИЧИЕ от
// resilient.js принципиальное: store маршрутизации (agent_model_routing) здесь
// НЕ читается и НЕ пишется — модуль его даже не импортирует (закреплено тестом).
// Иначе упавший ночной анализ переключил бы Милу на резерв и повесил уведомление
// в админке. CODEX_BUSY/RELAY_BUSY — временное: пауза и один повтор на том же
// звене (мост держит 2 слота, Мила могла занять оба), потом дальше.
// ============================================================
const config = require('../../config');
const { safeError } = require('./errors');

const BUSY_CODES = ['CODEX_BUSY', 'RELAY_BUSY'];
const BUSY_WAIT_MS = 30000;
const POLZA_OPTS = { maxTokens: 8000, maxRetries: 1, sdkMaxRetries: 0, fallbackTimeoutMs: 30000 };
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// links: { gpt, claude, polza, codex } → упорядоченная цепочка.
function buildChain(agentProvider, links) {
  if (agentProvider === 'codex-relay') return [links.gpt, links.claude, links.polza];
  if (agentProvider === 'codex') return [links.codex, links.polza];
  return [links.polza];
}

function defaultLinks() {
  const relay = require('../agent/providers/codex-relay');
  const polza = require('../agent/providers/polza');
  return {
    gpt: { name: 'gpt', createMessage: relay.createMessage },
    claude: { name: 'claude', createMessage: relay.createProvider({ engine: 'claude' }).createMessage },
    codex: { name: 'codex', createMessage: require('../agent/providers/codex').createMessage },
    polza: { name: 'polza', isPolza: true, createMessage: polza.createMessage },
  };
}

function createVerdictProvider({ chain, sleep = defaultSleep, busyWaitMs = BUSY_WAIT_MS } = {}) {
  const links = chain || buildChain(config.AGENT_PROVIDER, defaultLinks());
  return {
    async createMessage(request) {
      let last = null;
      let skipClaude = false;
      for (const l of links) {
        if (skipClaude && l.name === 'claude') continue;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await l.createMessage(request, l.isPolza ? POLZA_OPTS : undefined);
            if (!res || !String(res.text || '').trim()) throw Object.assign(new Error('EMPTY_MODEL_RESPONSE'), { code: 'EMPTY_MODEL_RESPONSE' });
            return { text: res.text, model: res.model || l.name };
          } catch (e) {
            last = e;
            if (['RELAY_INPUT', 'RELAY_INPUT_TOO_LARGE'].includes(e.code)) throw e;
            if (attempt === 0 && BUSY_CODES.includes(e.code)) { await sleep(busyWaitMs); continue; }
            if (l.name === 'gpt' && e.code !== 'RELAY_MODEL_FAILED' && e.code !== 'EMPTY_MODEL_RESPONSE') skipClaude = true;
            break;
          }
        }
      }
      const e = new Error(`все провайдеры анализа отказали: ${safeError(last)}`);
      e.code = 'VERDICT_PROVIDER_FAILED';
      e.cause = last;
      throw e;
    },
  };
}

module.exports = { createVerdictProvider, buildChain, BUSY_CODES, BUSY_WAIT_MS };
