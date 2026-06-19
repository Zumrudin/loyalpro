// backend/services/cert-amount.js
'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('CertAmount');

// Сумма расходов клиента на медуслуги за отчётный год (1 января — 31 декабря).
// Источник истины — YClients (finance-операции «Оказание услуг»): webhook-синк
// revenue_operations бывает неполным, из-за чего сумма не подтягивалась. При
// отсутствии реквизитов YClients или ошибке API — фолбэк на revenue_operations.
async function sumServicePaymentsForYear({ db, salonId, clientId, year }) {
  if (!clientId) return 0;

  const client = await db.oneOrNone(
    'SELECT yclients_client_id FROM clients WHERE id=$1 AND salon_id=$2', [clientId, salonId]);
  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);

  const ycId = client && client.yclients_client_id;
  const hasCreds = salon && salon.yclients_company_id
    && salon.yclients_partner_token && salon.yclients_user_token;

  if (ycId && hasCreds) {
    try {
      const { ycSumServicePayments } = require('./yclients');
      return await ycSumServicePayments(salon, String(ycId), `${year}-01-01`, `${year}-12-31`);
    } catch (e) {
      logger.warn(`YClients sum failed salon=${salonId} client=${clientId} year=${year}: ${e.message} — фолбэк на revenue_operations`);
    }
  }

  const row = await db.one(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM revenue_operations
      WHERE salon_id=$1 AND client_id=$2 AND category='services'
        AND EXTRACT(YEAR FROM operation_date)=$3`,
    [salonId, clientId, year]);
  return Number(row.total) || 0;
}

module.exports = { sumServicePaymentsForYear };
