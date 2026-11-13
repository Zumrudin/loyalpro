'use strict';
// Client panel of the journal card (spec 2026-11-12 §4.4). Local data only,
// except abonements (live YClients, cached 60 s per salon+phone; a failure is
// null and is not cached). The router lets only owner/admin read it.
const { db } = require('../../db');
const bonusLedger = require('../bonus-ledger');
const m = require('./model');
const { ycGetClientAbonements } = require('../yclients');

const TTL_MS = 60000;
const CACHE_MAX = 500;
const cache = new Map();

function canonPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^\d{10,15}$/.test(d) ? d : null;
}
const countOf = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
// Same filter as the agent tool get-client-abonements: no expired, no used-up;
// frozen ones stay and are marked.
function abonementsView(list, nowMs = Date.now()) {
  return (Array.isArray(list) ? list : []).map(a => {
    const links = Array.isArray(a?.balance_container?.links) ? a.balance_container.links : [];
    const unlimited = !!a?.is_united_balance_unlimited;
    const balance = unlimited ? 'безлимит'
      : a?.is_united_balance ? Number(a.united_balance_services_count) || 0
      : links.reduce((s, l) => s + (Number(l.count) || 0), 0);
    return { title: String(a?.type?.title || a?.balance_string || 'Абонемент'), balance, expires: a?.expiration_date || null,
      status: (a?.status && (a.status.extended_title || a.status.title)) || null, frozen: !!a?.is_frozen };
  }).filter(x => x.balance === 'безлимит' || x.balance > 0)
    .filter(x => { const t = Date.parse(x.expires || ''); return !x.expires || !Number.isFinite(t) || t >= nowMs; });
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
const CLIENT_COLS = `id, name, phone, yclients_client_id, bonus_balance, yclients_card_balance, loyalty_level, total_spent,
  EXISTS (SELECT 1 FROM finance_operations o WHERE o.salon_id=clients.salon_id AND o.client_id=clients.id AND o.kind='bonus_opening') AS ledger_open`;
const CLIENT_ORDER = `ORDER BY ($2::bigint IS NOT NULL AND yclients_client_id=$2) DESC, (yclients_card_balance IS NOT NULL) DESC,
  (yclients_client_id IS NOT NULL) DESC, id LIMIT 1`;
// Exact phone forms ($3 = text[]) hit idx_clients_salon_phone; the suffix match is the fallback only.
const CLIENT_SQL = `SELECT ${CLIENT_COLS} FROM clients WHERE salon_id=$1
  AND (($2::bigint IS NOT NULL AND yclients_client_id=$2) OR phone = ANY($3::text[])) ${CLIENT_ORDER}`;
const CLIENT_SUFFIX_SQL = `SELECT ${CLIENT_COLS} FROM clients WHERE salon_id=$1
  AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=right($3,10) ${CLIENT_ORDER}`;
// With a YClients client id only the indexed id is used; phone (raw_payload) is for unknown ids, last 2 years.
const ALIVE = `COALESCE(status,'')<>'deleted' AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1')`;
const PHONE_WHO = `right(regexp_replace(COALESCE(raw_payload->'client'->>'phone',''),'\\D','','g'),10)=right($2,10)
  AND visit_date >= CURRENT_DATE - 730`;
const VISITS_BY_ID_SQL = `SELECT visit_datetime, raw_payload FROM records WHERE salon_id=$1 AND yclients_client_id=$2
  AND ${ALIVE} AND visit_datetime <= NOW() ORDER BY visit_datetime DESC LIMIT 10`;
const VISITS_BY_PHONE_SQL = `SELECT visit_datetime, raw_payload FROM records WHERE salon_id=$1 AND ${PHONE_WHO}
  AND ${ALIVE} AND visit_datetime <= NOW() ORDER BY visit_datetime DESC LIMIT 10`;
// Counters ride on the client object of the most recently CHANGED record.
const FRESH_CLIENT_SQL = `SELECT raw_payload->'client' AS client FROM records WHERE salon_id=$1 AND yclients_client_id=$2
  ORDER BY raw_payload->>'last_change_date' DESC NULLS LAST LIMIT 1`;
const COUNTS_COLS = `count(*) FILTER (WHERE raw_payload->>'attendance'='1')::int AS success,
  count(*) FILTER (WHERE raw_payload->>'attendance'='-1')::int AS fail`;
const COUNTS_BY_ID_SQL = `SELECT ${COUNTS_COLS} FROM records WHERE salon_id=$1 AND yclients_client_id=$2 AND COALESCE(status,'')<>'deleted'`;
const COUNTS_BY_PHONE_SQL = `SELECT ${COUNTS_COLS} FROM records WHERE salon_id=$1 AND ${PHONE_WHO} AND COALESCE(status,'')<>'deleted'`;

async function summary(salonId, query = {}) {
  const phone = query.phone != null && query.phone !== '' ? canonPhone(query.phone) : null;
  if (query.phone != null && query.phone !== '' && !phone) m.fail('Некорректный телефон.');
  const ycClientId = query.ycClientId != null && query.ycClientId !== '' ? m.positiveId(query.ycClientId) : null;
  if (!phone && !ycClientId) m.fail('Укажите телефон или клиента.');
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon) m.fail('Салон не найден.', 404);
  const forms = phone ? [phone, '+' + phone, '8' + phone.slice(1)] : [];
  let client = await db.oneOrNone(CLIENT_SQL, [salonId, ycClientId, forms]);
  if (!client && phone) client = await db.oneOrNone(CLIENT_SUFFIX_SQL, [salonId, ycClientId, phone]);
  const yc = ycClientId || (client?.yclients_client_id != null ? Number(client.yclients_client_id) : null);
  const ph = phone || canonPhone(client?.phone);
  const rows = yc ? await db.any(VISITS_BY_ID_SQL, [salonId, yc])
    : ph ? await db.any(VISITS_BY_PHONE_SQL, [salonId, ph]) : [];
  const fresh = yc ? (await db.oneOrNone(FRESH_CLIENT_SQL, [salonId, yc]))?.client : rows[0]?.raw_payload?.client;
  let visits = { success: countOf(fresh?.success_visits_count), fail: countOf(fresh?.fail_visits_count) };
  if (visits.success === null || visits.fail === null) {
    const c = yc ? await db.oneOrNone(COUNTS_BY_ID_SQL, [salonId, yc]) : ph ? await db.oneOrNone(COUNTS_BY_PHONE_SQL, [salonId, ph]) : null;
    visits = { success: visits.success ?? (Number(c?.success) || 0), fail: visits.fail ?? (Number(c?.fail) || 0) };
  }
  const ledger = bonusLedger.isPrimary() && !!client?.ledger_open;
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
module.exports = { summary, canonPhone, abonementsView, _cache: cache, CLIENT_SQL, CLIENT_SUFFIX_SQL, VISITS_BY_ID_SQL, VISITS_BY_PHONE_SQL, FRESH_CLIENT_SQL, COUNTS_BY_ID_SQL, COUNTS_BY_PHONE_SQL };
