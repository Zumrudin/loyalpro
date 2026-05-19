const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db');
const { getLoyaltySettings, processRecordEvent, processFinancesOperation } = require('../services/loyalty');
const { buildClientFio } = require('../utils/client-name');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

/**
 * Verify HMAC signature attached by YClients to a webhook delivery.
 * Expects `X-Yclients-Signature: sha256=<hex>` over the raw JSON body.
 * If `secret` is null/empty we treat the salon as not-yet-configured for HMAC
 * and accept (legacy mode) — admins should generate a secret to enable enforcement.
 */
function verifyWebhookSignature(req, secret) {
  if (!secret) return { ok: true, mode: 'legacy' };

  const header = req.headers['x-yclients-signature']
              || req.headers['x-signature']
              || req.headers['x-hub-signature-256'];
  if (!header || typeof header !== 'string') {
    return { ok: false, reason: 'missing signature header' };
  }
  const provided = header.replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return { ok: false, reason: 'malformed signature' };
  }
  const raw = req.rawBody;
  if (!raw || !raw.length) return { ok: false, reason: 'empty body' };

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'length mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, mode: 'verified' }
    : { ok: false, reason: 'signature mismatch' };
}

router.post('/webhook.v2/:companyId', async (req, res) => {
  const t0 = Date.now();
  let wlog = null;
  try {
    const salon = await db.oneOrNone(
      'SELECT * FROM salons WHERE yclients_company_id=$1 AND is_active=TRUE',
      [req.params.companyId]
    );
    if (!salon) {
      logger.warn(`salon not found companyId=${req.params.companyId}`);
      return res.status(404).json({ error: 'company not found' });
    }

    const sig = verifyWebhookSignature(req, salon.yclients_webhook_secret);
    if (!sig.ok) {
      logger.warn(`signature check failed companyId=${req.params.companyId} salon=${salon.id}: ${sig.reason}`);
      return res.status(401).json({ error: 'invalid signature' });
    }
    if (sig.mode === 'legacy') {
      logger.warn(`legacy unsigned webhook accepted companyId=${req.params.companyId} salon=${salon.id} — set yclients_webhook_secret to enable HMAC enforcement`);
    }

    // ACK immediately AFTER auth check — YClients retries on timeout, but we
    // don't want spoofed payloads to get 200 OK.
    res.json({ ok: true });

    const payload = req.body;
    const resourceType = payload.resource || payload.resource_type;
    logger.info(`hit companyId=${req.params.companyId} salon=${salon.id} resource=${resourceType} data_id=${payload.data?.id}`);

    wlog = await db.one(
      `INSERT INTO webhook_logs (salon_id,event_type,resource_id,payload) VALUES ($1,$2,$3,$4) RETURNING id`,
      [salon.id, resourceType, payload.data?.id || null, JSON.stringify(payload)]
    );

    const settings = await getLoyaltySettings(salon.id);

    if (resourceType === 'record') {
      await processRecordEvent(payload, salon, settings);
    }

    if (resourceType === 'client' && payload.data) {
      const ycRec = payload.data;
      await db.query(
        `INSERT INTO clients (salon_id,yclients_client_id,name,phone,email,birthday,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (salon_id,yclients_client_id)
         DO UPDATE SET name=$3,phone=$4,email=$5,birthday=$6,synced_at=NOW()`,
        [salon.id, ycRec.id, buildClientFio(ycRec), ycRec.phone, ycRec.email||null, ycRec.birth_date||null]
      );
    }

    if (resourceType === 'finances_operation') {
      await processFinancesOperation(payload, salon);
    }

    if (wlog) {
      await db.query('UPDATE webhook_logs SET processed=TRUE,processing_ms=$1 WHERE id=$2', [Date.now() - t0, wlog.id]);
    }
  } catch (e) {
    logger.error(`ERROR: ${e.message}`);
    try {
      if (wlog?.id) await db.query('UPDATE webhook_logs SET error_message=$1,processing_ms=$2 WHERE id=$3', [e.message, Date.now() - t0, wlog.id]);
    } catch {}
  }
});

module.exports = router;
