'use strict';
const { randomUUID } = require('node:crypto');
const { createBridge } = require('./services/codex-bridge');
const { createProvider } = require('./services/agent/providers/codex-relay');
const { signature, ROUTE, MAX_BYTES, authorized } = require('./services/agent/providers/codex-relay-protocol');

const secret = 'synthetic-test-secret-'.repeat(3);
const input = { system: 'Synthetic instructions', messages: [{ role: 'user', content: 'Hello' }],
  tools: [{ name: 'get_hours', input_schema: { type: 'object', properties: {}, additionalProperties: false } }] };
let server, url, generate;
async function start(options = {}) {
  generate = jest.fn(async () => ({ text: 'Hello', toolCalls: [] }));
  server = createBridge({ secret, generate, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}${ROUTE}`;
}
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
function provider(options = {}) {
  return createProvider({ env: { MILA_CODEX_RELAY_URL: url, MILA_CODEX_RELAY_SECRET: secret }, allowLoopback: true, ...options });
}
function signed(data = input, timestamp = String(Date.now()), id = randomUUID()) {
  const body = JSON.stringify(data);
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-mila-timestamp': timestamp,
    'x-mila-request-id': id, 'x-mila-signature': signature(secret, timestamp, id, body) }, body };
}
test('real HTTP preserves prompts/history and round-trips tool results without executing tools', async () => {
  await start();
  generate.mockResolvedValueOnce({ text: '', toolCalls: [{ name: 'get_hours', input: {} }] });
  const p = provider();
  const result = await p.createMessage(input);
  expect(result.toolCalls[0]).toMatchObject({ name: 'get_hours', input: {} });
  const next = { ...input, messages: [...input.messages, result.assistantMsg,
    ...p.toolResultMessages([{ id: result.toolCalls[0].id, result: { opens: '10:30' } }])] };
  await expect(p.createMessage(next)).resolves.toMatchObject({ text: 'Hello' });
  expect(generate.mock.calls[0][0]).toEqual(input);
  expect(generate.mock.calls[1][0]).toEqual(next);
});
test.each(['missing', 'wrong', 'expired', 'tampered'])('rejects %s authentication before generation', async kind => {
  await start(); const req = signed();
  if (kind === 'missing') delete req.headers['x-mila-signature'];
  if (kind === 'wrong') req.headers['x-mila-signature'] = '0'.repeat(64);
  if (kind === 'expired') Object.assign(req, signed(input, String(Date.now() - 120000)));
  if (kind === 'tampered') req.body = JSON.stringify({ ...input, system: 'changed' });
  const res = await fetch(url, req); expect(res.status).toBe(401); await res.text();
  expect(generate).not.toHaveBeenCalled();
});
test('rejects replay without generating twice', async () => {
  await start(); const req = signed();
  const one = await fetch(url, req); await one.text();
  const two = await fetch(url, req); expect(two.status).toBe(409); await two.text();
  expect(generate).toHaveBeenCalledTimes(1);
});
test('signed body cannot supply model, tenant, command or environment overrides', async () => {
  await start();
  for (const key of ['model', 'salon_id', 'command', 'env']) {
    const res = await fetch(url, signed({ ...input, [key]: 'untrusted' }));
    expect(res.status).toBe(400); await res.text();
  }
  expect(generate).not.toHaveBeenCalled();
});
test('caps authenticated request rate', async () => {
  await start({ maxPerMinute: 1 });
  await provider().createMessage(input);
  await expect(provider().createMessage(input)).rejects.toMatchObject({ code: 'RELAY_BUSY' });
  expect(generate).toHaveBeenCalledTimes(1);
});
test('caps concurrency and queue, releases capacity after failure', async () => {
  await start({ concurrency: 1, maxQueue: 1, queueMs: 30 });
  let release; generate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = provider().createMessage(input);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = provider().createMessage(input).catch(e => e.code);
  await expect(provider().createMessage(input)).rejects.toMatchObject({ code: 'RELAY_BUSY' });
  expect(await second).toBe('RELAY_BUSY');
  release({ text: 'OK', toolCalls: [] }); await first;
  generate.mockRejectedValueOnce(new Error('private-token-and-prompt'));
  await expect(provider().createMessage(input)).rejects.toThrow('RELAY_MODEL_FAILED');
  await expect(provider().createMessage(input)).resolves.toMatchObject({ text: 'Hello' });
});
test('refuses plaintext URLs outside explicit local test mode', async () => {
  await start(); await expect(provider({ allowLoopback: false }).createMessage(input)).rejects.toMatchObject({ code: 'RELAY_CONFIG' });
  expect(generate).not.toHaveBeenCalled();
});
test('rejects oversize request before network', async () => {
  await start(); await expect(provider().createMessage({ ...input, system: 'x'.repeat(MAX_BYTES) }))
    .rejects.toMatchObject({ code: 'RELAY_INPUT_TOO_LARGE' });
  expect(generate).not.toHaveBeenCalled();
});
test('revalidates returned tools and never trusts bridge-provided tool arguments', async () => {
  await start(); generate.mockResolvedValue({ text: '', toolCalls: [{ name: 'get_hours', input: { salon_id: 42 } }] });
  await expect(provider().createMessage(input)).rejects.toMatchObject({ code: 'RELAY_MODEL_FAILED' });
});
test.each(['model', 'requestId'])('rejects mismatched response %s', async key => {
  await start();
  const fetchImpl = async (target, opts) => {
    const real = await fetch(target, opts); const data = await real.json(); data[key] = 'wrong';
    return new Response(JSON.stringify(data), { status: 200 });
  };
  await expect(provider({ fetchImpl }).createMessage(input)).rejects.toMatchObject({ code: 'RELAY_RESPONSE' });
});
test('does not retry or expose private network errors', async () => {
  await start(); const fetchImpl = jest.fn(async () => { throw new Error('private-token'); });
  await expect(provider({ fetchImpl }).createMessage(input)).rejects.toThrow('RELAY_FAILED');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('signature is tied to request id and payload', () => {
  const req = signed(); expect(authorized(secret, req.headers, req.body)).toBe(true);
  expect(authorized(secret, { ...req.headers, 'x-mila-request-id': randomUUID() }, req.body)).toBe(false);
});

test('signed Claude selector uses only Claude, returns normalized tools, leaves GPT untouched', async () => {
  const generateClaude = jest.fn(async () => ({ text: '', toolCalls: [{ name: 'get_hours', input: {} }] }));
  await start({ generateClaude });
  const p = provider({ engine: 'claude' });
  const result = await p.createMessage(input);
  expect(result).toMatchObject({ model: 'claude-sonnet', toolCalls: [{ name: 'get_hours', input: {} }] });
  expect(generateClaude).toHaveBeenCalledWith(input);
  expect(generate).not.toHaveBeenCalled();
});
test('unknown engine rejected before generation', async () => {
  await start(); const response = await fetch(url, signed({ ...input, engine: 'shell' }));
  expect(response.status).toBe(400); await response.text();
  expect(generate).not.toHaveBeenCalled();
});
test('proxy 502 is a bridge failure; bounded GENERATION_FAILED is a model failure', async () => {
  await start();
  await expect(provider({ fetchImpl: async () => new Response('<html>Bad gateway</html>', { status: 502 }) })
    .createMessage(input)).rejects.toMatchObject({ code: 'RELAY_UPSTREAM' });
});
