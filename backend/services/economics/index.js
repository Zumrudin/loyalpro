'use strict';
// Фасад модуля для routes/webhook.js и server.js.
const { parseGoodsOperation } = require('./goods-events');
const store = require('./store');
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

module.exports = { handleGoodsEvent };
