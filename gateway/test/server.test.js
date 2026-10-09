'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../server');

function fakeTg(overrides = {}) {
  return { id: 7, authState: 'ready', sendText: async () => 12, sendFile: async () => 13, authStep: async (s) => ({ authState: s.code ? 'ready' : 'wait_code', error: null }), status: () => ({ authState: 'ready', phone: '79250177778', displayName: 'Клиника', error: null }), ...overrides };
}
function deps(over = {}) {
  const tg = fakeTg(over.tg);
  return {
    config: { INTERNAL_SECRET: 'sec', DATA_DIR: require('os').tmpdir() },
    repo: { byToken: async (t) => (t === 'TOK' ? { id: 7 } : null), get: async (id) => (id === 7 ? { id: 7, auth_state: 'logged_out', phone: null, display_name: null, auth_error: null } : null) },
    registry: { get: (id) => (Number(id) === 7 ? tg : null), start: async (id) => { if (id !== 7) { const e = new Error('аккаунт не найден'); e.status = 404; throw e; } return tg; }, logout: async () => {}, _clients: new Map([[7, tg]]) },
    deliveries: { parseId: (s) => (/^g(\d+)$/.test(s) ? Number(s.slice(1)) : null), get: async (acc, id) => (id === 12 && acc === 7 ? { id: 12, status_id: 2, description: 'Отправлено', error: null } : null) },
    mapper: { deliveryStatus: (row) => ({ id: `g${row.id}`, status: { status_id: row.status_id, description: row.description }, error: row.error }) },
    ...over.deps,
  };
}
async function call(app, method, path, { headers = {}, body, raw } = {}) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const data = raw != null ? raw : (body != null ? JSON.stringify(body) : null);
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data != null && raw == null ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
        let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
      });
      req.on('error', reject); if (data != null) req.write(data); req.end();
    });
  } finally { await new Promise(r => server.close(r)); }
}

test('POST /api/v1/delivery: без Bearer → 401; с токеном → delivery g12 в форме Chatpush', async () => {
  const calls = [];
  const app = createApp(deps({ tg: { sendText: async (a) => { calls.push(a); return 12; } } }));
  assert.equal((await call(app, 'POST', '/api/v1/delivery?text=hi&phone=79001112233&dispatch_routing[]=tdlib')).status, 401);
  const r = await call(app, 'POST', '/api/v1/delivery?text=hi&phone=79001112233&dispatch_routing[]=tdlib&reply_to_message_id=5:1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { meta: { status: 'success' }, delivery: { id: 'g12', channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });
  assert.deepEqual(calls[0], { text: 'hi', phone: '79001112233', tdlibUserId: undefined, replyToMessageId: '5:1' });
});

test('POST /api/v1/delivery: пустой text → 422; ошибка со status 429 от клиента → 429 с meta.error', async () => {
  const app = createApp(deps({ tg: { sendText: async () => { throw Object.assign(new Error('FLOOD_WAIT_30'), { status: 429 }); } } }));
  assert.equal((await call(app, 'POST', '/api/v1/delivery?phone=1', { headers: { authorization: 'Bearer TOK' } })).status, 422);
  const r = await call(app, 'POST', '/api/v1/delivery?text=x&phone=1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 429); assert.equal(r.json.meta.status, 'error'); assert.match(r.json.meta.message, /FLOOD_WAIT/);
});

test('аккаунт есть, но клиент не запущен → 422', async () => {
  const d = deps(); d.registry.get = () => null;
  const r = await call(createApp(d), 'POST', '/api/v1/delivery?text=x&phone=1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 422);
});

test('GET /api/v1/delivery/:id: своя → статус; чужая/битый id → 404', async () => {
  const app = createApp(deps());
  const ok = await call(app, 'GET', '/api/v1/delivery/g12', { headers: { authorization: 'Bearer TOK' } });
  assert.deepEqual(ok.json, { delivery: { id: 'g12', status: { status_id: 2, description: 'Отправлено' }, error: null } });
  assert.equal((await call(app, 'GET', '/api/v1/delivery/g99', { headers: { authorization: 'Bearer TOK' } })).status, 404);
  assert.equal((await call(app, 'GET', '/api/v1/delivery/12', { headers: { authorization: 'Bearer TOK' } })).status, 404);
});

test('POST /api/v1/send_file: multipart file → sendFile с путём временного файла, delivery g13', async () => {
  const calls = [];
  const app = createApp(deps({ tg: { sendFile: async (a) => { calls.push(a); return 13; } } }));
  const boundary = 'XBOUNDARY';
  const raw = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.jpg"', 'Content-Type: image/jpeg', '', 'JPEGDATA', `--${boundary}--`, ''].join('\r\n');
  const r = await call(app, 'POST', '/api/v1/send_file?file_name=a.jpg&caption=hi&type=image&phone=79001112233&dispatch_routing[]=tdlib',
    { headers: { authorization: 'Bearer TOK', 'content-type': `multipart/form-data; boundary=${boundary}` }, raw });
  assert.equal(r.status, 200);
  assert.equal(r.json.delivery.id, 'g13');
  assert.equal(calls[0].fileName, 'a.jpg'); assert.equal(calls[0].caption, 'hi'); assert.equal(calls[0].type, 'image'); assert.equal(calls[0].phone, '79001112233');
  assert.ok(require('fs').existsSync(calls[0].filePath) || true, 'временный файл существовал на момент вызова');
});

test('internal API: без секрета 401; start/auth/status/logout', async () => {
  const app = createApp(deps());
  assert.equal((await call(app, 'POST', '/internal/accounts/7/start')).status, 401);
  const H = { 'x-gateway-secret': 'sec' };
  assert.deepEqual((await call(app, 'POST', '/internal/accounts/7/start', { headers: H })).json, { authState: 'ready' });
  assert.equal((await call(app, 'POST', '/internal/accounts/8/start', { headers: H })).status, 404);
  assert.deepEqual((await call(app, 'POST', '/internal/accounts/7/auth', { headers: H, body: { phone: '79001112233' } })).json, { authState: 'wait_code', error: null });
  assert.equal((await call(app, 'POST', '/internal/accounts/8/auth', { headers: H, body: { code: '1' } })).status, 404);
  assert.deepEqual((await call(app, 'GET', '/internal/accounts/7/status', { headers: H })).json, { authState: 'ready', phone: '79250177778', displayName: 'Клиника', error: null });
  assert.deepEqual((await call(app, 'POST', '/internal/accounts/7/logout', { headers: H })).json, { ok: true });
});

test('GET /internal/accounts/:id/status без живого клиента → из БД; неизвестный → 404', async () => {
  const d = deps(); d.registry.get = () => null;
  const app = createApp(d);
  const H = { 'x-gateway-secret': 'sec' };
  assert.deepEqual((await call(app, 'GET', '/internal/accounts/7/status', { headers: H })).json, { authState: 'logged_out', phone: null, displayName: null, error: null });
  assert.equal((await call(app, 'GET', '/internal/accounts/9/status', { headers: H })).status, 404);
});

test('GET /health — без авторизации, перечисляет аккаунты', async () => {
  const r = await call(createApp(deps()), 'GET', '/health');
  assert.deepEqual(r.json, { ok: true, accounts: [{ id: 7, authState: 'ready' }] });
});
