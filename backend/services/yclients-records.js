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
  let data;
  try {
    ({ data } = await axios.put(url, body, { headers: ycHeaders(salon), timeout: 15000 }));
  } catch (e) {
    // YClients кладёт реальную причину в тело ответа (meta.message + errors), а
    // axios показывает лишь «Request failed with status code 422». Достаём её,
    // чтобы в логах и в reason эскалации была видна суть (напр. «Не передан
    // обязательный параметр client»), а не голый статус.
    const d = (e.response && e.response.data) || {};
    const info = d.meta || d;   // YClients кладёт причину в meta, иногда в корень тела
    const msg = info.message || e.message;
    const fields = info.errors ? ` (${JSON.stringify(info.errors)})` : '';
    logger.error(`YClients refused update [${e.response ? e.response.status : '?'}]: ${msg}${fields}`);
    throw new Error(`${msg}${fields}`);
  }
  if (!data.success) {
    const msg = data.meta?.message || 'YClients update failed';
    logger.error(`YClients refused update: ${msg}`);
    throw new Error(msg);
  }
  return data.data;
}

/**
 * Найти id услуги по названию в ПОЛНОМ каталоге салона (management-эндпоинт
 * GET /company/{company_id}/services/). Именно полный список — не booking-версия
 * /services/{cid} и не list_services: те режут технические услуги (цена 0) и
 * применяют offer-фильтр (в allowlist-режиме отдают только услуги из белого
 * списка). Техническая услуга «Запрет на отправку» есть только здесь.
 * Возвращает id первой услуги, чьё название содержит needle, иначе null.
 */
async function ycFindServiceIdByTitle(salon, needle) {
  const n = String(needle || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!n || !salon || !salon.yclients_company_id) return null;
  const list = await ycGet(salon, `/company/${salon.yclients_company_id}/services/`, {});
  const svc = (Array.isArray(list) ? list : []).find(
    s => String(s.title || '').toLowerCase().replace(/\s+/g, ' ').trim().includes(n));
  return svc ? svc.id : null;
}

module.exports = {
  updateAttendance, ycGetRecord, ycGetClientRecords, ycUpdateRecord, ycFindServiceIdByTitle,
};
