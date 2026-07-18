'use strict';

const config = require('../../../config');
const anthropic = require('./anthropic');
const aitunnel = require('./aitunnel');

// Выбор провайдера по env. default — aitunnel (Gemini). 'anthropic' — откат к Claude.
function getProvider(name) {
  const p = name || config.AGENT_PROVIDER;
  if (p === 'anthropic') return anthropic;
  return aitunnel;
}

module.exports = { getProvider, anthropic, aitunnel };
