'use strict';
// Вебхук F.Doc SetStatus: POST /fdoc/webhook/<секрет салона>. Без JWT: F.Doc не умеет
// заголовок авторизации, поэтому секрет — часть URL (рекомендация самого F.Doc).
// Тело НЕ доверяется: это лишь сигнал «перечитай статус комплекта», статус берём из
// API под нашим токеном. Ответ 200 сразу (как routes/webhook.js), обработка — асинхронно
// и идемпотентно: недоставленный вебхук F.Doc повторяет до 10 раз.
const router = require('express').Router();
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const { createLogger } = require('../logger');

const logger = createLogger('FdocWebhook');
const SECRET_RE = /^[a-f0-9]{32,64}$/;
const FIELDS = ['employeeId', 'clientId', 'packageId', 'actionStatus', 'status', 'statusName', 'comment'];

// В журнал — только известные поля, строки обрезаны: тело присылает внешняя сторона.
function pick(body) {
  const out = {};
  for (const k of FIELDS) if (typeof body[k] === 'string') out[k] = body[k].slice(0, 300);
  if (Array.isArray(body.documentIds)) out.documentIds = body.documentIds.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 100));
  return out;
}

// ВНИМАНИЕ: не называть экспорт `handle` — это внутренний метод express.Router,
// перезапись ломает весь роутер (поймано тестом при подготовке плана).
async function processWebhook(salonId, body) {
  await store.touchWebhook(salonId);
  const b = body && typeof body === 'object' ? body : {};
  const packageId = typeof b.packageId === 'string' ? b.packageId.slice(0, 100) : null;
  await store.logEvent({ salonId, packageId, kind: 'webhook', payload: pick(b) });
  if (!packageId) return;
  const row = await store.findPackageByAnyId(salonId, packageId);
  if (!row) { logger.info(`fdoc webhook: комплект ${packageId} не наш (салон ${salonId})`); return; }
  await packages.refreshRows(salonId, [row]);
}

router.post('/webhook/:secret', async (req, res) => {
  const secret = String(req.params.secret || '');
  if (!SECRET_RE.test(secret)) return res.status(404).end();
  let salonId;
  try { salonId = await store.findSalonByWebhookSecret(secret); } catch (e) {
    logger.warn(`fdoc webhook: ${e.message}`);
    return res.status(503).end();
  }
  if (!salonId) return res.status(404).end();
  res.status(200).json({ ok: true });
  processWebhook(salonId, req.body).catch((e) => logger.warn(`fdoc webhook salon ${salonId}: ${e.message}`));
});

module.exports = router;
module.exports.processWebhook = processWebhook;
