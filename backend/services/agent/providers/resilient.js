'use strict';

const { createLogger } = require('../../../logger');

// Bridge engines in fallback order. A failure of the MODEL (bridge answered
// GENERATION_FAILED, invalid/empty output) moves to the next engine on the same
// bridge; a failure of the BRIDGE itself (network, timeout, 429, 401, proxy)
// goes straight to Polza — every other bridge engine would fail the same way.
const BRIDGE_ENGINES = ['gpt', 'sol', 'claude'];
const NEXT_ON_MODEL_FAILURE = { gpt: 'sol', sol: 'claude', claude: 'polza' };

// One line that explains a failed attempt without any prompt or output text:
// error code, the bridge's own cause, HTTP status, network code, timing and the
// request id that matches the bridge journal (journalctl -u mila-codex-bridge).
function describeFailure(e, ms) {
  const parts = [e?.code || String(e?.message || e).slice(0, 200)];
  if (e?.bridgeCause) parts.push(`мост: ${e.bridgeCause}`);
  if (e?.reason) parts.push(`причина: ${String(e.reason).slice(0, 120)}`);
  if (e?.httpStatus) parts.push(`http ${e.httpStatus}`);
  if (e?.netCause) parts.push(`сеть: ${e.netCause}`);
  parts.push(`${ms} мс`);
  if (e?.requestId) parts.push(`req ${e.requestId}`);
  return parts.join(', ');
}

// Retry only the LLM step. Tool execution and delivery stay in the orchestrator.
function createProvider({ salonId, store, providers, legacy, log = createLogger('AgentModelRouting') }) {
  let lastProvider = legacy;
  return {
    toolResultMessages: results => lastProvider.toolResultMessages(results),
    async createMessage(request, options) {
      let state = await store.get(salonId);
      const attempted = new Set();
      const failed = [];
      while (!attempted.has(state.active)) {
        attempted.add(state.active);
        const active = state.active;
        const provider = providers[active] || legacy;
        const started = Date.now();
        let result;
        try {
          result = await provider.createMessage(request, active === 'polza'
            ? { ...options, maxRetries: 0, sdkMaxRetries: 0, fallbackTimeoutMs: 20000 } : options);
          if (!result || (!result.text?.trim() && !result.toolCalls?.length)) throw new Error('EMPTY_MODEL_RESPONSE');
        } catch (e) {
          const what = describeFailure(e, Date.now() - started);
          if (!BRIDGE_ENGINES.includes(active)) {
            log.warn(`салон ${salonId}: ${active} отказала: ${what}${failed.length ? ` (до неё: ${failed.join(' → ')})` : ''}`);
            await store.outcome(salonId, state, 'error');
            throw e;
          }
          // Invalid local input is not model unavailability and must not be replayed.
          if (['RELAY_INPUT', 'RELAY_INPUT_TOO_LARGE'].includes(e.code)) {
            log.warn(`салон ${salonId}: запрос к ${active} отклонён до отправки: ${what} — модель не переключаю`);
            throw e;
          }
          const modelFailed = e.code === 'RELAY_MODEL_FAILED' || e.message === 'EMPTY_MODEL_RESPONSE';
          const next = modelFailed ? NEXT_ON_MODEL_FAILURE[active] : 'polza';
          const reason = modelFailed ? 'model_failed' : 'bridge_unavailable';
          failed.push(active);
          const moved = await store.transition(salonId, state, next, reason);
          if (moved) {
            log.warn(`салон ${salonId}: ${active} отказала: ${what} → переключаю на ${next} (${reason})`);
            state = moved;
          } else {
            // CAS lost: a manual switch or another dialog changed the selection.
            state = await store.get(salonId);
            log.warn(`салон ${salonId}: ${active} отказала: ${what}; переключение на ${next} не записано — выбор уже ${state.active} (rev ${state.revision})`);
          }
          continue;
        }
        if (failed.length) {
          log.info(`салон ${salonId}: ответила ${active} (${result.model || provider.MODEL || '?'}) за ${Date.now() - started} мс после отказа ${failed.join(' → ')}`);
        }
        // Storage failure is not a model failure: never replay successful output.
        await store.outcome(salonId, state, 'ok', result.model || provider.MODEL || null);
        lastProvider = provider;
        return result;
      }
      log.warn(`салон ${salonId}: цепочка замкнулась на ${state.active} после отказа ${failed.join(' → ')} — ход без ответа модели`);
      throw new Error('MODEL_SELECTION_CHANGED');
    },
  };
}
module.exports = { createProvider, BRIDGE_ENGINES, NEXT_ON_MODEL_FAILURE, describeFailure };
