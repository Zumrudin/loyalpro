'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

function fakeTg(overrides = {}) {
  return { id: 7, authState: 'ready', sendText: async () => 12, sendFile: async () => 13, authStep: async (s) => ({ authState: s.code ? 'ready' : 'wait_code', error: null }), status: () => ({ authState: 'ready', phone: '79250177778', displayName: 'Клиника', error: null }), ...overrides };
}
function deps(over = {}) {
  const tg = fakeTg(over.tg);
  return {
    config: { INTERNAL_SECRET: 'sec', DATA_DIR: require('os').tmpdir(), ...(over.config || {}) },
    repo: { byToken: async (t) => (t === 'TOK' ? { id: 7 } : null), get: async (id) => (id === 7 ? { id: 7, auth_state: 'logged_out', phone: null, display_name: null, auth_error: null } : null) },
    registry: { get: (id) => (Number(id) === 7 ? tg : null), start: async (id) => { if (id !== 7) { const e = new Error('аккаунт не найден'); e.status = 404; throw e; } return tg; }, logout: async () => {}, list: () => [{ id: tg.id, authState: tg.authState }] },
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
  const app = createApp(fileDeps(calls));
  const boundary = 'XBOUNDARY';
  const raw = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.jpg"', 'Content-Type: image/jpeg', '', 'JPEGDATA', `--${boundary}--`, ''].join('\r\n');
  const r = await call(app, 'POST', '/api/v1/send_file?file_name=a.jpg&caption=hi&type=image&phone=79001112233&dispatch_routing[]=tdlib',
    { headers: { authorization: 'Bearer TOK', 'content-type': `multipart/form-data; boundary=${boundary}` }, raw });
  assert.equal(r.status, 200);
  assert.equal(r.json.delivery.id, 'g13');
  assert.equal(calls[0].fileName, 'a.jpg'); assert.equal(calls[0].caption, 'hi'); assert.equal(calls[0].type, 'image'); assert.equal(calls[0].phone, '79001112233');
  assert.equal(path.basename(calls[0].filePath), 'a.jpg', 'имя документа доходит до Telegram');
  assert.match(calls[0].filePath, /[\\/]tmp[\\/][0-9a-f]{16}[\\/]a\.jpg$/);
  assert.equal(calls[0].exists, true, 'временный файл существовал на момент вызова');
});

function multipart(name, mime, data) {
  const boundary = 'XBOUNDARY';
  return { boundary, raw: [`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${name}"`, `Content-Type: ${mime}`, '', data, `--${boundary}--`, ''].join('\r\n') };
}
function fileDeps(calls, config) {
  return deps({ config, tg: { sendFile: async (a) => { calls.push({ ...a, exists: fs.existsSync(a.filePath) }); return 13; } } });
}

test('send_file: file_name с обходом пути остаётся внутри tmp; чужое расширение → +расширение по MIME; без расширения — тоже', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-srv-'));
  const calls = [];
  const app = createApp(fileDeps(calls, { DATA_DIR: dataDir }));
  const H = (b) => ({ authorization: 'Bearer TOK', 'content-type': `multipart/form-data; boundary=${b}` });
  for (const [fname, mime] of [['../../x', 'image/jpeg'], ['evil.html', 'image/jpeg'], ['price', 'application/pdf']]) {
    const m = multipart('a.bin', mime, 'DATA');
    const r = await call(app, 'POST', `/api/v1/send_file?file_name=${encodeURIComponent(fname)}&type=document&phone=1`, { headers: H(m.boundary), raw: m.raw });
    assert.equal(r.status, 200);
  }
  const tmpRoot = path.join(dataDir, 'tmp') + path.sep;
  for (const c of calls) {
    assert.ok(path.resolve(c.filePath).startsWith(tmpRoot), c.filePath);
    assert.ok(!path.basename(c.filePath).includes('..'), c.filePath);
  }
  // Своё расширение сохраняется (файл идёт в Telegram, не в наш публичный каталог).
  assert.equal(path.basename(calls[1].filePath), 'evil.html');
  assert.equal(path.basename(calls[2].filePath), 'price.pdf');
});

test('safeFileName: pptx/zip без .bin, длинное имя режется по стему, пустое/точки → file.<ext по MIME>', () => {
  const { safeFileName } = require('../server');
  assert.equal(safeFileName('deck.pptx', 'application/octet-stream'), 'deck.pptx');
  assert.equal(safeFileName('archive.zip', 'application/zip'), 'archive.zip');
  assert.equal(safeFileName('x'.repeat(150) + '.pdf', 'application/octet-stream'), 'x'.repeat(100) + '.pdf');
  assert.equal(safeFileName('', 'application/pdf'), 'file.pdf');
  assert.equal(safeFileName('..', 'image/jpeg'), 'file.jpg');
  assert.equal(safeFileName('.htaccess', 'text/plain'), 'htaccess.txt');
  assert.equal(safeFileName('../../etc/passwd', 'text/plain'), '_._etc_passwd.txt');
  assert.equal(safeFileName('Прайс 2026.pdf', 'application/pdf'), 'Прайс 2026.pdf');
});

test('send_file: файл больше лимита → 413; без файла → 422', async () => {
  const calls = [];
  const app = createApp(fileDeps(calls, { UPLOAD_LIMIT_BYTES: 100 }));
  const m = multipart('a.jpg', 'image/jpeg', 'X'.repeat(500));
  const r = await call(app, 'POST', '/api/v1/send_file?file_name=a.jpg&phone=1', { headers: { authorization: 'Bearer TOK', 'content-type': `multipart/form-data; boundary=${m.boundary}` }, raw: m.raw });
  assert.equal(r.status, 413); assert.equal(r.json.meta.status, 'error');
  const r2 = await call(app, 'POST', '/api/v1/send_file?file_name=a.jpg&phone=1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r2.status, 422);
  assert.equal(calls.length, 0);
});

test('сбой БД при проверке токена → 503, а не 401', async () => {
  const d = deps(); d.repo.byToken = async () => { throw new Error('ECONNREFUSED'); };
  const r = await call(createApp(d), 'POST', '/api/v1/delivery?text=x&phone=1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 503); assert.equal(r.json.meta.status, 'error');
});

test('статус доставки читается и без живого клиента', async () => {
  const d = deps(); d.registry.get = () => null;
  const r = await call(createApp(d), 'GET', '/api/v1/delivery/g12', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 200); assert.equal(r.json.delivery.id, 'g12');
});

test('POST /api/v1/delivery: text из JSON-тела, когда в query его нет; объект в query игнорируется', async () => {
  const calls = [];
  const app = createApp(deps({ tg: { sendText: async (a) => { calls.push(a); return 12; } } }));
  const r = await call(app, 'POST', '/api/v1/delivery', { headers: { authorization: 'Bearer TOK' }, body: { text: 'из тела', phone: '1' } });
  assert.equal(r.status, 200);
  assert.equal(calls[0].text, 'из тела'); assert.equal(calls[0].phone, '1');
  const r2 = await call(app, 'POST', '/api/v1/delivery?text[a]=b&phone=1', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r2.status, 422);
});

test('sweepTmp: удаляет старые файлы и каталоги, свежие оставляет', () => {
  const { sweepTmp } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-sweep-'));
  const oldDir = path.join(dir, 'aaaa'); fs.mkdirSync(oldDir); fs.writeFileSync(path.join(oldDir, 'x.jpg'), '1');
  const fresh = path.join(dir, 'fresh.jpg'); fs.writeFileSync(fresh, '1');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(oldDir, 'x.jpg'), past, past); fs.utimesSync(oldDir, past, past);
  sweepTmp(dir, 60);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(fresh), true);
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
