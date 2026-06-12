'use strict';

const { db } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('Revenue');

const EXPENSE_TO_CATEGORY = {
  'Оказание услуг':       'services',
  'Продажа товаров':      'goods',
  'Продажа абонементов':  'abonement',
  'Продажа сертификатов': 'certificate',
  'Пополнение счета':     'deposit',
};

const EXPENSE_SKIP = new Set([
  'Закупка материалов',
  'Закупка товаров',
  'Зарплата персонала',
  'Прочие расходы',
]);

function classifyExpense(expenseTitle) {
  if (!expenseTitle) return null;
  if (EXPENSE_SKIP.has(expenseTitle)) return null;
  return EXPENSE_TO_CATEGORY[expenseTitle] || 'other';
}

// Ссылка на товарную транзакцию из payload операции. Поддерживает обе формы:
// webhook ({data:{sold_item_*}}) и плоский item из /transactions API (бэкфиллы).
function goodsTransactionRef(data) {
  if (!data) return null;
  const type = data.sold_item_type ?? data.data?.sold_item_type;
  const id = data.sold_item_id ?? data.data?.sold_item_id;
  if (type !== 'goods_transaction') return null;
  const n = parseInt(id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// «На кого записана продажа»: master_id товарной транзакции YClients.
// Webhook finances_operation всегда отдаёт master=[] — настоящая атрибуция
// продажи (товар/абонемент) есть только в goods_transaction. Ошибки API не
// валят приём операции — возвращаем null, атрибуция останется fallback'ом.
async function fetchSoldByStaffId(salon, soldItemId) {
  if (!soldItemId || !salon?.yclients_company_id || !salon?.yclients_partner_token) return null;
  try {
    const { ycGet } = require('./yclients');
    const gt = await ycGet(salon, `/storage_operations/goods_transactions/${salon.yclients_company_id}/${soldItemId}`);
    const masterId = parseInt(gt?.master_id, 10);
    return Number.isFinite(masterId) && masterId > 0 ? masterId : null;
  } catch (e) {
    logger.warn(`fetchSoldByStaffId failed sold_item_id=${soldItemId}: ${e.message}`);
    return null;
  }
}

async function recordRevenueOperation(payload, salon, source) {
  const data = payload.data || {};

  if (payload.status === 'delete') {
    if (!data.id) return;
    const result = await db.query(
      'DELETE FROM revenue_operations WHERE salon_id=$1 AND yclients_operation_id=$2',
      [salon.id, data.id]
    );
    if (result.rowCount > 0) {
      logger.info(`Deleted revenue_operations op_id=${data.id} (status=delete)`);
    }
    return;
  }

  const amount = parseFloat(data.amount || 0);
  if (amount <= 0) return;

  const expenseTitle = data.expense?.title || null;
  const category = classifyExpense(expenseTitle);
  if (!category) return;

  if (category === 'other') {
    logger.warn(`Unknown expense.title="${expenseTitle}" op_id=${data.id} — writing as 'other'`);
  }

  const operationAt = new Date(data.date);
  const operationDate = operationAt.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });

  const clientYcId = data.client?.id || null;
  const rawRecordId = data.record_id || data.record?.id;
  const ycRecordId = (rawRecordId && rawRecordId !== 0) ? rawRecordId : null;

  let clientId = null;
  if (clientYcId) {
    const client = await db.oneOrNone(
      'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    clientId = client?.id || null;
  }

  // Атрибуция продажи товара/абонемента конкретному сотруднику («на кого
  // записана продажа») — из товарной транзакции YClients. Один доп. API-вызов
  // на операцию; продажи редкие, обработка webhook уже асинхронная (после 200).
  let soldByYcStaffId = null;
  if (category === 'goods' || category === 'abonement') {
    soldByYcStaffId = await fetchSoldByStaffId(salon, goodsTransactionRef(data));
  }

  await db.query(`
    INSERT INTO revenue_operations
      (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
       client_id, yclients_client_id, yclients_record_id,
       expense_id, expense_title, sold_item_type, account_title, is_cash, raw_payload, source,
       sold_by_yc_staff_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING
  `, [
    salon.id,
    data.id,
    category,
    amount,
    operationDate,
    operationAt,
    clientId,
    clientYcId,
    ycRecordId,
    data.expense?.id || null,
    expenseTitle,
    data.sold_item_type || null,
    data.account?.title || null,
    data.account?.is_cash ?? null,
    payload,
    source,
    soldByYcStaffId,
  ]);
}

module.exports = { classifyExpense, recordRevenueOperation, goodsTransactionRef, fetchSoldByStaffId };
