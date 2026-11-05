'use strict';

// Development prototype only. Each request gets a fresh ephemeral CLI session;
// application tool execution remains in Mila's orchestrator, never in Codex.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
const MODEL = 'gpt-6-astra';
// Reserve engine of the bridge when Astra itself fails (prod chain gpt → sol).
const SOL_MODEL = 'gpt-5.6-sol';
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin',
  'browser_use', 'computer_use', 'image_generation', 'view_image', 'hooks',
  'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host', 'memories',
  'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'sleep_tool',
];

function failure(code, detail) {
  // Never expose CLI stderr, model output, prompts, tokens, or account identity
  // in the message: it may travel to the caller. `detail` is for the bridge's
  // local journal only (why the run failed), already cut by diagText.
  const e = new Error(`Codex prototype: ${code}`);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

// Diagnostic text for the local journal: API/CLI error messages, never prompts.
// Long digit runs (phones) are masked, whitespace collapsed, length capped.
function diagText(value, max = 300) {
  const text = String(value ?? '').replace(/\d{7,}/g, '#').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}
// Model-supplied identifiers in diagnostics (tool/argument names).
const diagName = value => String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || '?';

// Last API-level error the CLI reported in its JSON event stream.
function lastApiError(stdout) {
  let found = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"error"') && !line.includes('turn.failed')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'error') found = event.message;
      else if (event.type === 'turn.failed') found = event.error?.message || 'turn.failed';
    } catch (_) { /* not an event line */ }
  }
  return found === null ? null : diagText(found);
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
      if (!error) error = failure(code, code === 'CODEX_TIMEOUT' ? { timeoutMs } : undefined);
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { proc.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('CODEX_TIMEOUT'), timeoutMs);
    proc.on('error', e => { error = failure('CODEX_UNAVAILABLE', { errno: diagName(e?.code) }); });
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
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (error) return reject(error);
      if (code !== 0) {
        return reject(failure('CODEX_PROCESS_FAILED', { exit: code, signal: signal || null,
          apiError: lastApiError(stdout), stderr: diagText(stderr.slice(-2000)) || null }));
      }
      resolve({ stdout, stderr });
    });
    proc.stdin.end(input);
  });
}

function parseResponse(stdout, tools) {
  let last, completed = false, started = false;
  // Each rejection names its reason for the bridge journal; the thrown error
  // still carries only the code, and the reason holds no prompt or output text.
  const reject = reason => { throw Object.assign(new Error('rejected'), { reason }); };
  try {
    for (const line of stdout.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch (_) { reject('event_not_json'); }
      if (event.type === 'turn.failed') reject('turn_failed: ' + diagText(event.error?.message || '-'));
      if (event.type === 'error') reject('error_event: ' + diagText(event.message || '-'));
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
        if (!['agent_message', 'reasoning'].includes(event.item?.type)) {
          reject('item:' + diagName(event.item?.type)
            + (event.item?.type === 'error' ? ' ' + diagText(event.item.message, 200) : ''));
        }
      }
    }
    if (!completed) reject('not_completed');
    if (typeof last !== 'string') reject('no_agent_message');
    let data;
    try { data = JSON.parse(last); } catch (_) { reject('output_not_json'); }
    if (typeof data?.text !== 'string' || !Array.isArray(data.toolCalls)) reject('output_shape');
    if (data.toolCalls.length > 8) reject('too_many_tool_calls:' + data.toolCalls.length);
    const allowed = new Map(tools.map(t => [t.name, t.input_schema]));
    const toolCalls = data.toolCalls.map(tc => {
      const name = diagName(tc?.name);
      if (!allowed.has(tc?.name)) reject('unknown_tool:' + name);
      if (typeof tc.arguments !== 'string') reject('args_not_string:' + name);
      let input;
      try { input = JSON.parse(tc.arguments); } catch (_) { reject('args_not_json:' + name); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) reject('args_not_object:' + name);
      const schema = allowed.get(tc.name) || {};
      // Match required fields and reject invented parameters (including tenant
      // selectors). Existing handlers retain domain validation and authorization.
      const missing = (schema.required || []).find(k => !Object.hasOwn(input, k));
      if (missing !== undefined) reject(`missing_required:${name}.${diagName(missing)}`);
      const extra = Object.keys(input).find(k => !Object.hasOwn(schema.properties || {}, k));
      if (extra !== undefined) reject(`extra_arg:${name}.${diagName(extra)}`);
      return { id: `codex_${randomUUID()}`, name: tc.name, input };
    });
    const text = data.text.trim();
    if (!text && !toolCalls.length) reject('empty');
    const assistantMsg = { role: 'assistant', content: text || null };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls.map(tc => ({
      id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
    return { text, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : 'stop', assistantMsg };
  } catch (e) {
    throw failure('CODEX_INVALID_RESPONSE', { reason: e.reason || 'unexpected' });
  }
}

// `model` is fixed by the bridge code per engine, never taken from a request.
function createProvider({ env = process.env, run = runProcess, model = MODEL } = {}) {
  if (![MODEL, SOL_MODEL].includes(model)) throw failure('CODEX_CONFIG');
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
      const timeoutMs = Number(env.MILA_CODEX_TIMEOUT_MS || 90000);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
        throw failure('CODEX_INVALID_TIMEOUT');
      }
      const input = JSON.stringify({ system, messages, tools });
      if (Buffer.byteLength(input) > MAX_BYTES) throw failure('CODEX_INPUT_TOO_LARGE');
      // Empty cwd outside the application tree: no project config/instructions.
      // It contains no prompts, outputs, or credentials and is not shared by
      // simultaneous sessions. The bridge owns concurrency and queue limits.
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mila-codex-'));
      const binary = env.MILA_CODEX_BIN || 'codex';
      const options = { cwd, env: childEnv(env), timeoutMs: 10000 };
      let auth;
      try { auth = await run(binary, ['login', 'status'], options); }
      catch (e) { e.detail = { stage: 'login', ...e.detail }; throw e; }
      if (!/Logged in using ChatGPT/.test(auth.stdout + auth.stderr)) {
        throw failure('CODEX_CHATGPT_LOGIN_REQUIRED', { stage: 'login',
          output: diagText(auth.stdout + ' ' + auth.stderr, 200) });
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
      args.push('--model', model);
      args.push('-');
      let result;
      try { result = await run(binary, args, { ...options, input, timeoutMs }); }
      catch (e) { e.detail = { stage: 'exec', model, ...e.detail }; throw e; }
      try { return parseResponse(result.stdout, tools); }
      catch (e) { e.detail = { stage: 'parse', model, ...e.detail }; throw e; }
    },
    toolResultMessages(results) {
      return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }));
    },
  };
}

module.exports = { ...createProvider(), MODEL, SOL_MODEL, createProvider, parseResponse, childEnv, runProcess, diagText };
