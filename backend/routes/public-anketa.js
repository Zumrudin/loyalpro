'use strict';
// Публичная анкета пациента (БЕЗ JWT) — спека 2026-10-25 §6.4. Монтируется ДО глобальной
// проверки /api (как public-cert-request). Токен — в адресе: страница и ответы не кэшируются,
// Referrer не уходит (иначе токен утёк бы по ссылке на политику), поисковикам — noindex.
// Лимиты — память процесса (cert-request.makeRateLimiter), ошибка лимита — 429 с текстом.
const path = require('path');
const router = require('express').Router();
const multer = require('multer');
const forms = require('../services/edocs/forms');
const { makeRateLimiter } = require('../services/cert-request');
const { createLogger } = require('../logger');

const logger = createLogger('AnketaPublic');
const viewLimit = makeRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const submitIpLimit = makeRateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
const submitFormLimit = makeRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const photoLimit = makeRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const TOO_MANY = { error: 'Слишком много запросов — попробуйте позже', code: 'too_many_requests' };

function clientIp(req) { return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'; }
function privateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}
/** Ошибки анкеты — человеческим текстом; прочее — 500 без подробностей (подробности в лог). */
function fail(res, e, label) {
  if (e && e.name === 'EdocsError') return res.status(e.status || 400).json({ error: e.message, code: e.code });
  logger.error(`${label}: ${(e && e.message) || e}`);
  return res.status(500).json({ error: 'Не получилось — попробуйте ещё раз или сообщите клинике', code: 'internal' });
}

router.get('/anketa/:token', (req, res) => {
  privateHeaders(res);
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.sendFile(path.join(__dirname, '../../frontend/anketa.html'));
});

router.get('/api/public/anketa/:token', async (req, res) => {
  privateHeaders(res);
  if (!viewLimit(clientIp(req))) return res.status(429).json(TOO_MANY);
  try { res.json(await forms.publicView(req.params.token)); } catch (e) { fail(res, e, 'anketa view'); }
});

router.post('/api/public/anketa/:token', async (req, res) => {
  privateHeaders(res);
  if (!submitIpLimit(clientIp(req)) || !submitFormLimit(String(req.params.token).slice(0, 64))) return res.status(429).json(TOO_MANY);
  try {
    const r = await forms.publicSubmit(req.params.token, req.body || {}, { ip: clientIp(req) });
    res.json({ ok: r.ok, docs: r.docs });   // _background (промис отправки документов) наружу не отдаётся
  } catch (e) { fail(res, e, 'anketa submit'); }
});

router.post('/api/public/anketa/:token/photo', (req, res, next) => {
  privateHeaders(res);
  if (!photoLimit(clientIp(req))) return res.status(429).json(TOO_MANY);
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 15 МБ' : 'Не удалось принять фото', code: 'bad_image' });
    return next();
  });
}, async (req, res) => {
  try { res.json(await forms.publicPhoto(req.params.token, req.file)); } catch (e) { fail(res, e, 'anketa photo'); }
});

module.exports = router;
