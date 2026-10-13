'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const media = require('../lib/max/media');

test('download: GET с Origin/UA, кап по maxContentLength, MIME из заголовка; не-200 и пустое тело → ошибка', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: Buffer.from('WEBP'), headers: { 'content-type': 'image/webp; charset=binary' } }; };
  const r = await media.download('https://i/1', { http, maxBytes: 100, timeoutMs: 5 });
  assert.equal(r.buf.toString(), 'WEBP'); assert.equal(r.mimeType, 'image/webp');
  assert.equal(calls[0].method, 'get'); assert.equal(calls[0].maxContentLength, 100); assert.equal(calls[0].timeout, 5);
  assert.equal(calls[0].headers.Origin, 'https://web.max.ru'); assert.equal(calls[0].responseType, 'arraybuffer');
  await assert.rejects(media.download('u', { http: async () => ({ status: 404, data: Buffer.alloc(0), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /HTTP 404/);
  await assert.rejects(media.download('u', { http: async () => ({ status: 200, data: Buffer.alloc(0), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /пустой/);
  await assert.rejects(media.download('u', { http: async () => ({ status: 200, data: Buffer.alloc(101), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /больше лимита/);
});

test('uploadPhoto: multipart поле file → токен первого фото; без токена → ошибка', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: { photos: { 123: { token: 'PT' } } } }; };
  assert.equal(await media.uploadPhoto('https://iu/upload', Buffer.from('JPG'), 'a.jpg', 'image/jpeg', { http }), 'PT');
  assert.equal(calls[0].method, 'post'); assert.ok(calls[0].data instanceof FormData);
  const file = calls[0].data.get('file'); assert.equal(file.name, 'a.jpg'); assert.equal(file.type, 'image/jpeg');
  await assert.rejects(media.uploadPhoto('u', Buffer.from('x'), 'a.jpg', 'image/jpeg', { http: async () => ({ status: 200, data: { photos: {} } }) }), /нет токена/);
  await assert.rejects(media.uploadPhoto('u', Buffer.from('x'), 'a.jpg', 'image/jpeg', { http: async () => ({ status: 500, data: '' }) }), /HTTP 500/);
});

test('uploadFile: сырые байты, content-disposition (кириллица percent-encoded), content-range 0-(n-1)/n', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: '' }; };
  await media.uploadFile('https://fu/upload', Buffer.from('12345'), 'Прайс.pdf', { http });
  const h = calls[0].headers;
  assert.equal(h['content-range'], '0-4/5');
  assert.equal(h['content-disposition'], 'attachment; filename=' + encodeURIComponent('Прайс.pdf'));
  assert.equal(h['content-type'], 'application/octet-stream');
  assert.equal(media.contentDisposition('a.pdf'), 'attachment; filename=a.pdf');
  await assert.rejects(media.uploadFile('u', Buffer.from('x'), 'a', { http: async () => ({ status: 413, data: '' }) }), /HTTP 413/);
});
