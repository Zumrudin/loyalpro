'use strict';
// Journal integration boundary: no raw upstream errors / payloads in logs or responses.
const axios = require('axios');
const config = require('../../config');
const { ycGet, ycHeaders } = require('../yclients');
const { fail } = require('./model');
async function list(salon, path, params = {}) {
  const value = await ycGet(salon, path, params);
  if (!Array.isArray(value)) fail('YClients вернул неполные данные.', 502);
  return value;
}
async function records(salon, dateFrom, dateTo = dateFrom) {
  const out = [], seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const batch = await list(salon, `/records/${salon.yclients_company_id}`, {
      start_date: dateFrom, end_date: dateTo, page, count: 200,
    });
    for (const r of batch) {
      if (!r?.id || (r.company_id && Number(r.company_id) !== Number(salon.yclients_company_id)) || seen.has(r.id)) fail('Не удалось загрузить все записи. Обновите журнал.', 502);
      seen.add(r.id); out.push(r);
    }
    if (batch.length < 200) return out;
  }
  fail('Слишком много записей для одного дня.', 502);
}
async function getRecord(salon, id, options = {}) {
  const path = `/record/${salon.yclients_company_id}/${id}`;
  // Payment replacement needs a complete stock snapshot. Ordinary booking
  // reads retain their existing shape, including the service payload for moves.
  const r = await (options.includeConsumables === true
    ? ycGet(salon, path, { include_consumables: 1 }) : ycGet(salon, path));
  if (!r || Number(r.id) !== id || (r.company_id && Number(r.company_id) !== Number(salon.yclients_company_id))) fail('Запись не найдена.', 404);
  return r;
}
async function write(salon, id, body) {
  const authSalon = config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN } : salon;
  const response = await axios({ method: id ? 'put' : 'post',
    url: `${config.YC}/${id ? 'record' : 'records'}/${salon.yclients_company_id}${id ? '/' + id : ''}`,
    headers: ycHeaders(authSalon), timeout: 30000, data: body,
  });
  if (!response.data?.success) throw new Error('upstream_write_failed');
  const recordId = id || Number(response.data?.data?.id);
  if (!recordId) throw new Error('upstream_write_unconfirmed');
  return { recordId };
}
async function getSale(salon, documentId) {
  const data = await ycGet(salon, `/company/${salon.yclients_company_id}/sale/${documentId}`);
  if (!data?.state || !Array.isArray(data.state.items) || !Array.isArray(data.state.payment_transactions) || !Array.isArray(data.state.loyalty_transactions) || !Array.isArray(data.payment_methods)) fail('Не удалось проверить состояние оплаты визита.',502);
  return data;
}
async function pay(salon, documentId, method, amount) {
  // One documented POST for both bonuses and cash/card. It carries only the
  // payment: services, goods and attendance of the visit are never resent.
  // YClients itself rolls a cash payment back while the visit is «Ожидание»
  // (attendance 0): it creates the operation, re-saves the record and deletes
  // it ~0.3 s later (dev 08–09.11.2026). The caller marks arrival first and
  // verifies the receipt after a pause.
  const valid = method?.slug === 'loyalty_card' ? Number(method.loyalty_card_id) > 0
    : method?.slug === 'account' ? Number(method.account_id) > 0 : false;
  if (!valid) fail('Способ оплаты не поддерживается.', 400);
  const authSalon = config.YCLIENTS_INTEGRATION_USER_TOKEN ? {...salon,yclients_user_token:config.YCLIENTS_INTEGRATION_USER_TOKEN}:salon;
  const response = await axios({method:'post',url:`${config.YC}/company/${salon.yclients_company_id}/sale/${documentId}/payment`,headers:ycHeaders(authSalon),timeout:30000,data:{payment:{method,amount}}});
  if (!response.data?.success || !response.data.data?.state) throw new Error('payment_unconfirmed');
  return response.data.data;
}
async function removePayment(salon,documentId,method,transactionId) {
 const authSalon=config.YCLIENTS_INTEGRATION_USER_TOKEN?{...salon,yclients_user_token:config.YCLIENTS_INTEGRATION_USER_TOKEN}:salon;
 const kind=method==='account'?'payment_transaction':'loyalty_transaction';
 const response=await axios({method:'delete',url:`${config.YC}/company/${salon.yclients_company_id}/sale/${documentId}/payment/${kind}/${transactionId}`,headers:ycHeaders(authSalon),timeout:30000});
 if(!response.data?.success||!Array.isArray(response.data.data?.state?.payment_transactions)||!Array.isArray(response.data.data?.state?.loyalty_transactions))throw new Error('payment_removal_unconfirmed');
 return response.data.data;
}
async function markArrived(salon, record) {
  // Short PUT {attendance} is rejected by YClients (422: staff_id, services,
  // client required). The full record is sent back exactly as read, like the
  // journal «Подтвердить» action; the caller verifies nothing else changed.
  return write(salon, Number(record.id), {
    staff_id: record.staff_id, services: record.services, client: record.client,
    datetime: record.datetime, seance_length: record.seance_length,
    comment: record.comment || '', attendance: 1, save_if_busy: false, send_sms: false,
  });
}
// DELETE /record. A 404/409 answer is «already deleted» (a repeated package
// must not fail on it) ONLY if a re-read confirms it: deleted:true or a real
// 404. A 409 for a live record (e.g. locked) is a refusal, never a false done.
async function remove(salon, id) {
  const authSalon = config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN } : salon;
  let response;
  try {
    response = await axios({ method: 'delete', url: `${config.YC}/record/${salon.yclients_company_id}/${id}`,
      headers: ycHeaders(authSalon), timeout: 30000 });
  } catch (e) {
    const status = e?.response?.status;
    if (status !== 404 && status !== 409) throw e;
    let rec;
    try { rec = await getRecord(salon, id); }
    catch (re) { if (Number(re?.status) === 404) return { recordId: id, alreadyDeleted: true }; throw re; }
    if (rec?.deleted) return { recordId: id, alreadyDeleted: true };
    fail('YClients не удалил запись. Проверьте её в YClients.', 409, 'delete_refused');
  }
  if (response?.data && typeof response.data === 'object' && response.data.success === false) throw new Error('upstream_delete_failed');
  return { recordId: id };
}
module.exports = { list, records, getRecord, write, remove, getSale, pay, removePayment, markArrived };
