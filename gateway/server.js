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
const fs = require('fs');
const path = require('path');
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

// Query-параметры Chatpush: dispatch_routing[] — массив; qs() бэкенда кодирует `k[]=v`.
function q(req, name) { const v = req.query[name]; return Array.isArray(v) ? v[0] : (v == null ? undefined : String(v)); }

function createApp(deps = {}) {
  const d = { ...deps };
  for (const [k, load] of Object.entries(DEFAULT_LOADERS)) if (!d[k]) d[k] = load();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  const tmpDir = path.join(d.config.DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: 50 * 1024 * 1024 } });

  // ── Публичный API: Bearer = messenger_accounts.token ─────────────────
  async function accountAuth(req, res, next) {
    const token = bearerOf(req);
    const row = token ? await d.repo.byToken(token).catch(() => null) : null;
    if (!row) return res.status(401).json(chatpushError('unauthorized'));
    const client = d.registry.get(row.id);
    if (!client) return res.status(422).json(chatpushError('аккаунт не запущен'));
    req.account = row; req.tg = client;
    next();
  }

  const accepted = (id) => ({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });

  app.post('/api/v1/delivery', accountAuth, async (req, res) => {
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
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
      res.status(status).json(chatpushError(err.message));
    });
  }

  app.post('/api/v1/send_file', accountAuth, uploadFile, async (req, res) => {
    const tmp = req.file && req.file.path;
    try {
      if (!tmp) return res.status(422).json(chatpushError('нет файла'));
      const fileName = q(req, 'file_name') || req.file.originalname || 'file';
      const id = await req.tg.sendFile({ filePath: tmp, fileName, caption: q(req, 'caption') || '', type: q(req, 'type') || 'document', phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id') });
      logger.info(`#${req.account.id} send_file g${id} ${fileName}`);
      res.json(accepted(id));
    } catch (e) {
      logger.warn(`#${req.account.id} send_file failed: ${e.message}`);
      res.status(e.status || 500).json(chatpushError(e.message));
    } finally {
      // TDLib копирует файл при sendMessage; временный убираем с задержкой.
      if (tmp) setTimeout(() => fs.rm(tmp, { force: true }, () => {}), 60 * 1000).unref();
    }
  });

  app.get('/api/v1/delivery/:id', accountAuth, async (req, res) => {
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
  app.get('/health', (req, res) => res.json({ ok: true, accounts: [...d.registry._clients.values()].map(c => ({ id: c.id, authState: c.authState })) }));

  return app;
}

if (require.main === module) {
  const config = require('./config');
  const registry = require('./lib/registry');
  const app = createApp();
  app.listen(config.PORT, '127.0.0.1', () => {
    logger.info(`gateway слушает 127.0.0.1:${config.PORT}`);
    registry.startAllActive().catch(e => logger.error(`startAllActive: ${e.message}`));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { registry.closeAll().finally(() => process.exit(0)); });
  }
}

module.exports = { createApp };
