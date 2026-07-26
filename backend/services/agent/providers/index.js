'use strict';

const config = require('../../../config');
const anthropic = require('./anthropic');
const aitunnel = require('./aitunnel');
const polza = require('./polza');

// Выбор провайдера по env. default — aitunnel (Gemini). 'polza' — Claude через
// polza.ai (миграция 2026-07-26). 'anthropic' — прямой Anthropic API (откат).
function getProvider(name) {
  const p = name || config.AGENT_PROVIDER;
  if (p === 'anthropic') return anthropic;
  if (p === 'polza') return polza;
  return aitunnel;
}

module.exports = { getProvider, anthropic, aitunnel, polza };
