const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db');
const { getLoyaltySettings, processRecordEvent, processFinancesOperation } = require('../services/loyalty');
const { buildClientFio } = require('../utils/client-name');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

/**
 * Authenticate a webhook delivery by a shared secret carried in the URL.
 *
 * YClients does NOT sign webhook bodies and exposes no secret/signature field
 * in the marketplace app — the only thing you control is the notification URL.
 * So the secret travels as a query param: register the URL in YClients as
 *   https://<host>/yclients/webhook.v2/<companyId>?key=<secret>
 * and we compare `?key=` against the per-salon secret (timing-safe).
 *
 * If `secret` is null/empty the salon is not-yet-configured and we accept
 * (legacy mode) so delivery never breaks before the URL is updated. Generate a
 * secret + update the YClients URL together to switch a salon into enforcement.
 */
function verifyWebhookSecret(req, secret) {
  if (!secret) return { ok: true, mode: 'legacy' };

  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (!provided) return { ok: false, reason: 'missing key' };

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false, reason: 'key mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, mode: 'verified' }
    : { ok: false, reason: 'key mismatch' };
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

    const sig = verifyWebhookSecret(req, salon.yclients_webhook_secret);
    if (!sig.ok) {
      logger.warn(`webhook key check failed companyId=${req.params.companyId} salon=${salon.id}: ${sig.reason}`);
      return res.status(401).json({ error: 'invalid key' });
    }
    if (sig.mode === 'legacy') {
      logger.warn(`legacy unauthenticated webhook accepted companyId=${req.params.companyId} salon=${salon.id} — set yclients_webhook_secret and add ?key=<secret> to the YClients notification URL to enable enforcement`);
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
