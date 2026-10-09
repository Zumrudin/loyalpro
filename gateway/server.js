'use strict';
// ============================================================
// LoyalPro Gateway — Chatpush-совместимый API поверх TDLib (контракт: план
// docs/superpowers/plans/2026-10-08-telegram-gateway-multitenant.md, раздел
// «Контракт шлюза»). Публичный API: Bearer = messenger_accounts.token;
// внутренний (/internal/*): заголовок X-Gateway-Secret. Слушает ТОЛЬКО
// 127.0.0.1 — наружу шлюз не светится, бэкенд ходит локально.
// createApp(deps) — фабрика без listen/TDLib/БД ради тестов.
// ============================================================
const express = require('express');
const multer = require('multer');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EXT_BY_MIME, safeExt } = require('./lib/telegram-client');
const { bearerOf, internalOk, chatpushError } = require('./lib/http-auth');
const { createLogger } = require('./logger');
const logger = createLogger('Server');

// Дефолтные зависимости грузятся ЛЕНИВО и только те, что не подменены:
// config бросает без .env, а registry тянет TDLib и пул БД — тестам это не нужно.
const DEFAULT_LOADERS = {
  config: () => require('./config'),
  repo: () => require('./lib/accounts-repo'),
  registry: () => require('./lib/registry'),
  deliveries: () => require('./lib/deliveries'),
  mapper: () => require('./lib/mapper'),
};

const DEFAULT_UPLOAD_LIMIT = 50 * 1024 * 1024;
const TMP_SAFETY_MS = 30 * 60 * 1000;     // страховка, если TDLib так и не подтвердил отправку

// Query-параметры Chatpush: dispatch_routing[] — массив; qs() бэкенда кодирует `k[]=v`.
// Нет в query — берём из тела (длинный текст не влезает в строку запроса).
// Объект (qs extended: `text[a]=b`) — не значение, а мусор: undefined.
function q(req, name) {
  let v = req.query[name];
  if (v === undefined && req.body && typeof req.body === 'object') v = req.body[name];
  if (Array.isArray(v)) v = v[0];
  if (v == null || typeof v === 'object') return undefined;
  return String(v);
}

// Имя файла уходит в Telegram как имя документа, поэтому его сохраняем — но без
// путей, управляющих символов и «чужих» расширений: расширение не из EXT_BY_MIME
// получает хвост по фактическому MIME (evil.html + image/jpeg → evil.html.jpg).
// Имя файла для Telegram (идёт собеседнику как имя документа, НЕ в наш
// публичный каталог — XSS-риска тут нет, поэтому своё расширение документа
// сохраняем: pptx/zip из «Чата» не должны приезжать как deck.pptx.bin).
// Расширение по MIME добавляем только когда своего нет. Режем СТЕМ, не имя
// целиком, чтобы длинное имя не теряло расширение.
function safeFileName(name, mimeType) {
  let n = String(name || '')
    .replace(/[\/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w.\- а-яА-ЯёЁ()]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
  let ext = path.extname(n).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '';
  let stem = ext ? n.slice(0, -ext.length) : n;
  stem = stem.slice(0, 100).replace(/[. ]+$/, '');
  if (!stem) stem = 'file';
  if (!ext) ext = safeExt(mimeType);
  return stem + ext;
}

function removeTmp(file) {
  fs.rm(file, { force: true }, () => { fs.rmdir(path.dirname(file), () => {}); });
}

// Остатки прошлых запусков (процесс упал до подтверждения отправки).
function sweepTmp(dir, maxAgeMin = 60) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return 0; }
  const cutoff = Date.now() - maxAgeMin * 60 * 1000;
  let removed = 0;
  for (const e of entries) {
    const p = path.join(dir, e);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
    } catch (_) { /* исчез между readdir и stat */ }
  }
  return removed;
}

function createApp(deps = {}) {
  const d = { ...deps };
  for (const [k, load] of Object.entries(DEFAULT_LOADERS)) if (!d[k]) d[k] = load();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  const tmpDir = path.join(d.config.DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  // Каждый файл — в своём tmp/<hex>/: имя документа сохраняем, коллизий нет.
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(tmpDir, crypto.randomBytes(8).toString('hex'));
      req._uploadDir = dir;
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      cb(null, safeFileName(q(req, 'file_name') || file.originalname, file.mimetype));
    },
  });
  const upload = multer({ storage, limits: { fileSize: d.config.UPLOAD_LIMIT_BYTES || DEFAULT_UPLOAD_LIMIT } });

  // ── Публичный API: Bearer = messenger_accounts.token ─────────────────
  // Сбой БД — 503, а не 401: бэкенд не должен читать это как «токен отозван».
  async function tokenAuth(req, res, next) {
    const token = bearerOf(req);
    let row;
    try { row = token ? await d.repo.byToken(token) : null; }
    catch (e) {
      logger.warn(`проверка токена: ${e.message}`);
      return res.status(503).json(chatpushError('gateway db unavailable'));
    }
    if (!row) return res.status(401).json(chatpushError('unauthorized'));
    req.account = row;
    next();
  }
  // Отправке нужен живой клиент TDLib; статусу доставки — нет (он в БД).
  function requireClient(req, res, next) {
    const client = d.registry.get(req.account.id);
    if (!client) return res.status(422).json(chatpushError('аккаунт не запущен'));
    req.tg = client;
    next();
  }

  const accepted = (id) => ({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });

  app.post('/api/v1/delivery', tokenAuth, requireClient, async (req, res) => {
    try {
      const text = q(req, 'text') || '';
      if (!text.trim()) return res.status(422).json(chatpushError('пустой text'));
      const id = await req.tg.sendText({ text, phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id'), replyToMessageId: q(req, 'reply_to_message_id') });
      logger.info(`#${req.account.id} delivery g${id} → ${q(req, 'phone') || q(req, 'tdlib_user_id')}: ${text.slice(0, 60)}`);
      res.json(accepted(id));
    } catch (e) {
      logger.warn(`#${req.account.id} delivery failed: ${e.message}`);
      res.status(e.status || 500).json(chatpushError(e.message));
    }
  });

  // multer-ошибка (файл больше лимита, битый multipart) — в форме Chatpush, а не HTML Express.
  function uploadFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      // multer сам удаляет недописанный файл; пустой каталог — наш.
      if (req._uploadDir) fs.rmdir(req._uploadDir, () => {});
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
      res.status(status).json(chatpushError(err.message));
    });
  }

  app.post('/api/v1/send_file', tokenAuth, requireClient, uploadFile, async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      if (!tmp) return res.status(422).json(chatpushError('нет файла'));
      const fileName = path.basename(tmp);
      const id = await req.tg.sendFile({ filePath: tmp, fileName, caption: q(req, 'caption') || '', type: q(req, 'type') || 'document', phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id') });
      logger.info(`#${req.account.id} send_file g${id} ${fileName}`);
      res.json(accepted(id));
      // Файл удалит клиент TDLib по SendSucceeded/SendFailed; таймер — страховка.
      setTimeout(() => removeTmp(tmp), TMP_SAFETY_MS).unref();
    } catch (e) {
      // До sendMessage дело не дошло (или он отвергнут) — файл никому не нужен.
      if (tmp) removeTmp(tmp);
      logger.warn(`#${req.account.id} send_file failed: ${e.message}`);
      res.status(e.status || 500).json(chatpushError(e.message));
    }
  });

  app.get('/api/v1/delivery/:id', tokenAuth, async (req, res) => {
    try {
      const id = d.deliveries.parseId(req.params.id);
      if (!id) return res.status(404).json(chatpushError('not found'));
      // Скоуп по аккаунту токена: чужой id неотличим от несуществующего.
      const row = await d.deliveries.get(req.account.id, id);
      if (!row) return res.status(404).json(chatpushError('not found'));
      res.json({ delivery: d.mapper.deliveryStatus(row) });
    } catch (e) {
      logger.warn(`#${req.account.id} delivery status failed: ${e.message}`);
      res.status(500).json(chatpushError(e.message));
    }
  });

  // ── Внутренний API: X-Gateway-Secret ────────────────────────────────
  function internalAuth(req, res, next) {
    if (!internalOk(req, d.config.INTERNAL_SECRET)) return res.status(401).json({ error: 'unauthorized' });
    next();
  }
  const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

  app.post('/internal/accounts/:id/start', internalAuth, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'bad id' });
    try { const c = await d.registry.start(id); res.json({ authState: c.authState }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.post('/internal/accounts/:id/auth', internalAuth, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'bad id' });
    const c = d.registry.get(id);
    if (!c) return res.status(404).json({ error: 'аккаунт не запущен' });
    try { res.json(await c.authStep(req.body || {})); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  app.get('/internal/accounts/:id/status', internalAuth, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const c = d.registry.get(id);
      if (c) return res.json(c.status());
      const row = await d.repo.get(id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({ authState: row.auth_state || 'logged_out', phone: row.phone, displayName: row.display_name, error: row.auth_error });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/internal/accounts/:id/logout', internalAuth, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'bad id' });
    try { await d.registry.logout(id); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Без авторизации: шлюз слушает только 127.0.0.1, а ответ — лишь id и состояние.
  app.get('/health', (req, res) => res.json({ ok: true, accounts: d.registry.list() }));

  return app;
}

if (require.main === module) {
  const config = require('./config');
  const registry = require('./lib/registry');
  const swept = sweepTmp(path.join(config.DATA_DIR, 'tmp'), 60);
  // Повторно раз в час: после рестарта TDLib досылает отложенное, а связка
  // pendingFiles в памяти уже пуста — такие файлы иначе жили бы до следующего рестарта.
  setInterval(() => { try { sweepTmp(path.join(config.DATA_DIR, 'tmp'), 120); } catch (_) {} }, 60 * 60 * 1000).unref();
  if (swept) logger.info(`sweepTmp: удалено ${swept} старых временных файлов`);
  const app = createApp();
  // maxHeaderSize 64 КБ: text Chatpush-клиент шлёт в query, длинная реплика не влезает в дефолтные 16 КБ.
  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, app);
  server.listen(config.PORT, '127.0.0.1', () => {
    logger.info(`gateway слушает 127.0.0.1:${config.PORT}`);
    registry.startAllActive().catch(e => logger.error(`startAllActive: ${e.message}`));
  });
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${sig}: закрываем HTTP и клиентов TDLib`);
      server.close();
      registry.closeAll().finally(() => process.exit(0));
    });
  }
}

module.exports = { createApp, sweepTmp, safeFileName };
