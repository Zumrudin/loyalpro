'use strict';
const { createProvider, parseResponse, childEnv, runProcess } = require('./services/agent/providers/codex');

const tool = { name: 'get_test_hours', input_schema: { type: 'object', properties: {}, additionalProperties: false } };
const request = { system: 'Test instructions', messages: [{ role: 'user', content: 'Synthetic prompt' }], tools: [tool] };
const dev = { NODE_ENV: 'development', MILA_CODEX_PROTOTYPE: 'true', PATH: process.env.PATH, HOME: process.env.HOME };
const output = data => [
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(data) } },
  { type: 'turn.completed', usage: {} },
].map(x => JSON.stringify(x)).join('\n');
const answer = { text: 'Тестовый ответ', toolCalls: [] };
const makeRun = (data = answer) => jest.fn(async (_bin, args) => args[0] === 'login'
  ? { stdout: '', stderr: 'Logged in using ChatGPT' } : { stdout: output(data), stderr: '' });

test.each(['production', 'test', undefined])('blocks NODE_ENV=%s before spawning', async nodeEnv => {
  const run = makeRun();
  await expect(createProvider({ env: { ...dev, NODE_ENV: nodeEnv }, run }).createMessage(request))
    .rejects.toMatchObject({ code: 'CODEX_DEV_ONLY' });
  expect(run).not.toHaveBeenCalled();
});

test('requires explicit opt-in', async () => {
  await expect(createProvider({ env: { NODE_ENV: 'development' } }).createMessage(request))
    .rejects.toMatchObject({ code: 'CODEX_DEV_ONLY' });
});

test('deployed dev stand can preserve production server defaults with test DB and both flags', async () => {
  const run = makeRun();
  await expect(createProvider({ env: { ...dev, NODE_ENV: 'production',
    MILA_CODEX_DEV_STAND: 'true', DATABASE_URL: 'postgresql://localhost/loyalpro_test' }, run })
    .createMessage(request)).resolves.toMatchObject({ text: answer.text });
});

test.each(['postgresql://localhost/loyalpro', 'invalid', undefined])
('dev-stand flag cannot enable Codex on a non-test database (%s)', async database => {
  const run = makeRun();
  await expect(createProvider({ env: { ...dev, NODE_ENV: 'production',
    MILA_CODEX_DEV_STAND: 'true', DATABASE_URL: database }, run }).createMessage(request))
    .rejects.toMatchObject({ code: 'CODEX_DEV_ONLY' });
  expect(run).not.toHaveBeenCalled();
});

test('test DB and stand flag still require prototype opt-in', async () => {
  const run = makeRun();
  await expect(createProvider({ env: { ...dev, NODE_ENV: 'production', MILA_CODEX_PROTOTYPE: 'false',
    MILA_CODEX_DEV_STAND: 'true', DATABASE_URL: 'postgresql://localhost/loyalpro_test' }, run })
    .createMessage(request)).rejects.toMatchObject({ code: 'CODEX_DEV_ONLY' });
  expect(run).not.toHaveBeenCalled();
});

test('subscription only; API-key auth rejected before generation', async () => {
  const run = jest.fn(async () => ({ stdout: '', stderr: 'Logged in using an API key' }));
  await expect(createProvider({ env: dev, run }).createMessage(request))
    .rejects.toMatchObject({ code: 'CODEX_CHATGPT_LOGIN_REQUIRED' });
  expect(run).toHaveBeenCalledTimes(1);
});

test('isolates config, sends input through stdin, preserves provider contract', async () => {
  const run = makeRun();
  const p = createProvider({ env: { ...dev, MILA_CODEX_MODEL: 'another-model', OPENAI_API_KEY: 'synthetic-secret', DATABASE_URL: 'synthetic-secret' }, run });
  const result = await p.createMessage(request);
  expect(result).toMatchObject({ text: answer.text, toolCalls: [], stopReason: 'stop',
    assistantMsg: { role: 'assistant', content: answer.text } });
  const [, args, options] = run.mock.calls[1];
  expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-6-sol']);
  expect(args).not.toContain('another-model');
  expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', 'read-only', 'forced_login_method="chatgpt"']));
  expect(args.join(' ')).not.toContain('Synthetic prompt');
  expect(options.input).toBe(JSON.stringify(request));
  expect(options.env.OPENAI_API_KEY).toBeUndefined();
  expect(options.env.DATABASE_URL).toBeUndefined();
  expect(options.cwd).not.toContain('/loyalpro');
});

test('normalizes requested tools and replays results with matching IDs', () => {
  const result = parseResponse(output({ text: '', toolCalls: [{ name: tool.name, arguments: '{}' }] }), [tool]);
  expect(result.toolCalls[0]).toMatchObject({ name: tool.name, input: {} });
  expect(result.assistantMsg.tool_calls[0].id).toBe(result.toolCalls[0].id);
  expect(createProvider().toolResultMessages([{ id: result.toolCalls[0].id, result: { opens: '10:30' } }]))
    .toEqual([{ role: 'tool', tool_call_id: result.toolCalls[0].id, content: '{"opens":"10:30"}' }]);
});

test.each([
  { text: '', toolCalls: [{ name: 'unknown', arguments: '{}' }] },
  { text: '', toolCalls: [{ name: tool.name, arguments: '{invalid' }] },
  { text: '', toolCalls: [{ name: tool.name, arguments: '[]' }] },
  { text: '', toolCalls: [{ name: tool.name, arguments: '{"salon_id":2}' }] },
  { text: '', toolCalls: [] },
])('rejects malformed/unknown actions without exposing output %#', data => {
  expect(() => parseResponse(output(data), [tool])).toThrow('CODEX_INVALID_RESPONSE');
});

test('rejects missing required tool fields and tools in text-only mode', () => {
  const data = output({ text: '', toolCalls: [{ name: tool.name, arguments: '{}' }] });
  expect(() => parseResponse(data, [])).toThrow('CODEX_INVALID_RESPONSE');
  expect(() => parseResponse(data, [{ ...tool, input_schema: { required: ['date'] } }]))
    .toThrow('CODEX_INVALID_RESPONSE');
});

test('rejects truncated streams and native tools', () => {
  expect(() => parseResponse('{"type":"turn.failed"}', [])).toThrow('CODEX_INVALID_RESPONSE');
  const native = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } });
  expect(() => parseResponse(native + '\n' + output(answer), [])).toThrow('CODEX_INVALID_RESPONSE');
  expect(() => parseResponse(output(answer).split('\n')[0], [])).toThrow('CODEX_INVALID_RESPONSE');
});

test('accepts CLI startup warnings but rejects in-turn error items', () => {
  const warning = JSON.stringify({ type: 'item.completed', item: { type: 'error',
    message: 'Code Mode is unavailable because code-mode host is disabled.' } });
  expect(parseResponse(warning + '\n' + output(answer), []).text).toBe(answer.text);
  expect(() => parseResponse('{"type":"turn.started"}\n' + warning + '\n' + output(answer), []))
    .toThrow('CODEX_INVALID_RESPONSE');
  expect(() => parseResponse('{"type":"item.completed","item":{"type":"error","message":"unknown"}}\n' + output(answer), []))
    .toThrow('CODEX_INVALID_RESPONSE');
});

test.each(['0', 'NaN', '180001'])('rejects invalid timeout %s', timeout => {
  return expect(createProvider({ env: { ...dev, MILA_CODEX_TIMEOUT_MS: timeout } }).createMessage(request))
    .rejects.toMatchObject({ code: 'CODEX_INVALID_TIMEOUT' });
});

test('rejects oversized input without starting CLI', async () => {
  const run = makeRun();
  await expect(createProvider({ env: dev, run }).createMessage({ ...request, system: 'x'.repeat(2 * 1024 * 1024) }))
    .rejects.toMatchObject({ code: 'CODEX_INPUT_TOO_LARGE' });
  expect(run).not.toHaveBeenCalled();
});

test('serializes calls; releases capacity after failures', async () => {
  let release;
  const run = jest.fn(() => new Promise(resolve => { release = resolve; }));
  const p = createProvider({ env: dev, run });
  const first = p.createMessage(request);
  await expect(p.createMessage(request)).rejects.toMatchObject({ code: 'CODEX_BUSY' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ stdout: 'Not logged in', stderr: '' });
  await expect(first).rejects.toMatchObject({ code: 'CODEX_CHATGPT_LOGIN_REQUIRED' });
  run.mockImplementation(makeRun());
  await expect(p.createMessage(request)).resolves.toMatchObject({ text: answer.text });
});

test('does not forward external authentication, backend secrets or process injection', () => {
  expect(childEnv({ PATH: '/bin', HOME: '/test', OPENAI_API_KEY: 'fake', CODEX_API_KEY: 'fake',
    CODEX_ACCESS_TOKEN: 'fake', NODE_OPTIONS: '--require fake', CHATPUSH_INSTANCE_TOKEN: 'fake' }))
    .toEqual({ PATH: '/bin', HOME: '/test' });
});

test('process deadline terminates a stalled child with a sanitized error', async () => {
  await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { cwd: '/tmp', env: childEnv(process.env), timeoutMs: 50 }))
    .rejects.toMatchObject({ code: 'CODEX_TIMEOUT' });
});

test('child failures never expose stderr', async () => {
  await expect(runProcess(process.execPath, ['-e', 'console.error("synthetic-private");process.exit(1)'],
    { cwd: '/tmp', env: childEnv(process.env), timeoutMs: 1000 }))
    .rejects.toThrow('Codex prototype: CODEX_PROCESS_FAILED');
});
