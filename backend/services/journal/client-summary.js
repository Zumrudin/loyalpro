'use strict';
// Client panel of the journal card (spec 2026-11-12 §4.4). Local data only,
// except abonements (live YClients, cached 60 s per salon+phone; a failure is
// null and is not cached). The router lets only owner/admin read it.
const { db } = require('../../db');
const config = require('../../config');
const m = require('./model');
const { ycGetClientAbonements } = require('../yclients');

const TTL_MS = 60000;
const CACHE_MAX = 500;
const cache = new Map();

function canonPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}
const countOf = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
// Visits left: united balance → united_balance_services_count, else sum of links (as get-client-abonements).
function abonementsView(list) {
  return (Array.isArray(list) ? list : []).map(a => {
    const links = Array.isArray(a?.balance_container?.links) ? a.balance_container.links : [];
    const balance = a?.is_united_balance_unlimited ? 'безлимит'
      : a?.is_united_balance ? Number(a.united_balance_services_count) || 0
      : links.reduce((s, l) => s + (Number(l.count) || 0), 0);
    return { title: String(a?.type?.title || a?.balance_string || 'Абонемент'), balance, expires: a?.expiration_date || null };
  });
}
async function abonements(salon, phone, now = Date.now()) {
  const key = salon.id + ':' + phone;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = null;
  try { value = abonementsView(await ycGetClientAbonements(salon, phone)); } catch (_) { value = null; }
  if (value !== null) {
    cache.set(key, { at: now, value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return value;
}
const WHO = `(($2::bigint IS NOT NULL AND yclients_client_id=$2)
  OR ($3::text IS NOT NULL AND right(regexp_replace(COALESCE(%PHONE%,''),'\\D','','g'),10)=right($3,10)))`;
const CLIENT_SQL = `SELECT id, name, phone, yclients_client_id, bonus_balance, yclients_card_balance, loyalty_level, total_spent
  FROM clients WHERE salon_id=$1 AND ${WHO.replace('%PHONE%', 'phone')}
  ORDER BY (yclients_client_id IS NOT DISTINCT FROM $2) DESC, id LIMIT 1`;
const RECORD_WHO = WHO.replace('%PHONE%', "raw_payload->'client'->>'phone'");
const VISITS_SQL = `SELECT visit_datetime, raw_payload FROM records WHERE salon_id=$1 AND ${RECORD_WHO}
  AND COALESCE(status,'')<>'deleted' AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1') AND visit_datetime <= NOW()
  ORDER BY visit_datetime DESC LIMIT 10`;
const COUNTS_SQL = `SELECT count(*) FILTER (WHERE raw_payload->>'attendance'='1')::int AS success,
  count(*) FILTER (WHERE raw_payload->>'attendance'='-1')::int AS fail
  FROM records WHERE salon_id=$1 AND ${RECORD_WHO} AND COALESCE(status,'')<>'deleted'`;

async function summary(salonId, query = {}) {
  const phone = query.phone != null && query.phone !== '' ? canonPhone(query.phone) : null;
  if (query.phone != null && query.phone !== '' && !phone) m.fail('Некорректный телефон.');
  const ycClientId = query.ycClientId != null && query.ycClientId !== '' ? m.positiveId(query.ycClientId) : null;
  if (!phone && !ycClientId) m.fail('Укажите телефон или клиента.');
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon) m.fail('Салон не найден.', 404);
  const client = await db.oneOrNone(CLIENT_SQL, [salonId, ycClientId, phone]);
  const yc = ycClientId || (client?.yclients_client_id != null ? Number(client.yclients_client_id) : null);
  const ph = phone || canonPhone(client?.phone);
  const rows = await db.any(VISITS_SQL, [salonId, yc, ph]);
  const last = rows[0]?.raw_payload?.client || {};
  let visits = { success: countOf(last.success_visits_count), fail: countOf(last.fail_visits_count) };
  if (visits.success === null || visits.fail === null) {
    const c = await db.oneOrNone(COUNTS_SQL, [salonId, yc, ph]);
    visits = { success: visits.success ?? (Number(c?.success) || 0), fail: visits.fail ?? (Number(c?.fail) || 0) };
  }
  const ledger = config.BONUS_LEDGER_PRIMARY === true;
  const bonusBalance = !client ? null : ledger ? Number(client.bonus_balance) || 0
    : client.yclients_card_balance != null ? Number(client.yclients_card_balance) : Number(client.bonus_balance) || 0;
  return {
    name: client?.name || rows[0]?.raw_payload?.client?.name || null,
    phone: ph,
    visits, bonusBalance,
    loyaltyLevel: client?.loyalty_level || null,
    totalSpent: client ? Number(client.total_spent) || 0 : null,
    lastVisits: rows.map(v => {
      const p = v.raw_payload || {};
      const at = m.moscowParts(p.datetime || (v.visit_datetime instanceof Date ? v.visit_datetime.toISOString() : v.visit_datetime));
      return { date: at?.date || null, staffName: String(p.staff?.name || ''),
        services: (Array.isArray(p.services) ? p.services : []).map(s => String(s?.title || '')).filter(Boolean),
        attendance: Number(p.attendance) || 0 };
    }),
    abonements: ph && salon.yclients_company_id ? await abonements(salon, ph) : null,
    bonusesSource: ledger ? 'ledger' : 'card',
  };
}
module.exports = { summary, canonPhone, abonementsView, _cache: cache, CLIENT_SQL, VISITS_SQL, COUNTS_SQL };
