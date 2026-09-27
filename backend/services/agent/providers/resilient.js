'use strict';

// Retry only the LLM step. Tool execution and delivery stay in the orchestrator.
function createProvider({ salonId, store, providers, legacy }) {
  let lastProvider = legacy;
  return {
    toolResultMessages: results => lastProvider.toolResultMessages(results),
    async createMessage(request, options) {
      let state = await store.get(salonId);
      const attempted = new Set();
      while (!attempted.has(state.active)) {
        attempted.add(state.active);
        const provider = providers[state.active] || legacy;
        let result;
        try {
          result = await provider.createMessage(request, state.active === 'polza'
            ? { ...options, maxRetries: 0, sdkMaxRetries: 0, fallbackTimeoutMs: 20000 } : options);
          if (!result || (!result.text?.trim() && !result.toolCalls?.length)) throw new Error('EMPTY_MODEL_RESPONSE');
        } catch (e) {
          if (!['gpt', 'claude'].includes(state.active)) {
            await store.outcome(salonId, state, 'error');
            throw e;
          }
          // Invalid local input is not model unavailability and must not be replayed.
          if (['RELAY_INPUT', 'RELAY_INPUT_TOO_LARGE'].includes(e.code)) throw e;
          const modelFailed = e.code === 'RELAY_MODEL_FAILED' || e.message === 'EMPTY_MODEL_RESPONSE';
          const next = state.active === 'gpt' && modelFailed ? 'claude' : 'polza';
          state = await store.transition(salonId, state, next,
            modelFailed ? 'model_failed' : 'bridge_unavailable') || await store.get(salonId);
          continue;
        }
        // Storage failure is not a model failure: never replay successful output.
        await store.outcome(salonId, state, 'ok', result.model || provider.MODEL || null);
        lastProvider = provider;
        return result;
      }
      throw new Error('MODEL_SELECTION_CHANGED');
    },
  };
}
module.exports = { createProvider };
