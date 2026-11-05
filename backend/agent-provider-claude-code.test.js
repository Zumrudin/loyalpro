'use strict';
const { createProvider } = require('./services/agent/providers/claude-code');
const request = { system: 'synthetic-system', messages: [{ role: 'user', content: 'synthetic-message' }],
  tools: [{ name: 'get_hours', input_schema: { type: 'object', properties: {} } }] };
function runner(output = { text: 'Hello', toolCalls: [] }) {
  return jest.fn(async (_, args) => args[0] === 'auth'
    ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }
    : { stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: output }) });
}
test('subscription CLI is isolated and receives conversation only via stdin', async () => {
  const run = runner();
  const p = createProvider({ run, env: { HOME: '/tmp', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'synthetic',
    DATABASE_URL: 'synthetic', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic', MILA_CLAUDE_BIN: '/usr/bin/claude' } });
  expect(await p.createMessage(request)).toMatchObject({ text: 'Hello', model: 'claude-sonnet' });
  const [binary, args, opts] = run.mock.calls[1];
  expect(binary).toBe('/usr/bin/claude');
  expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--no-session-persistence', '--strict-mcp-config', 'sonnet']));
  expect(args[args.indexOf('--tools') + 1]).toBe('');
  expect(args.join(' ')).not.toContain('synthetic-message');
  expect(JSON.parse(opts.input)).toEqual(request);
  expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(opts.env).not.toHaveProperty('DATABASE_URL');
  expect(opts.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  expect(opts.timeoutMs).toBe(90000);
});
test('API login is refused before generation', async () => {
  const run = jest.fn(async () => ({ stdout: '{"loggedIn":true,"authMethod":"api_key"}' }));
  await expect(createProvider({ run }).createMessage(request)).rejects.toThrow('CLAUDE_GENERATION_FAILED');
  expect(run).toHaveBeenCalledTimes(1);
});
test.each([
  { text: '', toolCalls: [] },
  { text: '', toolCalls: [{ name: 'shell', arguments: '{}' }] },
  { text: '', toolCalls: [{ name: 'get_hours', arguments: '{"salon_id":4}' }] },
])('invalid generation fails without exposing content', async output => {
  await expect(createProvider({ run: runner(output) }).createMessage(request)).rejects.toThrow('CLAUDE_GENERATION_FAILED');
});
test('CLI process errors are sanitized', async () => {
  const run = jest.fn(async () => { throw new Error('synthetic-private-stderr'); });
  await expect(createProvider({ run }).createMessage(request)).rejects.toThrow('CLAUDE_GENERATION_FAILED');
});
test('valid tool result reuses caller-side tool validation and IDs', async () => {
  const p = createProvider({ run: runner({ text: '', toolCalls: [{ name: 'get_hours', arguments: '{}' }] }) });
  expect(await p.createMessage(request)).toMatchObject({ toolCalls: [{ name: 'get_hours', input: {} }] });
});

// ── Диагностика для журнала моста (05.11.2026): одна общая ошибка наружу, детали — в detail ──
test('CLI error result (limit) is kept in detail, not in the message', async () => {
  const run = jest.fn(async (_, args) => args[0] === 'auth'
    ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) }
    : { stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1794317211' }) });
  const e = await createProvider({ run }).createMessage(request).catch(x => x);
  expect(e.message).toMatch(/CLAUDE_GENERATION_FAILED/);
  expect(e.message).not.toMatch(/limit/);
  expect(e.detail).toMatchObject({ stage: 'exec', cause: 'CLAUDE_GENERATION_FAILED', error: 'Claude AI usage limit reached|#' });
});
test('wrong login method is named in detail', async () => {
  const run = jest.fn(async () => ({ stdout: '{"loggedIn":false,"authMethod":"none"}' }));
  const e = await createProvider({ run }).createMessage(request).catch(x => x);
  expect(e.detail).toMatchObject({ stage: 'auth', cause: 'CLAUDE_SUBSCRIPTION_REQUIRED', auth: 'loggedIn=false method=none' });
});
test('successful model output never lands in detail on a parse failure', async () => {
  const e = await createProvider({ run: runner({ text: 'PRIVATE-ANSWER', toolCalls: [{ name: 'nope', arguments: '{}' }] }) })
    .createMessage(request).catch(x => x);
  expect(e.detail).toMatchObject({ stage: 'parse', reason: 'unknown_tool:nope' });
  expect(JSON.stringify(e.detail)).not.toMatch(/PRIVATE/);
});
