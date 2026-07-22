// ============================================================
// YClients records: write-side helpers (confirm / cancel)
// ============================================================
const axios = require('axios');
const config = require('../config');
const { ycHeaders, ycGet } = require('./yclients');
const { createLogger } = require('../logger');
const logger = createLogger('YClients-records');

const YC = config.YC;

/**
 * Update the `attendance` field on a YClients record.
 *
 * attendance: 2 = confirmed, 1 = arrived, 0 = waiting, -1 = no_show
 *
 * Throws on YClients failure (caller should map to 502).
 */
async function updateAttendance(salon, ycRecordId, attendance) {
  const url = `${YC}/record/${salon.yclients_company_id}/${ycRecordId}`;
  logger.info(`PUT ${url} attendance=${attendance}`);
  const { data } = await axios.put(
    url,
    { attendance },
    { headers: ycHeaders(salon), timeout: 15000 },
  );
  if (!data.success) {
    const msg = data.meta?.message || 'YClients update failed';
    logger.error(`YClients refused update: ${msg}`);
    throw new Error(msg);
  }
  return data.data;
}

/**
 * Получить одну запись целиком: GET /record/{company_id}/{record_id}.
 */
async function ycGetRecord(salon, ycRecordId) {
  return ycGet(salon, `/record/${salon.yclients_company_id}/${ycRecordId}`, {});
}

/**
 * Живой список записей клиента: GET /records/{company_id}?client_id=…
 * start_date/end_date — необязательные границы (YYYY-MM-DD).
 */
async function ycGetClientRecords(salon, clientId, { startDate, endDate } = {}) {
  const params = { client_id: clientId, count: 300 };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const data = await ycGet(salon, `/records/${salon.yclients_company_id}`, params);
  return Array.isArray(data) ? data : [];
}

/**
 * Обновить запись целиком: PUT /record/{company_id}/{record_id}.
 * body — поля записи (attendance, services, datetime, seance_length, staff_id, comment…).
 * Throws on YClients failure.
 */
async function ycUpdateRecord(salon, ycRecordId, body) {
  const url = `${YC}/record/${salon.yclients_company_id}/${ycRecordId}`;
  logger.info(`PUT ${url} keys=${Object.keys(body).join(',')}`);
  const { data } = await axios.put(url, body, { headers: ycHeaders(salon), timeout: 15000 });
  if (!data.success) {
    const msg = data.meta?.message || 'YClients update failed';
    logger.error(`YClients refused update: ${msg}`);
    throw new Error(msg);
  }
  return data.data;
}

module.exports = { updateAttendance, ycGetRecord, ycGetClientRecords, ycUpdateRecord };
