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

async function recordRevenueOperation(payload, salon, source) {
  if (payload.status === 'delete') return;

  const data = payload.data || {};
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

  await db.query(`
    INSERT INTO revenue_operations
      (salon_id, yclients_operation_id, category, amount, operation_date, operation_at,
       client_id, yclients_client_id, yclients_record_id,
       expense_id, expense_title, sold_item_type, account_title, is_cash, raw_payload, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
  ]);
}

module.exports = { classifyExpense, recordRevenueOperation };
