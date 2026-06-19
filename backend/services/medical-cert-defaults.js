// backend/services/medical-cert-defaults.js
'use strict';

const { splitFullName } = require('./medical-cert-layout');
const { sumServicePaymentsForYear } = require('./cert-amount');

// clinic: объект констант клиники (из настроек/конфига).
// db инжектируется (по умолчанию реальный) — упрощает тестирование.
async function buildDefaults({ db, clinic, salonId, clientId, year }) {
  const dbi = db || require('../db').db;
  const client = clientId
    ? await dbi.oneOrNone('SELECT name FROM clients WHERE id=$1 AND salon_id=$2', [clientId, salonId])
    : null;
  const fio = splitFullName(client ? client.name : '');
  const signer = splitFullName(clinic.signer_name || '');
  const amount = clientId ? await sumServicePaymentsForYear({ db: dbi, salonId, clientId, year }) : 0;

  return {
    report_year: String(year),
    org_name: clinic.org_name || '',
    org_inn: clinic.org_inn || '',
    org_kpp: clinic.org_kpp || '',
    payer_last: fio.last, payer_first: fio.first, payer_middle: fio.middle,
    signer_last: signer.last, signer_first: signer.first, signer_middle: signer.middle,
    amount_total: amount,
  };
}

module.exports = { buildDefaults };
