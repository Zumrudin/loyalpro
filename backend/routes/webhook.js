const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { db } = require('../db');
const { getLoyaltySettings, processRecordEvent, processFinancesOperation } = require('../services/loyalty');
const { handleRecordEvent } = require('../services/notifications');
const care = require('../services/care/enroll');
const reminders = require('../services/reminders/enroll');
const { upsertClientFromYc } = require('../services/client-upsert');
const economics = require('../services/economics');
const followupQueue = require('../services/agent/followup-queue');
const { normalizePhoneKey } = require('../services/agent-gate');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');
const { safeErrorCode } = require('../utils/safe-error');
const securityStatus = require('../services/webhook-security-status');

/**
 * Authenticate a webhook delivery by a shared secret carried in the URL.
 *
 * YClients does NOT sign webhook bodies and exposes no secret/signature field
 * in the marketplace app — the only thing you control is the notification URL.
 * So the secret travels as a query param: register the URL in YClients as
 *   https://<host>/yclients/webhook.v2/<companyId>?key=<secret>
 * and we compare `?key=` against the per-salon secret (timing-safe).
 *
 * An empty per-salon secret is a configuration error: the endpoint returns 503
 * and accepts nothing until the secret and the provider URL are configured.
 */
function verifyWebhookSecret(req, secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    return { ok: false, status: 503, reason: 'not_configured' };
  }

  const provided = typeof req.query?.key === 'string' ? req.query.key : '';
  if (!provided) return { ok: false, status: 401, reason: 'missing_key' };

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false, status: 401, reason: 'invalid_key' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, status: 401, reason: 'invalid_key' };
}

const rateLimitConfig = config.WEBHOOK_RATE_LIMIT || {};
const limiterOptions = {
  windowMs: rateLimitConfig.windowMs || 60_000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    securityStatus.record('yclients', 'rate_limited');
    return res.status(429).json({ error: 'too many requests' });
  },
};
const webhookIpLimiter = rateLimit({ ...limiterOptions, limit: rateLimitConfig.ipLimit || 240 });
const webhookCompanyLimiter = rateLimit({
  ...limiterOptions,
  limit: rateLimitConfig.accountLimit || 120,
  keyGenerator: req => `company:${req.params.companyId}`,
});

router.use('/webhook.v2/:companyId', webhookIpLimiter, webhookCompanyLimiter);

router.post('/webhook.v2/:companyId', async (req, res) => {
  const t0 = Date.now();
  let wlog = null;
  try {
    const salon = await db.oneOrNone(
      'SELECT * FROM salons WHERE yclients_company_id=$1 AND is_active=TRUE',
      [req.params.companyId]
    );
    if (!salon) {
      logger.warn('webhook salon not found');
      return res.status(404).json({ error: 'company not found' });
    }

    const sig = verifyWebhookSecret(req, salon.yclients_webhook_secret);
    if (!sig.ok) {
      securityStatus.record('yclients', sig.reason);
      return res.status(sig.status).json({ error: sig.status === 503 ? 'webhook not configured' : 'invalid key' });
    }

    // ACK immediately AFTER auth check — YClients retries on timeout, but we
    // don't want spoofed payloads to get 200 OK.
    securityStatus.record('yclients', 'accepted');
    res.json({ ok: true });

    const payload = req.body;
    const resourceType = payload.resource || payload.resource_type;
    logger.info(`authenticated webhook salon=${salon.id}`);

    wlog = await db.one(
      `INSERT INTO webhook_logs (salon_id,event_type,resource_id,payload) VALUES ($1,$2,$3,$4) RETURNING id`,
      [salon.id, resourceType, payload.data?.id || null, JSON.stringify(payload)]
    );

    const settings = await getLoyaltySettings(salon.id);

    if (resourceType === 'record') {
      await processRecordEvent(payload, salon, settings);
      // Уведомления клиенту по ЛЮБОМУ событию записи (создание/перенос/отмена/
      // пришёл → напоминание, опрос, рекомендации). Свой catch — сбой не должен
      // ломать начисления.
      await handleRecordEvent(salon, payload).catch(e =>
        logger.error(`notifications: ${safeErrorCode(e)}`));
      // «Отдел заботы»: визит состоялся → зачисление в программы.
      // Свой catch — сбой заботы не должен ломать начисления.
      await care.handleRecordEvent(salon, payload).catch(e =>
        logger.error(`care enroll: ${safeErrorCode(e)}`));
      // Напоминания о повторном визите — в СВОЁМ catch: их падение не должно
      // ронять «Заботу» и начисление кэшбэка.
      await reminders.handleRecordEvent(salon, payload).catch(e =>
        logger.error(`reminders enroll: ${safeErrorCode(e)}`));
      await reminders.handleAttribution(salon, payload).catch(e =>
        logger.error(`reminders attribution: ${safeErrorCode(e)}`));
      // Ожидание ответа Милы гасится ЗАПИСЬЮ в CRM: клиента записал
      // администратор (по телефону/в приложении) — напоминать «удалось ли
      // посмотреть?» уже не о чем. Только живое создание: отмена/удаление
      // ожидания не трогают. SSE по ключу диалога шлёт сам closeByPhone.
      // Свой catch — как у соседей.
      if (payload.status === 'create' && payload.data && payload.data.deleted !== true
          && Number(payload.data.attendance) !== -1) {
        const fuPhone = normalizePhoneKey(payload.data.client && payload.data.client.phone);
        if (fuPhone) {
          await followupQueue.closeByPhone(salon.id, fuPhone, 'booked_in_crm')
            .then(n => { if (n) logger.info(`followup: ${n} ожидани(е/я) погашено записью в CRM`); })
            .catch(e => logger.warn(`followup close by booking: ${safeErrorCode(e)}`));
        }
      }
    }

    // client-вебхук приходит на КАЖДЫЙ оплаченный визит и на правку карточки и
    // несёт spent/paid/visits/раздельное ФИО — те же поля, что /client/{cid}/{id}.
    // До 25.09.2026 отсюда брались только ФИО/телефон/почта/ДР, а траты/визиты/
    // уровень писал ТОЛЬКО runSync (сломан лимитом YClients с 26.06). Правило
    // разбора одно на вебхук и ночную сверку — services/client-upsert.js.
    if (resourceType === 'client' && payload.data) {
      await upsertClientFromYc(salon.id, payload.data, settings);
    }

    if (resourceType === 'finances_operation') {
      await processFinancesOperation(payload, salon);
    }

    // Товарные операции (списания расходников, приходы, продажи, потери) →
    // goods_transactions для экономики процедур. Свой catch: 200 уже отдан,
    // потерянное добирает ночная сверка (services/economics/sync.js).
    if (typeof resourceType === 'string' && resourceType.startsWith('goods_operations_')) {
      await economics.handleGoodsEvent(salon, payload).catch(e =>
        logger.error(`economics goods event: ${safeErrorCode(e)}`));
    }

    // Карточка товара YClients (resource=good): расширенные поля каталога, delete → stock_active=false.
    if (resourceType === 'good') {
      await require('../services/stock').handleGoodEvent(salon, payload).catch(e =>
        logger.error(`stock good event: ${safeErrorCode(e)}`));
    }

    if (wlog) {
      await db.query('UPDATE webhook_logs SET processed=TRUE,processing_ms=$1 WHERE id=$2', [Date.now() - t0, wlog.id]);
    }
  } catch (e) {
    logger.error(`ERROR: ${safeErrorCode(e)}`);
    try {
      if (wlog?.id) await db.query('UPDATE webhook_logs SET error_message=$1,processing_ms=$2 WHERE id=$3', [e.message, Date.now() - t0, wlog.id]);
    } catch {}
  }
});

module.exports = router;
