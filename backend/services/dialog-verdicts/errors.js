'use strict';
// Never persist provider/SQL messages: they can contain prompts or credentials.
const SAFE_CODES = new Set(['VERDICT_PROVIDER_FAILED', 'RUN_IN_PROGRESS', 'RELAY_BUSY', 'CODEX_BUSY', 'RELAY_MODEL_FAILED', 'RELAY_UPSTREAM', 'RELAY_TIMEOUT', 'RELAY_AUTH', 'RELAY_CONFIG', 'RELAY_INPUT', 'RELAY_INPUT_TOO_LARGE', 'EMPTY_MODEL_RESPONSE']);
function safeError(error) { return SAFE_CODES.has(error?.code) ? error.code : 'VERDICT_ANALYSIS_FAILED'; }
module.exports = { safeError };
