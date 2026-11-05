'use strict';

// Subscription-only, stateless LLM process. No CRM, MCP or native tool execution.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const codex = require('./codex');
const schema = require('./codex-response.schema.json');
const { CLAUDE_MODEL, MAX_BYTES, failure } = require('./codex-relay-protocol');

function createProvider({ env = process.env, run = codex.runProcess } = {}) {
  return {
    async createMessage({ system, messages, tools = [] }) {
      const input = JSON.stringify({ system, messages, tools });
      if (Buffer.byteLength(input) > MAX_BYTES) throw failure('CLAUDE_INPUT_TOO_LARGE');
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mila-claude-'));
      const clean = codex.childEnv(env);
      delete clean.CODEX_HOME;
      if (env.CLAUDE_CONFIG_DIR) clean.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
      clean.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      clean.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
      clean.CLAUDE_CODE_SAFE_MODE = '1';
      const binary = env.MILA_CLAUDE_BIN || 'claude';
      const options = { cwd, env: clean, timeoutMs: 10000 };
      // Stage + CLI error text go to the bridge journal only (e.detail); the
      // caller still sees one code. Model output is never copied into detail.
      let stage = 'auth';
      const note = {};
      try {
        const auth = JSON.parse((await run(binary, ['auth', 'status'], options)).stdout);
        if (!auth.loggedIn || auth.authMethod !== 'claude.ai') {
          note.auth = codex.diagText(`loggedIn=${auth.loggedIn} method=${auth.authMethod}`, 80);
          throw failure('CLAUDE_SUBSCRIPTION_REQUIRED');
        }
        stage = 'exec';
        const instructions = await fs.readFile(path.join(__dirname, 'codex-instructions.md'), 'utf8');
        const args = ['--print', '--safe-mode', '--model', 'sonnet',
          '--output-format', 'json', '--json-schema', JSON.stringify(schema),
          '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
          '--debug-file', '/dev/null',
          '--system-prompt', instructions];
        const raw = JSON.parse((await run(binary, args, { ...options, input, timeoutMs: 90000 })).stdout);
        if (raw.is_error || raw.subtype !== 'success') {
          // With is_error the CLI puts the API/limit message into result.
          note.subtype = codex.diagText(raw.subtype, 40);
          if (raw.is_error) note.error = codex.diagText(raw.result, 200);
          throw failure('CLAUDE_GENERATION_FAILED');
        }
        stage = 'parse';
        const output = raw.structured_output || JSON.parse(raw.result);
        const parsed = codex.parseResponse([
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } },
          { type: 'turn.completed' },
        ].map(e => JSON.stringify(e)).join('\n'), tools);
        return { ...parsed, model: CLAUDE_MODEL };
      } catch (e) {
        const out = failure('CLAUDE_GENERATION_FAILED');
        out.detail = { stage, cause: /^[A-Z][A-Z_]{2,40}$/.test(e?.code || '') ? e.code
          : (e instanceof SyntaxError ? 'BAD_JSON' : 'UNKNOWN'), ...note, ...e?.detail };
        throw out;
      }
    },
    toolResultMessages: codex.toolResultMessages,
  };
}
module.exports = { createProvider };
