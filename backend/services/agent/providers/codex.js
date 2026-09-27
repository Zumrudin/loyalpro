'use strict';

// Development prototype only. Each request gets a fresh ephemeral CLI session;
// application tool execution remains in Mila's orchestrator, never in Codex.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
const MODEL = 'gpt-6-sol';
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin',
  'browser_use', 'computer_use', 'image_generation', 'view_image', 'hooks',
  'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host', 'memories',
  'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'sleep_tool',
];

function failure(code) {
  // Never expose CLI stderr, model output, prompts, tokens, or account identity.
  const e = new Error(`Codex prototype: ${code}`);
  e.code = code;
  return e;
}

function childEnv(env) {
  const clean = {};
  // Keep the existing auth location; do not pass backend secrets or API keys.
  for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (env[key]) clean[key] = env[key];
  }
  return clean;
}

function runProcess(binary, args, { env, cwd, input = '', timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { cwd, env, shell: false, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, error;
    const stop = (code) => {
      if (!error) error = failure(code);
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { proc.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('CODEX_TIMEOUT'), timeoutMs);
    proc.on('error', () => { error = failure('CODEX_UNAVAILABLE'); });
    proc.stdin.on('error', () => stop('CODEX_STDIN_FAILED'));
    for (const [stream, kind] of [[proc.stdout, 'out'], [proc.stderr, 'err']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) return stop('CODEX_OUTPUT_TOO_LARGE');
        if (kind === 'out') stdout += chunk;
        else stderr += chunk;
      });
    }
    proc.on('close', code => {
      clearTimeout(timer);
      if (error) return reject(error);
      if (code !== 0) return reject(failure('CODEX_PROCESS_FAILED'));
      resolve({ stdout, stderr });
    });
    proc.stdin.end(input);
  });
}

function parseResponse(stdout, tools) {
  let last, completed = false, started = false;
  try {
    for (const line of stdout.split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error();
      if (event.type === 'turn.started') started = true;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        last = event.item.text;
      }
      // A native tool call is outside this adapter's contract, even if denied.
      if (event.type === 'item.started' || event.type === 'item.completed') {
        // 0.154.0 reports our deliberately disabled Code Mode host as a startup
        // error item. Accept only this known warning, never arbitrary errors.
        if (!started && event.type === 'item.completed' && event.item?.type === 'error'
            && event.item.message?.startsWith('Code Mode is unavailable because code-mode host is disabled.')) continue;
        if (!['agent_message', 'reasoning'].includes(event.item?.type)) throw new Error();
      }
    }
    if (!completed || typeof last !== 'string') throw new Error();
    const data = JSON.parse(last);
    if (typeof data.text !== 'string' || !Array.isArray(data.toolCalls)
        || data.toolCalls.length > 8) throw new Error();
    const allowed = new Map(tools.map(t => [t.name, t.input_schema]));
    const toolCalls = data.toolCalls.map(tc => {
      if (!allowed.has(tc.name) || typeof tc.arguments !== 'string') throw new Error();
      const input = JSON.parse(tc.arguments);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      const schema = allowed.get(tc.name) || {};
      // Match required fields and reject invented parameters (including tenant
      // selectors). Existing handlers retain domain validation and authorization.
      if ((schema.required || []).some(k => !Object.hasOwn(input, k))) throw new Error();
      if (Object.keys(input).some(k => !Object.hasOwn(schema.properties || {}, k))) throw new Error();
      return { id: `codex_${randomUUID()}`, name: tc.name, input };
    });
    const text = data.text.trim();
    if (!text && !toolCalls.length) throw new Error();
    const assistantMsg = { role: 'assistant', content: text || null };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls.map(tc => ({
      id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
    return { text, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : 'stop', assistantMsg };
  } catch (_) {
    throw failure('CODEX_INVALID_RESPONSE');
  }
}

function createProvider({ env = process.env, run = runProcess } = {}) {
  let busy = false;
  return {
    async createMessage({ system, messages, tools = [] }) {
      // The deployed dev server keeps NODE_ENV=production for Express security
      // defaults. Permit it only with explicit opt-in AND its test database.
      let devStand = false;
      if (env.MILA_CODEX_DEV_STAND === 'true') {
        try { devStand = new URL(env.DATABASE_URL).pathname === '/loyalpro_test'; }
        catch (_) { /* invalid/missing DB config must fail closed */ }
      }
      if ((env.NODE_ENV !== 'development' && !devStand) || env.MILA_CODEX_PROTOTYPE !== 'true') {
        throw failure('CODEX_DEV_ONLY');
      }
      if (busy) throw failure('CODEX_BUSY');
      const timeoutMs = Number(env.MILA_CODEX_TIMEOUT_MS || 90000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
        throw failure('CODEX_INVALID_TIMEOUT');
      }
      const input = JSON.stringify({ system, messages, tools });
      if (Buffer.byteLength(input) > MAX_BYTES) throw failure('CODEX_INPUT_TOO_LARGE');
      busy = true;
      try {
        // Empty cwd outside the application tree: no project config/instructions.
        // It contains no prompts, outputs, or credentials and is not shared by
        // simultaneous sessions. No process-global chdir or environment changes.
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mila-codex-'));
        const binary = env.MILA_CODEX_BIN || 'codex';
        const options = { cwd, env: childEnv(env), timeoutMs: 10000 };
        const auth = await run(binary, ['login', 'status'], options);
        if (!/Logged in using ChatGPT/.test(auth.stdout + auth.stderr)) {
          throw failure('CODEX_CHATGPT_LOGIN_REQUIRED');
        }
        const args = ['exec', '--ignore-user-config', '--ignore-rules',
          '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
          '--json', '--color', 'never', '--output-schema',
          path.join(__dirname, 'codex-response.schema.json'),
          '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
          '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
          '-c', 'model_instructions_file=' + JSON.stringify(path.join(__dirname, 'codex-instructions.md')),
        ];
        for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
        args.push('--model', MODEL);
        args.push('-');
        const result = await run(binary, args, { ...options, input, timeoutMs });
        return parseResponse(result.stdout, tools);
      } finally {
        busy = false;
      }
    },
    toolResultMessages(results) {
      return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }));
    },
  };
}

module.exports = { ...createProvider(), MODEL, createProvider, parseResponse, childEnv, runProcess };
