'use strict';

const config = require('../../../config');
const anthropic = require('./anthropic');
const aitunnel = require('./aitunnel');
const polza = require('./polza');

// Выбор провайдера по env. default — aitunnel (Gemini). 'polza' — Claude через
// polza.ai (миграция 2026-07-26). 'anthropic' — прямой Anthropic API (откат).
function getProvider(name) {
  const p = name || config.AGENT_PROVIDER;
  if (p === 'codex-relay') return require('./codex-relay');
  // Explicit opt-in; adapter verifies development mode or the isolated test stand.
  if (p === 'codex') return require('./codex');
  if (p === 'anthropic') return anthropic;
  if (p === 'polza') return polza;
  return aitunnel;
}

function getProviderForSalon(salonId) {
  const relay = require('./codex-relay');
  return require('./resilient').createProvider({ salonId,
    store: require('../model-routing').getStore(),
    providers: { gpt: relay, claude: relay.createProvider({ engine: 'claude' }), polza },
    legacy: getProvider(),
  });
}

module.exports = { getProvider, getProviderForSalon, anthropic, aitunnel, polza };
