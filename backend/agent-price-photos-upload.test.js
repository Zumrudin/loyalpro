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
const mockRemovePricePhoto = jest.fn();
const mockReorderPricePhotos = jest.fn();
jest.mock('./services/agent-settings', () => ({
  addPricePhoto: (...args) => mockAddPricePhoto(...args),
  removePricePhoto: (...args) => mockRemovePricePhoto(...args),
  reorderPricePhotos: (...args) => mockReorderPricePhotos(...args),
  MAX_PRICE_PHOTOS_PER_NODE: 10,
}));

// Сброс TTL-кэша индекса (price-list-data.js) мокаем отдельно: все ТРИ
// мутирующие ручки (POST/PUT reorder/DELETE) обязаны его звать — без мока
// это было бы видно только грепом исходника, который не ловит пропажу вызова.
const mockInvalidate = jest.fn();
jest.mock('./services/agent/price-list-data', () => ({
  invalidate: (...args) => mockInvalidate(...args),
}));

const router = require('./routes/agent-settings');
const uploadsDir = path.join(__dirname, '../frontend/uploads');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', router);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/agent`;
    done();
  });
});

afterAll((done) => { server.close(done); });

afterEach(() => {
  mockAddPricePhoto.mockReset();
  mockRemovePricePhoto.mockReset();
  mockReorderPricePhotos.mockReset();
  mockInvalidate.mockReset();
});

// Удаление файла (safeUnlink) идёт через fs.unlink асинхронным колбэком и не
// await'ится обработчиком маршрута — ответ 200 может прийти РАНЬШЕ, чем файл
// реально исчезнет с диска. Ждём с коротким поллингом вместо гонки на существование.
async function waitUntilGone(filePath, timeoutMs = 1000) {
  const start = Date.now();
  while (fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Настоящая сигнатура JPEG: маршрут проверяет содержимое, а не только
// заголовок Content-Type, который клиент пишет какой захочет.
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 7)]);

test('subcategoryId с обходом пути → 400, ни один файл не появляется НИ в uploads, НИ за его пределами', async () => {
  const before = new Set(readdirSafe(uploadsDir));
  const tmpBefore = new Set(readdirSafe(os.tmpdir()));
  const marker = `PRICEPHOTO_EVIL_${Date.now()}`;

  const fd = new FormData();
  fd.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'photo.jpg');
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

test('картинка только по заголовку (внутри не картинка) → 400, на диск не пишется', async () => {
  const before = new Set(readdirSafe(uploadsDir));
  const fd = new FormData();
  // Клиент волен написать любой Content-Type и любое расширение — на слово не верим.
  fd.append('file', new Blob([Buffer.from('<html><script>alert(1)</script>')], { type: 'image/jpeg' }), 'photo.jpg');
  fd.append('subcategoryId', '5');

  const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
  expect(resp.status).toBe(400);
  expect((await resp.json()).error).toBeTruthy();
  expect(mockAddPricePhoto).not.toHaveBeenCalled();
  expect(new Set(readdirSafe(uploadsDir))).toEqual(before);
});

test('файл больше 5 МБ → 400, а не голый 500 (тот же multer-путь, что «не-картинка»)', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 1);
  const fd = new FormData();
  fd.append('file', new Blob([big], { type: 'image/jpeg' }), 'huge.jpg');
  fd.append('subcategoryId', '5');

  const resp = await fetch(`${baseUrl}/price-photos`, { method: 'POST', body: fd });
  expect(resp.status).toBe(400);
  const body = await resp.json();
  // multer отдаёт литеральный английский `File too large` — маршрут обязан
  // разобрать LIMIT_FILE_SIZE и вернуть русский текст с лимитом, а не голую строку.
  expect(body.error).toBe('Файл слишком большой: лимит 5 МБ');
  expect(mockAddPricePhoto).not.toHaveBeenCalled();
});

test('счастливый путь остаётся рабочим: файл пишется в uploads, БД получает валидированные числа', async () => {
  mockAddPricePhoto.mockResolvedValue({ id: 42 });
  const before = new Set(readdirSafe(uploadsDir));
  let createdFile = null;

  try {
    const fd = new FormData();
    fd.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'photo.jpg');
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
    expect(mockInvalidate).toHaveBeenCalledWith(1); // salonId из req.user
  } finally {
    if (createdFile) fs.rmSync(createdFile, { force: true });
  }

  const after = new Set(readdirSafe(uploadsDir));
  expect(after).toEqual(before); // подчистили за собой — каталог не засорён
});

test('DELETE /price-photos/:id зовёт сервис с id и salonId, снимает файл с диска, сбрасывает кэш индекса', async () => {
  const fileName = `pricelist_1_c5_${Date.now()}_del.jpg`;
  const filePath = path.join(uploadsDir, fileName);
  const fileUrl = `/uploads/${fileName}`;
  fs.writeFileSync(filePath, JPEG);
  mockRemovePricePhoto.mockResolvedValue({ file_url: fileUrl });

  try {
    const resp = await fetch(`${baseUrl}/price-photos/42`, { method: 'DELETE' });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);

    expect(mockRemovePricePhoto).toHaveBeenCalledWith(1, 42); // salonId, id

    const gone = await waitUntilGone(filePath);
    expect(gone).toBe(true); // файл реально снят с диска

    expect(mockInvalidate).toHaveBeenCalledWith(1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('PUT /price-photos/reorder прокидывает items в сервис, отвечает 200 и сбрасывает кэш индекса', async () => {
  mockReorderPricePhotos.mockResolvedValue({ ok: true });
  const items = [{ id: 1, displayOrder: 2 }, { id: 2, displayOrder: 1 }];

  const resp = await fetch(`${baseUrl}/price-photos/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body.ok).toBe(true);

  expect(mockReorderPricePhotos).toHaveBeenCalledWith(1, items); // salonId, items
  expect(mockInvalidate).toHaveBeenCalledWith(1);
});
