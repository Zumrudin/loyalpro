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
