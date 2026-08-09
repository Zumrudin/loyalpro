'use strict';

// Поведенческие тесты POST /api/agent/price-photos: поднимаем настоящий Express-роутер
// в памяти (http.createServer) и бьём по нему настоящими multipart-запросами.
// services/agent-settings и middleware/auth замоканы — в БД не ходим.
//
// Ловит два бага, которые не мог поймать agent-price-photos-routes.test.js
// (тот читает исходник строкой):
//   1) путь выхода за пределы uploads/ через ycCategoryId/subcategoryId в имени файла;
//   2) ошибки multer (не-картинка, файл > 5 МБ), уходившие в голый 500 вместо 400.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = { salonId: 1, role: 'owner' }; next(); },
  requireRole: () => (req, res, next) => next(),
}));

const mockAddPricePhoto = jest.fn();
jest.mock('./services/agent-settings', () => ({
  addPricePhoto: (...args) => mockAddPricePhoto(...args),
  MAX_PRICE_PHOTOS_PER_NODE: 10,
}));

const router = require('./routes/agent-settings');
const uploadsDir = path.join(__dirname, '../frontend/uploads');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api/agent', router);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/agent`;
    done();
  });
});

afterAll((done) => { server.close(done); });

afterEach(() => { mockAddPricePhoto.mockReset(); });

function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

test('subcategoryId с обходом пути → 400, ни один файл не появляется НИ в uploads, НИ за его пределами', async () => {
  const before = new Set(readdirSafe(uploadsDir));
  const tmpBefore = new Set(readdirSafe(os.tmpdir()));
  const marker = `PRICEPHOTO_EVIL_${Date.now()}`;

  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-jpeg-bytes')], { type: 'image/jpeg' }), 'photo.jpg');
  fd.append('subcategoryId', `../../../../../../../../tmp/${marker}`);

  const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
  expect(resp.status).toBe(400);
  const body = await resp.json();
  expect(body.error).toBeTruthy();

  // addPricePhoto (БД) не должен был вызываться вовсе — отказ произошёл раньше записи.
  expect(mockAddPricePhoto).not.toHaveBeenCalled();

  const after = new Set(readdirSafe(uploadsDir));
  expect(after).toEqual(before);

  const tmpAfter = readdirSafe(os.tmpdir());
  expect(tmpAfter.some(f => f.includes(marker))).toBe(false);
  expect(new Set(tmpAfter)).toEqual(tmpBefore); // ничего лишнего не появилось и в /tmp
});

test('не-картинка → 400 с осмысленным error, а не голый 500', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notes.txt');
  fd.append('subcategoryId', '5');

  const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
  expect(resp.status).toBe(400);
  const body = await resp.json();
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  expect(mockAddPricePhoto).not.toHaveBeenCalled();
});

test('файл больше 5 МБ → 400, а не голый 500 (тот же multer-путь, что «не-картинка»)', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const fd = new FormData();
  fd.append('file', new Blob([big], { type: 'image/jpeg' }), 'huge.jpg');
  fd.append('subcategoryId', '5');

  const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
  expect(resp.status).toBe(400);
  const body = await resp.json();
  expect(typeof body.error).toBe('string');
  expect(mockAddPricePhoto).not.toHaveBeenCalled();
});

test('счастливый путь остаётся рабочим: файл пишется в uploads, БД получает валидированные числа', async () => {
  mockAddPricePhoto.mockResolvedValue({ id: 42 });
  const before = new Set(readdirSafe(uploadsDir));
  let createdFile = null;

  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('fake-jpeg-bytes')], { type: 'image/jpeg' }), 'photo.jpg');
    fd.append('subcategoryId', '7');

    const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.id).toBe(42);
    expect(body.fileUrl).toMatch(/^\/uploads\/pricelist_1_s7_\d+\.jpg$/);

    createdFile = path.join(uploadsDir, path.basename(body.fileUrl));
    expect(fs.existsSync(createdFile)).toBe(true);

    expect(mockAddPricePhoto).toHaveBeenCalledTimes(1);
    const arg = mockAddPricePhoto.mock.calls[0][1];
    expect(arg.ycCategoryId).toBeNull();
    expect(arg.subcategoryId).toBe(7); // Number, не строка
  } finally {
    if (createdFile) fs.rmSync(createdFile, { force: true });
  }

  const after = new Set(readdirSafe(uploadsDir));
  expect(after).toEqual(before); // подчистили за собой — каталог не засорён
});
