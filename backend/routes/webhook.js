const router = require('express').Router();
const { db } = require('../db');
const { getLoyaltySettings, processRecordEvent, processFinancesOperation } = require('../services/loyalty');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

router.post('/webhook.v2/:companyId', async (req, res) => {
  res.json({ ok: true });
  const t0 = Date.now();
  logger.info(`hit companyId=${req.params.companyId} resource=${req.body?.resource||req.body?.resource_type}`);
  let wlog = null;
  try {
    const salon = await db.oneOrNone(
      'SELECT * FROM salons WHERE yclients_company_id=$1 AND is_active=TRUE',
      [req.params.companyId]
    );
    if (!salon) { logger.warn(`salon not found companyId=${req.params.companyId}`); return; }

    const payload = req.body;
    const resourceType = payload.resource || payload.resource_type;
    logger.info(`salon=${salon.id} resource=${resourceType} data_id=${payload.data?.id}`);

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
        [salon.id, ycRec.id, ycRec.name||'Клиент', ycRec.phone, ycRec.email||null, ycRec.birth_date||null]
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
