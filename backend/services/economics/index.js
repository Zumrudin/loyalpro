'use strict';
// Фасад модуля для routes/webhook.js и server.js.
const { parseGoodsOperation } = require('./goods-events');
const store = require('./store');
const sync = require('./sync');
const report = require('./report');
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const logger = createLogger('Economics');

/**
 * Вебхук goods_operations_*: разобрать → апсерт → для прихода пересчитать
 * «последнюю закупку». Исключение логируется (200 уже отдан), потерянное
 * добирает ночная сверка.
 * @returns {Promise<{handled:boolean, status?:string}>}
 */
async function handleGoodsEvent(salon, payload) {
  const parsed = parseGoodsOperation(payload);
  if (!parsed) return { handled: false };
  const { status, row } = parsed;
  await store.upsertGoodsTransaction(salon.id, row, { status, source: 'webhook' });
  if (Number(row.type_id) === 3 && row.good_id) {
    await store.refreshLastReceipt(salon.id, row.good_id)
      .catch(e => logger.warn(`last receipt good=${row.good_id}: ${e.message}`));
  }
  return { handled: true, status };
}

const _failStreak = new Map();   // salonId → провалов подряд
const REPEATED_FAILURES = 3;

async function runNightlyAll() {
  const salons = await db.any(`SELECT * FROM salons WHERE is_active AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`);
  for (const salon of salons) {
    try {
      const r = await sync.runNightly(salon);
      report.invalidate(salon.id);
      if (r.ok) _failStreak.set(salon.id, 0);
      else {
        const n = (_failStreak.get(salon.id) || 0) + 1; _failStreak.set(salon.id, n);
        if (n >= REPEATED_FAILURES) logger.warn(`salon=${salon.id}: экономика: синк не проходит ${n} ночи подряд: ${JSON.stringify(r.errors)}`);
      }
    } catch (e) { logger.error(`salon=${salon.id}: ночной проход экономики: ${e.message}`); }
  }
}

module.exports = { handleGoodsEvent, runNightlyAll };
