'use strict';

const { createBridge } = require('../services/codex-bridge');
const codex = require('../services/agent/providers/codex');

// Deliberately never load the application's .env: this service needs no app secrets.
const server = createBridge({ secret: process.env.MILA_CODEX_RELAY_SECRET,
  generate: data => codex.createProvider({ env: { ...codex.childEnv(process.env),
    NODE_ENV: 'development', MILA_CODEX_PROTOTYPE: 'true',
    MILA_CODEX_BIN: process.env.MILA_CODEX_BIN, MILA_CODEX_TIMEOUT_MS: '90000' } }).createMessage(data),
});
server.listen(Number(process.env.MILA_CODEX_BRIDGE_PORT || 3012), '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'bridge_ready', model: codex.MODEL }));
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
